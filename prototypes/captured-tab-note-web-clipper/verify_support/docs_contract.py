from __future__ import annotations

import json
import re
import sys
from pathlib import Path


TICK = chr(96)
FENCE = TICK * 3
EXPECTED_DRIVER = (
    ('filename', 'SUPPORTED'), ('YAML/frontmatter safety', 'UNSUPPORTED'),
    ('selection provenance', 'UNSUPPORTED'), ('metadata-only extraction artifact', 'UNSUPPORTED'),
    ('template/content compiler', 'SUPPORTED'), ('URL persistence policy', 'UNSUPPORTED'),
    ('missing word count', 'UNSUPPORTED'), ('deterministic hash shape', 'TARGET CONTRACT'),
    ('import/activation mechanics', 'SUPPORTED'), ('Captured Tab Note conformance', 'UNSUPPORTED'),
)
EXPECTED_PROPERTIES = (
    ('mdplace_prototype_kind', 'captured_tab_note_web_clipper_feasibility', 'text'), ('mdplace_capture_conformance', 'nonconforming', 'text'),
    ('mdplace_placement_allowed', 'false', 'checkbox'), ('source_adapter', 'obsidian_web_clipper', 'text'),
    ('source_adapter_version', '1.7.0', 'text'), ('source_captured_at', '{{date}}', 'datetime'),
)
EXPECTED_BODY = (
    '> [!warning] NONCONFORMING DIAGNOSTIC\n'
    '> This is not a Captured Tab Note and must not be ingested.\n'
    '> No page-derived content or metadata field values are persisted; only presence '
    'observations and adapter-generated time are retained.\n'
    '> This diagnostic is not placement-authoritative.\n'
    '>\n'
    '> Availability observations only:\n'
    '\n'
    '- readable_content: {% if content %}present{% else %}absent{% endif %}\n'
    '- live_selection: {% if selection %}present{% else %}absent{% endif %}\n'
    '- highlights: {% if highlights %}present{% else %}absent{% endif %}\n'
)
EXPECTED_COMMANDS = (
    'jq empty prototypes/captured-tab-note-web-clipper/mdplace-captured-tab-note-clipper.json',
    "printf 'fshicpmbaeq' | bash prototypes/captured-tab-note-web-clipper/prototype.sh",
    'bash prototypes/captured-tab-note-web-clipper/verify.sh docs', 'bash prototypes/captured-tab-note-web-clipper/verify.sh shell',
    'bash prototypes/captured-tab-note-web-clipper/verify.sh hash',
    'WEB_CLIPPER_DIR=/path/to/detached/pinned/checkout bash prototypes/captured-tab-note-web-clipper/verify.sh template',
)
EXPECTED_EVIDENCE = ('task-2-template-green.txt', 'task-3-shell-green.txt', 'task-4-contract-consistency.txt', 'task-5-hash-vectors.txt')
SOURCE_SCOPES = {
    'filename': ('src/utils/filters.ts#L73-L186', 'src/utils/filters/safe_name.ts#L56-L64'),
    'YAML/frontmatter safety': ('src/utils/shared.ts#L145-L205', 'src/utils/string-utils.ts#L9-L18'),
    'selection provenance': ('src/utils/highlighter.ts#L558-L602', 'src/utils/highlighter.ts#L1113-L1139'),
    'metadata-only extraction artifact': ('src/utils/content-extractor.ts#L67-L123', 'src/core/popup.ts#L678-L740'),
    'URL persistence policy': ('src/utils/shared.ts#L40-L66',),
    'import/activation mechanics': ('src/utils/import-export.ts#L69-L170',),
    'Pinned CLI HTML extraction': ('src/api.ts#L176-L220',),
}
CONTEXT_RULES = {
    'Captured Tab Note': (r'\buntrusted\b', r'instructions?.{0,40}\bno authority\b'),
    'Capture Adapter': (r'\bingestion contract\b', r'\bwithout making semantic placement decisions\b', r'\bStock Obsidian Web Clipper 1\.7\.0\b', r'\bnot supported\b', r'\b(?:additional adapter|upstream change)\b'),
    'Folder Projection': (r'\baccepted placement\b', r'\bnot semantic truth\b'),
    'Inbox': (r'\bworkflow state\b', r'\brather than semantic meaning\b'),
    'Processing Policy': (r'\bsource URLs\b', r'\bcredentials\b', r'\bfragments\b', r'\bquery parameters\b', r'\bsession identifiers\b', r'\bPII\b', r'\bRemote transmission is forbidden unless\b'),
    'Intelligence Adapter': (r'\buntrusted data\b', r'\bseparate explicit authorization\b'),
}
failures: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def unique_section(markdown: str, heading: str) -> str:
    matches = list(re.finditer(rf'^## {re.escape(heading)}[ \t]*$', markdown, re.MULTILINE))
    require(len(matches) == 1, f'README must contain exactly one {heading!r} section')
    if not matches:
        return ''
    start = matches[0].end() + 1
    following = re.search(r'^## ', markdown[start:], re.MULTILINE)
    return markdown[start:start + following.start()] if following else markdown[start:]


