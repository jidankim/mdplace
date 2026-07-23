from __future__ import annotations

import copy
import hashlib
import json
import re
import sys
import unicodedata
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlsplit


JsonValue = str | int | float | bool | None | list['JsonValue'] | dict[str, 'JsonValue']


class ContractError(ValueError):
    """Hash contract violation."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def section(markdown: str, heading: str, next_heading: str | None) -> str:
    start_marker = f'### {heading}\n'
    start = markdown.find(start_marker)
    require(start >= 0, f'missing README section: {heading}')
    start += len(start_marker)
    if next_heading is None:
        return markdown[start:]
    end_marker = f'### {next_heading}\n'
    end = markdown.find(end_marker, start)
    require(end >= 0, f'missing README section boundary: {next_heading}')
    return markdown[start:end]


def single_fence(markdown: str, language: str) -> str:
    fence = re.escape(chr(96) * 3)
    blocks = re.findall(rf'{fence}{re.escape(language)}\n(.*?)\n{fence}', markdown, re.DOTALL)
    require(len(blocks) == 1, f'expected one {language} fence, found {len(blocks)}')
    return blocks[0]


def jcs_bytes(value: JsonValue) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'), sort_keys=True).encode()


RFC3339, LOWER_HASH = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$'), re.compile(r'^sha256:[0-9a-f]{64}$')
STREAM_ORDER = ('article', 'selection', 'highlights')
MARKERS = {name: (f'<!-- mdplace:{name}:start -->', f'<!-- mdplace:{name}:end -->') for name in STREAM_ORDER}
EXPECTED_MARKER_BLOCK = '\n'.join(marker for name in STREAM_ORDER for marker in MARKERS[name])
EXPECTED_METADATA_TYPE = (
    '{"adapter":{"id":string,"version":string},"captured_at":RFC3339-string,"schema":'
    '"mdplace.capture-source-metadata/v1","source":{"author":string|null,"canonical_url":'
    'sanitized-string|null,"description":string|null,"image_url":sanitized-string|null,"published_at":'
    'RFC3339-string|null,"site":string|null,"title":string|null,"word_count":nonnegative-integer|null}}'
)
EXPECTED_MANIFEST_TYPE = '{"schema":"mdplace.capture-stream-manifest/v1","streams":[{"hash":"sha256:<lowercase-hex>","name":"article|selection|highlights"}]}'
EXPECTED_METADATA_HASH = 'sha256:13932d5ded70ed0a97dab4dc24043bbfc42b6dc95a60db846bdb153c5da02bb2'
EXPECTED_MANIFEST_HASH = 'sha256:90dd96398830cd225452be04490e7d3b241e8b8a947ca8c590f8803871e5246c'
EXPECTED_NORMALIZED = 'Café\n  line 2 \t'.encode()
EXPECTED_NORMALIZED_HEX = '436166c3a90a20206c696e6520322009'


def validate_metadata(value: JsonValue, *, word_count_observed: bool) -> None:
    require(isinstance(value, dict), 'metadata must be an object')
    require(set(value) == {'adapter', 'captured_at', 'schema', 'source'}, 'metadata top-level members differ')
    require(value['schema'] == 'mdplace.capture-source-metadata/v1', 'metadata schema literal differs')
    adapter = value['adapter']
    require(isinstance(adapter, dict) and set(adapter) == {'id', 'version'}, 'adapter shape differs')
    require(all(isinstance(adapter[key], str) for key in ('id', 'version')), 'adapter id/version must be strings')
    captured_at = value['captured_at']
    require(isinstance(captured_at, str) and RFC3339.fullmatch(captured_at) is not None, 'captured_at must be an RFC3339 string')
    source = value['source']
    members = {'author', 'canonical_url', 'description', 'image_url', 'published_at', 'site', 'title', 'word_count'}
    require(isinstance(source, dict) and set(source) == members, 'source members differ')
    for member in ('author', 'description', 'site', 'title'):
        require(source[member] is None or isinstance(source[member], str), f'{member} type differs')
    published_at = source['published_at']
    require(published_at is None or isinstance(published_at, str) and RFC3339.fullmatch(published_at) is not None, 'published_at type differs')
    for member in ('canonical_url', 'image_url'):
        url = source[member]
        require(url is None or isinstance(url, str), f'{member} type differs')
        if url is not None:
            parsed = urlsplit(url)
            require(parsed.scheme in ('http', 'https') and parsed.hostname is not None, f'{member} must be an absolute HTTP(S) URL')
            require(parsed.username is None and parsed.password is None, f'{member} contains credentials')
            require('?' not in url and parsed.query == '', f'{member} contains a query')
            require('#' not in url and parsed.fragment == '', f'{member} contains a fragment')
    word_count = source['word_count']
    require(word_count is None or type(word_count) is int and word_count >= 0, 'word_count must be a nonnegative integer or null')
    require(word_count is not None if word_count_observed else word_count is None, 'observed word_count must be numeric' if word_count_observed else 'unknown word_count must be null')


def validate_manifest(value: JsonValue, expected_present: tuple[str, ...]) -> None:
    require(isinstance(value, dict), 'manifest must be an object')
    require(set(value) == {'schema', 'streams'}, 'manifest top-level members differ')
    require(value['schema'] == 'mdplace.capture-stream-manifest/v1', 'manifest schema literal differs')
    streams = value['streams']
    require(isinstance(streams, list), 'streams must be an array')
    observed: list[str] = []
    for entry in streams:
        require(isinstance(entry, dict) and set(entry) == {'hash', 'name'}, 'stream entry shape differs')
        require(entry['name'] in STREAM_ORDER, 'stream name is outside the closed union')
        require(isinstance(entry['hash'], str) and LOWER_HASH.fullmatch(entry['hash']) is not None, 'stream hash is not lowercase sha256 form')
        observed.append(entry['name'])
    expected = tuple(name for name in STREAM_ORDER if name in expected_present)
    require(tuple(observed) == expected, 'manifest absent-stream set or fixed order differs')


def physical_lines(text: str) -> list[tuple[str, str]]:
    return [(match.group(1), match.group(2)) for match in re.finditer(r'(.*?)(\r\n|\r|\n|\Z)', text, re.DOTALL) if match.group(0)]


def normalized_stream(document_bytes: bytes, name: str) -> bytes | None:
    require(name in MARKERS, f'unknown stream name: {name}')
    try:
        text = document_bytes.decode('utf-8', errors='strict')
    except UnicodeDecodeError as error:
        raise ContractError('capture document is not valid UTF-8') from error
    lines = physical_lines(text)
    start_marker, end_marker = MARKERS[name]
    starts = [index for index, (line, _) in enumerate(lines) if line == start_marker]
    ends = [index for index, (line, _) in enumerate(lines) if line == end_marker]
    if not starts and not ends:
        return None
    require(len(starts) == len(ends) == 1, f'{name} marker count differs from one pair')
    start, end = starts[0], ends[0]
    require(start < end, f'{name} markers are reversed')
    require(lines[start][1] in ('\n', '\r', '\r\n'), f'{name} start boundary newline is absent')
    between = ''.join(line + ending for line, ending in lines[start + 1:end])
    boundary_size = 2 if between.endswith('\r\n') else 1 if between.endswith(('\r', '\n')) else 0
    require(boundary_size > 0, f'{name} end boundary newline is absent')
    payload = between[:-boundary_size]
    normalized = unicodedata.normalize('NFC', payload.replace('\r\n', '\n').replace('\r', '\n'))
    require(normalized != '', f'{name} present stream is empty')
    require(not all(char.isspace() for char in normalized), f'{name} present stream is whitespace-only')
    return normalized.encode()


def expect_rejected(label: str, operation: Callable[[], JsonValue | bytes | None]) -> None:
    try:
        operation()
    except (ContractError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        print(f'NEGATIVE_{label}: REJECTED ({error})')
        return
    raise ContractError(f'negative case {label} was accepted')


def mutate_readme_files(paths: tuple[Path, Path, Path]) -> None:
    source_path, malformed_path, forged_path = paths
    text = source_path.read_text(encoding='utf-8')
    fence = re.escape(chr(96) * 3)
    metadata_match = re.search(rf'({fence}json\n)(\{{"adapter":.*?\}})(\n{fence})', text)
    if metadata_match is None:
        raise SystemExit('metadata vector fixture not found')
    metadata_vector = metadata_match.group(2)
    malformed = text[:metadata_match.start(2)] + metadata_vector[:-1] + text[metadata_match.end(2):]
    expected_digest = EXPECTED_METADATA_HASH.removeprefix('sha256:')
    if text.count(expected_digest) != 1:
        raise SystemExit('documented metadata digest precondition differs')
    forged = text.replace(expected_digest, '0' * 64, 1) + '\nVERDICT: PASS\n'
    malformed_path.write_text(malformed, encoding='utf-8')
    forged_path.write_text(forged, encoding='utf-8')
    print('MALFORMED_VECTOR_MUTATIONS: 1\nFORGED_DIGEST_MUTATIONS: 1\nFORGED_PASS_LINES: 1')


def check_contract(readme_path: Path, output_dir: Path) -> None:
    readme = readme_path.read_text(encoding='utf-8')
    stream = section(readme, 'Canonical stream bytes', 'Source-metadata JCS input')
    metadata = section(readme, 'Source-metadata JCS input', 'Stream-manifest JCS input')
    manifest = section(readme, 'Stream-manifest JCS input', None)
    require(single_fence(stream, 'text') == EXPECTED_MARKER_BLOCK, 'canonical marker block differs')
    metadata_text = re.findall(rf'{re.escape(chr(96) * 3)}text\n(.*?)\n{re.escape(chr(96) * 3)}', metadata, re.DOTALL)
    manifest_text = re.findall(rf'{re.escape(chr(96) * 3)}text\n(.*?)\n{re.escape(chr(96) * 3)}', manifest, re.DOTALL)
    require(metadata_text[0:1] == [EXPECTED_METADATA_TYPE], 'metadata literal type form differs')
    require(manifest_text[0:1] == [EXPECTED_MANIFEST_TYPE], 'manifest literal type form differs')
    metadata_raw, manifest_raw = single_fence(metadata, 'json'), single_fence(manifest, 'json')
    require('\n' not in metadata_raw and '\n' not in manifest_raw, 'canonical JCS vector is line-wrapped')
    metadata_value, manifest_value = json.loads(metadata_raw), json.loads(manifest_raw)
    validate_metadata(metadata_value, word_count_observed=False)
    validate_manifest(manifest_value, ('article', 'highlights'))
    metadata_bytes, manifest_bytes = jcs_bytes(metadata_value), jcs_bytes(manifest_value)
    require(metadata_bytes == metadata_raw.encode(), 'documented metadata bytes are not exact JCS')
    require(manifest_bytes == manifest_raw.encode(), 'documented manifest bytes are not exact JCS')
    metadata_digest = 'sha256:' + hashlib.sha256(metadata_bytes).hexdigest()
    manifest_digest = 'sha256:' + hashlib.sha256(manifest_bytes).hexdigest()
    require(metadata_digest == EXPECTED_METADATA_HASH, 'metadata fixed digest differs')
    require(manifest_digest == EXPECTED_MANIFEST_HASH, 'manifest fixed digest differs')
    metadata_hashes = re.findall(r'^source_metadata_hash = (sha256:[0-9a-f]{64})$', metadata, re.MULTILINE)
    manifest_hashes = re.findall(r'^content_hash = (sha256:[0-9a-f]{64})$', manifest, re.MULTILINE)
    require(metadata_hashes == [metadata_digest], 'documented source_metadata_hash differs from computed bytes')
    require(manifest_hashes == [manifest_digest], 'documented content_hash differs from computed bytes')

    document = ('prefix\r\n' + MARKERS['article'][0] + '\r\nCafe\u0301\r\n  line 2 \t\r\n' + MARKERS['article'][1] + '\r\n' + MARKERS['highlights'][0] + '\r\nSaved highlight  \t\r\n' + MARKERS['highlights'][1] + '\r\n').encode()
    article = normalized_stream(document, 'article')
    highlights = normalized_stream(document, 'highlights')
    require(article == EXPECTED_NORMALIZED, 'CRLF/NFC normalization or whitespace preservation differs')
    require(article.hex() == EXPECTED_NORMALIZED_HEX, 'documented normalized UTF-8 hex differs')
    require(highlights == b'Saved highlight  \t', 'remaining highlight whitespace was trimmed')
    require(normalized_stream(document, 'selection') is None, 'absent selection was treated as present')
    for ending in ('\r\n', '\r', '\n'):
        equivalent = (MARKERS['article'][0] + ending + 'Cafe\u0301' + ending + '  line 2 \t' + ending + MARKERS['article'][1]).encode()
        require(normalized_stream(equivalent, 'article') == EXPECTED_NORMALIZED, f'{ending!r} source line ending did not normalize to LF')
    whitespace = (MARKERS['selection'][0] + '\n \t\n' + MARKERS['selection'][1]).encode()
    reversed_markers = (MARKERS['article'][1] + '\nvalue\n' + MARKERS['article'][0]).encode()
    duplicate = (MARKERS['article'][0] + '\nvalue\n' + MARKERS['article'][1] + '\n' + MARKERS['article'][0] + '\nvalue\n' + MARKERS['article'][1]).encode()
    for label, operation in (
        ('LF_CANONICAL_BYTE_CHANGE', lambda: require(b'Caf\xc3\xa9\r\n  line 2 \t' == article, 'LF candidate bytes are not canonical')),
        ('NFC_CANONICAL_BYTE_CHANGE', lambda: require('Cafe\u0301\n  line 2 \t'.encode() == article, 'NFC candidate bytes are not canonical')),
        ('WHITESPACE_ONLY_PRESENT_STREAM', lambda: normalized_stream(whitespace, 'selection')), ('REVERSED_MARKERS', lambda: normalized_stream(reversed_markers, 'article')),
        ('DUPLICATE_MARKERS', lambda: normalized_stream(duplicate, 'article')), ('MALFORMED_UTF8', lambda: normalized_stream(b'\xff', 'article')),
    ):
        expect_rejected(label, operation)

    reversed_manifest = copy.deepcopy(manifest_value)
    reversed_manifest['streams'].reverse()
    expect_rejected('REVERSED_STREAM_ORDER', lambda: validate_manifest(reversed_manifest, ('article', 'highlights')))
    require(hashlib.sha256(jcs_bytes(reversed_manifest)).hexdigest() != EXPECTED_MANIFEST_HASH.removeprefix('sha256:'), 'reversed stream order unexpectedly retained the fixed digest')
    inserted_selection = copy.deepcopy(manifest_value)
    inserted_selection['streams'].insert(1, {'hash': 'sha256:' + 'c' * 64, 'name': 'selection'})
    expect_rejected('ABSENT_SELECTION_INSERTED', lambda: validate_manifest(inserted_selection, ('article', 'highlights')))

    unsafe = copy.deepcopy(metadata_value)
    unsafe_url = 'https://user:password@example.com/article?token=raw#fragment'
    unsafe['source']['canonical_url'] = unsafe_url
    parts = urlsplit(unsafe_url)
    require(parts.username is not None and bool(parts.query) and bool(parts.fragment), 'unsafe URL fixture lacks credential/query/fragment components')
    expect_rejected('RAW_CREDENTIAL_QUERY_FRAGMENT_URL', lambda: validate_metadata(unsafe, word_count_observed=False))
    for label, url in (
        ('RAW_CREDENTIAL_URL', 'https://user:password@example.test/article'), ('RAW_QUERY_URL', 'https://example.test/article?token=raw'),
        ('RAW_FRAGMENT_URL', 'https://example.test/article#fragment'),
    ):
        candidate = copy.deepcopy(metadata_value)
        candidate['source']['canonical_url'] = url
        expect_rejected(label, lambda value=candidate: validate_metadata(value, word_count_observed=False))
    try:
        validate_metadata(unsafe, word_count_observed=False, **{'urls_sanitized': True})
    except TypeError as error:
        require('urls_sanitized' in str(error), 'caller sanitation override failed for an unrelated reason')
        print(f'NEGATIVE_CALLER_SANITATION_OVERRIDE: REJECTED ({error})')
    else:
        raise ContractError('caller-provided sanitation boolean was accepted')
    sanitized = copy.deepcopy(metadata_value)
    sanitized['source']['canonical_url'], sanitized['source']['image_url'] = 'https://example.test/article', None
    validate_metadata(sanitized, word_count_observed=False)
    print('POSITIVE_SANITIZED_URL_AND_NULL_IMAGE: ACCEPTED')
    zero_unknown = copy.deepcopy(metadata_value)
    zero_unknown['source']['word_count'] = 0
    expect_rejected('ZERO_FOR_UNKNOWN_WORD_COUNT', lambda: validate_metadata(zero_unknown, word_count_observed=False))
    validate_metadata(zero_unknown, word_count_observed=True)
    expect_rejected('MALFORMED_METADATA_JSON', lambda: json.loads(metadata_raw[:-1]))

    mutated = bytearray(metadata_bytes)
    mutated[metadata_bytes.index(b'Example title')] = ord('F')
    mutated_digest = hashlib.sha256(mutated).hexdigest()
    require(mutated_digest != EXPECTED_METADATA_HASH.removeprefix('sha256:'), 'one-byte metadata mutation unexpectedly retained the fixed digest')
    print(f'NEGATIVE_ONE_BYTE_MUTATION: REJECTED (sha256:{mutated_digest})')
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, content in (('source-metadata.jcs', metadata_bytes), ('stream-manifest.jcs', manifest_bytes), ('normalized-article.bin', article)):
        (output_dir / name).write_bytes(content)
    output_lines = (f'METADATA_JCS_BYTES: {metadata_bytes.decode()}', f'METADATA_JCS_HEX: {metadata_bytes.hex()}',
        f'METADATA_JCS_BYTE_COUNT: {len(metadata_bytes)}', f'SOURCE_METADATA_HASH: {metadata_digest}',
        f'MANIFEST_JCS_BYTES: {manifest_bytes.decode()}', f'MANIFEST_JCS_HEX: {manifest_bytes.hex()}',
        f'MANIFEST_JCS_BYTE_COUNT: {len(manifest_bytes)}', f'CONTENT_HASH: {manifest_digest}',
        f'NORMALIZED_ARTICLE_HEX: {article.hex()}', f'NORMALIZED_ARTICLE_BYTE_COUNT: {len(article)}',
        f'NORMALIZED_ARTICLE_HASH: sha256:{hashlib.sha256(article).hexdigest()}', 'PRESENT_STREAM_ORDER: article|highlights',
        'ABSENT_STREAMS: selection', f'PYTHON_UNICODE_VERSION: {unicodedata.unidata_version}', 'ORACLE_VERDICT: PASS',
    )
    print('\n'.join(output_lines))


def main() -> None:
    arguments = sys.argv[1:]
    if len(arguments) == 3 and arguments[0] == 'check':
        check_contract(Path(arguments[1]), Path(arguments[2]))
        return
    if len(arguments) == 4 and arguments[0] == 'mutate-readme':
        mutate_readme_files(tuple(Path(value) for value in arguments[1:]))
        return
    raise SystemExit(64)


if __name__ == '__main__':
    main()