def parse_table(markdown: str, headers: tuple[str, ...]) -> list[list[str]]:
    header = '| ' + ' | '.join(headers) + ' |'
    lines = markdown.splitlines()
    indexes = [index for index, line in enumerate(lines) if line == header]
    require(len(indexes) == 1, f'expected one table with headers {headers!r}')
    if not indexes:
        return []
    rows: list[list[str]] = []
    for line in lines[indexes[0] + 2:]:
        if not line.startswith('|'):
            break
        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        require(len(cells) == len(headers), f'malformed table row: {line}')
        if len(cells) == len(headers):
            rows.append(cells)
    return rows


def markdown_links(cell: str) -> set[str]:
    return set(re.findall(r'\[[^]]+\]\(([^)]+)\)', cell))


def inline_values(markdown: str) -> list[str]:
    return re.findall(rf'{re.escape(TICK)}([^{re.escape(TICK)}]+){re.escape(TICK)}', markdown)


def shell_commands(markdown: str) -> tuple[str, ...]:
    blocks = re.findall(
        rf'{re.escape(FENCE)}sh\n(.*?)\n{re.escape(FENCE)}',
        markdown,
        re.DOTALL,
    )
    require(len(blocks) == 2, 'activation boundary must contain exactly two shell command blocks')
    commands: list[str] = []
    for block in blocks:
        joined = re.sub(r'[ \t]*\\\n[ \t]*', ' ', block)
        commands.extend(line.strip() for line in joined.splitlines() if line.strip())
    return tuple(commands)


def glossary_entries(context: str) -> dict[str, str]:
    pairs = re.findall(r'^\*\*([^*]+)\*\*:\n(.*?)\n_Avoid_:', context, re.MULTILINE | re.DOTALL)
    entries: dict[str, str] = {}
    for name, definition in pairs:
        require(name not in entries, f'duplicate CONTEXT glossary entry: {name}')
        entries[name] = ' '.join(definition.split())
    return entries


def mutate_readme(source_path: Path, target_path: Path) -> None:
    text = source_path.read_text(encoding='utf-8')
    lines = text.splitlines(keepends=True)
    verdict_indexes = [
        index for index, line in enumerate(lines)
        if line.startswith('| Captured Tab Note conformance |') and ' | UNSUPPORTED | ' in line
    ]
    verdict_mutations = len(verdict_indexes)
    if verdict_indexes:
        index = verdict_indexes[0]
        lines[index] = lines[index].replace(' | UNSUPPORTED | ', ' | SUPPORTED | ', 1)
    text = ''.join(lines)
    path_mutations = text.count(f'{TICK}mdplace-prototype-diagnostics{TICK}')
    text = text.replace(f'{TICK}mdplace-prototype-diagnostics{TICK}', f'{TICK}Inbox{TICK}', 1)
    if verdict_mutations != 1 or path_mutations < 1:
        raise SystemExit(
            f'mutation precondition failed: verdict_mutations={verdict_mutations}, '
            f'path_candidates={path_mutations}'
        )
    target_path.write_text(text, encoding='utf-8')
    print(f'VERDICT_MUTATIONS: {verdict_mutations}')
    print('PATH_MUTATIONS: 1')


def check_contract(paths: tuple[Path, Path, Path, Path], upstream_sha: str) -> None:
    readme_path, context_path, template_path, driver_output_path = paths
    readme = readme_path.read_text(encoding='utf-8')
    context = context_path.read_text(encoding='utf-8')
    template = json.loads(template_path.read_text(encoding='utf-8'))
    driver = re.sub(
        r'\x1b\[[0-9;?]*[A-Za-z]',
        '',
        driver_output_path.read_text(encoding='utf-8'),
    )
    intro = readme[:readme.find('\n## ') if '\n## ' in readme else len(readme)]
    matrix_section = unique_section(readme, 'Requirement matrix')
    artifact_section = unique_section(readme, 'Current diagnostic artifact')
    activation_section = unique_section(readme, 'Activation boundary')
    evidence_section = unique_section(readme, 'Evidence')

    require('NOT A SUPPORTED CAPTURE ADAPTER' in intro[:500], 'README does not lead with the unsupported verdict')
    require(upstream_sha in intro, 'README lead does not pin the exact upstream SHA')
    require(f'{TICK}NONCONFORMING{TICK}' in intro, 'README lead does not classify the JSON as nonconforming')

    page_input = re.compile(
        r'{{\s*(?:title|domain|url|content|selection|highlights|author|site|description|image|words|published)\b'
    )
    require(template.get('schemaVersion') == '0.1.0', 'live JSON schemaVersion is not 0.1.0')
    require(template.get('name') == 'NONCONFORMING-mdplace Web Clipper diagnostic', 'live JSON diagnostic name drifted')
    require(template.get('behavior') == 'create', 'live JSON behavior is not create')
    require(template.get('path') == 'mdplace-prototype-diagnostics', 'live JSON diagnostic path drifted')
    require(template.get('noteNameFormat') == 'NONCONFORMING-{{date|date:"YYYYMMDD-HHmmss"}}', 'live JSON filename expression drifted')
    require(page_input.search(template.get('noteNameFormat', '')) is None, 'live JSON filename consumes a page-derived input')
    properties = template.get('properties', [])
    property_values = tuple((prop.get('name'), prop.get('value'), prop.get('type')) for prop in properties if isinstance(prop, dict))
    require(len(property_values) == len(properties), 'live JSON property entry is not an object')
    require(property_values == EXPECTED_PROPERTIES, 'live JSON six-property allowlist drifted')
    body = template.get('noteContentFormat', '')
    require(body == EXPECTED_BODY, 'live JSON static/presence-only body drifted')
    require(template.get('triggers') == [], 'live JSON triggers are not empty')
    require(page_input.search(body) is None, 'live JSON body retains a page-derived interpolation')
    require(not any(f'mdplace:{name}:start' in body for name in ('article', 'selection', 'highlights')), 'live JSON body contains a canonical stream marker')

    headings = re.findall(r'^Case: (.+)$', driver, re.MULTILINE)
    outcomes = re.findall(r'^Outcome: (.+)$', driver, re.MULTILINE)
    require(tuple(zip(headings, outcomes)) == EXPECTED_DRIVER, 'live driver matrix sequence drifted')
    require(len(headings) == len(set(headings)) == 10, 'live driver headings are not ten unique cases')

    matrix_rows = parse_table(matrix_section, ('Requirement', 'Pinned observation', 'Verdict', 'Owner path'))
    matrix: dict[str, tuple[str, str, str]] = {}
    for requirement, observation, verdict, owner in matrix_rows:
        require(requirement not in matrix, f'duplicate matrix requirement: {requirement}')
        matrix[requirement] = (observation, verdict.strip(f' *{TICK}'), owner)
    for requirement, expected_verdict in EXPECTED_DRIVER:
        require(requirement in matrix, f'README matrix lacks live driver requirement: {requirement}')
        if requirement in matrix:
            observation, verdict, owner = matrix[requirement]
            require(verdict == expected_verdict, f'README verdict mismatch for {requirement}: {verdict}')
            require(bool(observation), f'README observation is empty for {requirement}')
            require(bool(markdown_links(owner)), f'README owner path is not linked for {requirement}')
    require(matrix.get('Pinned CLI HTML extraction', ('', '', ''))[1] == 'UNSUPPORTED', 'pinned CLI HTMLElement defect is not UNSUPPORTED')
    for requirement, scopes in SOURCE_SCOPES.items():
        owner_links = markdown_links(matrix.get(requirement, ('', '', ''))[2])
        for scope in scopes:
            permalink = f'https://github.com/obsidianmd/obsidian-clipper/blob/{upstream_sha}/{scope}'
            require(permalink in owner_links, f'README lacks pinned owner scope for {requirement}: {scope}')

    coordinates = dict(re.findall(
        rf'^- ([^:\n]+):[ \t]*(?:\n[ \t]+)?{re.escape(TICK)}([^{re.escape(TICK)}\n]+){re.escape(TICK)}',
        artifact_section, re.MULTILINE,
    ))
    expected_coordinates = {
        'Name': template.get('name'),
        'Destination': template.get('path'),
        'Behavior': template.get('behavior'),
        'Filename expression': template.get('noteNameFormat'),
    }
    require(coordinates == expected_coordinates, 'README diagnostic coordinates do not match the live JSON')
    property_rows = parse_table(artifact_section, ('Property', 'Value', 'Type'))
    documented_properties = tuple(tuple(cell.strip(f' {TICK}') for cell in row) for row in property_rows)
    require(documented_properties == EXPECTED_PROPERTIES, 'README diagnostic property table drifted')
    artifact_tokens = set(inline_values(artifact_section))
    require({'content', 'selection', 'highlights', 'present', 'absent'} <= artifact_tokens, 'README diagnostic availability structure is incomplete')
    require({f'mdplace:{name}' for name in ('article', 'selection', 'highlights')} <= artifact_tokens, 'README canonical-marker absence boundary is incomplete')

    require(shell_commands(activation_section) == EXPECTED_COMMANDS, 'README documented command surface drifted')
    normalized_activation = ' '.join(activation_section.split())
    require(re.search(rf'\b(?:do not|never)\b.{{0,160}}{re.escape(TICK)}Inbox{re.escape(TICK)}', normalized_activation, re.IGNORECASE) is not None, 'README activation boundary does not explicitly prohibit Inbox delivery')
    require(readme.count(f'{TICK}Inbox{TICK}') == 1, 'README Inbox token must occur only in the activation prohibition')

    evidence_paths = [value.rsplit('/', 1)[-1] for value in inline_values(evidence_section) if value.startswith('.omo/evidence/')]
    require(tuple(evidence_paths) == EXPECTED_EVIDENCE, 'README evidence filename contract drifted')

    glossary = glossary_entries(context)
    for term, patterns in CONTEXT_RULES.items():
        definition = glossary.get(term, '')
        require(bool(definition), f'CONTEXT glossary entry is absent: {term}')
        for pattern in patterns:
            require(re.search(pattern, definition, re.IGNORECASE) is not None, f'CONTEXT semantic relationship drifted: {term}')
    context_candidate = all(re.search(pattern, glossary.get('Capture Adapter', ''), re.IGNORECASE) is not None for pattern in CONTEXT_RULES['Capture Adapter'])
    false_retention = re.compile(r'\bretains?\s+no\s+page-derived\s+(?:values?|title)\b', re.IGNORECASE)
    require(false_retention.search(readme + '\n' + driver + '\n' + body) is None, 'README, JSON, or driver makes a false zero-retention claim')
    require(re.search(r'stock Obsidian Web Clipper 1\.7\.0 is supported', readme, re.IGNORECASE) is None, 'README calls stock 1.7.0 supported')
    require(re.search(r'(?:JSON|diagnostic|template) is (?:a )?(?:supported|conforming) Capture Adapter', readme, re.IGNORECASE) is None, 'README calls the JSON diagnostic a supported or conforming Capture Adapter')

    print(f'CHECK_TARGET: {readme_path}')
    print(f'OBSERVED_JSON_PATH: {template.get("path")}')
    print('OBSERVED_JSON_PROPERTIES: ' + '|'.join(prop[0] for prop in EXPECTED_PROPERTIES))
    print('OBSERVED_DRIVER_MATRIX: ' + '|'.join(f'{name}={verdict}' for name, verdict in zip(headings, outcomes)))
    print(f'OBSERVED_CONTEXT_CANDIDATE: {context_candidate}')
    if failures:
        for failure in failures:
            print(f'CONTRACT_FAIL: {failure}')
        print(f'CONTRACT_FAILURE_COUNT: {len(failures)}')
        raise SystemExit(1)
    print('CONTRACT_FAILURE_COUNT: 0')
    print('CONTRACT_VERDICT: PASS')


def main() -> None:
    arguments = sys.argv[1:]
    if len(arguments) == 6 and arguments[0] == 'check':
        check_contract(tuple(Path(value) for value in arguments[1:5]), arguments[5])
        return
    if len(arguments) == 3 and arguments[0] == 'mutate-readme':
        mutate_readme(Path(arguments[1]), Path(arguments[2]))
        return
    raise SystemExit(64)


if __name__ == '__main__':
    main()
