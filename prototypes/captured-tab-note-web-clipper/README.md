# Stock Web Clipper 1.7.0 feasibility result

> **NOT A SUPPORTED CAPTURE ADAPTER**
>
> Stock Obsidian Web Clipper 1.7.0 at pinned commit
> [`48228dce63195681e9dfc4fb8760c3c36db51079`](https://github.com/obsidianmd/obsidian-clipper/tree/48228dce63195681e9dfc4fb8760c3c36db51079)
> is mdplace's first evaluated Capture Adapter candidate. It does not satisfy
> the Captured Tab Note ingestion contract. The included JSON is a
> `NONCONFORMING` local diagnostic, not a Captured Tab Note producer.

This throwaway prototype records a feasibility result for the stock product.
Its narrow positive results prove only that selected template mechanics work.
Each matching negative result is passing feasibility evidence that a required
capability is absent; it is never product-success evidence.

## Requirement matrix

| Requirement | Pinned observation | Verdict | Owner path |
| --- | --- | --- | --- |
| filename | In a standalone, non-persisting probe, the pinned compiler applies `slice:0,80`, then `safe_name`, and the `Untitled` fallback. `safe_name` provides filename safety, not privacy sanitation. The persisted diagnostic filename is adapter-time-only and does not use page title or domain. The real pinned CLI does not supply a usable HTML-derived title, so this verdict covers stock filename/compiler mechanics only. | SUPPORTED | [filters](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [safe name](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters/safe_name.ts#L56-L64), [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [template](./mdplace-captured-tab-note-clipper.json) |
| Pinned CLI HTML extraction | The CLI/API takes `doc.documentElement`, an `HTMLElement`, casts it as `Document`, and passes it to Defuddle. The pinned executable consequently emits blank HTML-derived variables and `words=0` for the fixtures. This is a CLI test-seam defect, not proof that browser extraction always returns blank data. | UNSUPPORTED | [CLI parser](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/cli.ts#L143-L147), [API extraction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/api.ts#L176-L220), [verifier](./verify.sh) |
| YAML/frontmatter safety | Stock frontmatter generation double-quotes text but its escaping helper escapes only double quotes. The template cannot safely serialize arbitrary page-derived free text or enforce mdplace's ingestion allowlist, so the diagnostic persists no page-derived content or metadata field values. | UNSUPPORTED | [frontmatter generator](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L145-L205), [escaping helper](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/string-utils.ts#L9-L18), [template](./mdplace-captured-tab-note-clipper.json) |
| selection provenance | Promoting a selection creates an ordinary highlight, may merge it with existing highlights, and clears the selection. The exported shape has text, timestamp, and optional notes, but no reliable selection-origin field. | UNSUPPORTED | [selection promotion and merge](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L558-L602), [exported highlight shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L1113-L1139) |
| metadata-only extraction artifact | Stock browser extraction rejects an empty readable-content response. The popup awaits that extraction before it initializes variables or renders template fields, so the template cannot emit the required metadata-only failure artifact. | UNSUPPORTED | [empty-content rejection](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/content-extractor.ts#L67-L123), [browser ordering](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/core/popup.ts#L678-L740) |
| template/content compiler | With controlled variables, the pinned compiler renders the diagnostic's static warning and all positive and negative presence-only branches without rendering supplied content, selection, or highlight values. This compiler capability does not make the resulting file conforming. | SUPPORTED | [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [renderer](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/renderer.ts#L95-L153), [verifier](./verify.sh) |
| URL persistence policy | Stock variables remove a text fragment but still expose the current URL, and the filter registry has no mdplace sanitizer that guarantees removal of credentials, fragments, sensitive query parameters, session identifiers, and PII before persistence. The diagnostic renders no URL. | UNSUPPORTED | [URL variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66), [filter registry](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [Processing Policy](../../CONTEXT.md) |
| missing word count | Variable construction converts a missing `wordCount` to the string `0`. Stock output therefore cannot distinguish unknown metadata from a genuine zero-word observation. | UNSUPPORTED | [variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66), [verifier](./verify.sh) |
| deterministic hash shape | Stock Web Clipper emits no mdplace hashes or canonical stream boundaries. The literal schemas and fixed vectors below define a future-adapter target and are executable through `verify.sh hash`; they do not add runtime hashing to the diagnostic. | TARGET CONTRACT | [RFC 8785/JCS](https://www.rfc-editor.org/rfc/rfc8785), [verifier](./verify.sh) |
| import/activation mechanics | The schema `0.1.0` JSON shape can be imported, and the pinned compiler can render it against local fixtures. Activation proves only those mechanics and supplies none of the missing ingestion guarantees. | SUPPORTED | [export shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/import-export.ts#L23-L67), [import validation](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/import-export.ts#L69-L170), [template](./mdplace-captured-tab-note-clipper.json) |
| Captured Tab Note conformance | Stock 1.7.0 lacks required safe serialization, pre-persistence URL sanitation, metadata-only recovery, selection-origin provenance, unknown-metadata semantics, and runtime hashing. The diagnostic is not a Captured Tab Note. | UNSUPPORTED | [domain contract](../../CONTEXT.md), [template](./mdplace-captured-tab-note-clipper.json), [driver](./prototype.sh), [verifier](./verify.sh) |

The ten rows whose requirement names match the terminal driver are its live
truth matrix. The additional pinned-CLI row separates a limitation of the
local executable test seam from the browser-extension observations.

## Current diagnostic artifact

The importable file is
[`mdplace-captured-tab-note-clipper.json`](./mdplace-captured-tab-note-clipper.json).
Its exact current coordinates and behavior are:

- Name: `NONCONFORMING-mdplace Web Clipper diagnostic`
- Destination: `mdplace-prototype-diagnostics`
- Behavior: `create`
- Filename expression:
  `NONCONFORMING-{{date|date:"YYYYMMDD-HHmmss"}}`

Its complete property allowlist is:

| Property | Value | Type |
| --- | --- | --- |
| `mdplace_prototype_kind` | `captured_tab_note_web_clipper_feasibility` | `text` |
| `mdplace_capture_conformance` | `nonconforming` | `text` |
| `mdplace_placement_allowed` | `false` | `checkbox` |
| `source_adapter` | `obsidian_web_clipper` | `text` |
| `source_adapter_version` | `1.7.0` | `text` |
| `source_captured_at` | `{{date}}` | `datetime` |

The body is a static `NONCONFORMING DIAGNOSTIC` warning plus
presence-only conditionals for `content`, `selection`, and `highlights`. Those
conditionals render only `present` or `absent`. No page-derived content or
metadata field values are persisted in its filename, body, or frontmatter. The
only dynamic data retained are adapter-generated time and the three
`present`/`absent` availability observations. It has no
`mdplace:article`, `mdplace:selection`, or `mdplace:highlights` canonical stream
markers. Its adapter-time-only path and filename have no identity, placement,
or semantic authority.

## Activation boundary

The only permitted activation is local fixture testing with synthetic,
non-sensitive fixtures and disposable local state. Do not send the diagnostic
to `Inbox`, ingest it, process or transmit it remotely, use it on live or
sensitive pages, or treat its output as a Captured Tab Note. If browser import
mechanics are exercised, use a disposable local profile and vault; do not
enable the template for ordinary browsing.

These local commands inspect the artifact without activating a capture flow:

```sh
jq empty prototypes/captured-tab-note-web-clipper/mdplace-captured-tab-note-clipper.json
printf 'fshicpmbaeq' | bash prototypes/captured-tab-note-web-clipper/prototype.sh
bash prototypes/captured-tab-note-web-clipper/verify.sh docs
bash prototypes/captured-tab-note-web-clipper/verify.sh shell
bash prototypes/captured-tab-note-web-clipper/verify.sh hash
```

The pinned-engine fixture test additionally requires a disposable, detached
checkout at the exact pinned SHA with its CLI/API builds:

```sh
WEB_CLIPPER_DIR=/path/to/detached/pinned/checkout \
  bash prototypes/captured-tab-note-web-clipper/verify.sh template
```

That mode uses generated local HTML fixtures and writes rendered evidence to
standard output or an explicitly selected evidence directory; it does not
authorize live-page capture.

## Confirmed limitations

### CLI extraction and controlled filter semantics

At the pinned SHA, the CLI's linkedom parser returns a `Document`, but
`clip()` selects `doc.documentElement` and passes that `HTMLElement` to
Defuddle through a `Document` cast. The real pinned CLI probe consequently
emits blank `title`, `author`, `content`, `description`, `site`, and `image`
variables and emits `words=0`.

The controlled-title test imports the same pinned template compiler and
compiles the standalone, non-persisting expression
`{{title|slice:0,80|safe_name ?? "Untitled"}}` with explicit variables. Its pass
proves only the `slice:0,80`, `safe_name`, and `Untitled` stock template
semantics. It does not read the diagnostic's `noteNameFormat`, erase or work
around the CLI defect, or prove end-to-end title capture.

### Browser failure and provenance boundaries

The stock browser path requires a truthy readable-content response before
template rendering. Empty content therefore fails before the template can
write a metadata-only recovery artifact. A hard extraction failure creates no
diagnostic file through that path.

Promoting a live selection invokes ordinary highlight creation. It may merge
with an existing highlight, clears the selection, and exports no reliable
selection-origin marker. Timestamps do not restore that lost origin.

An unknown word count is converted to `0`, so zero is not reliable evidence
that the page was measured at zero words.

### Persistence safety

The stock template cannot guarantee mandatory source-URL sanitation before
persistence or transmission. Its frontmatter generator also cannot guarantee
safe YAML serialization for arbitrary page-derived free text. The diagnostic
therefore persists no page-derived content or metadata field values in its
filename, body, or frontmatter. It retains only the three availability
observations and adapter-generated time. That containment is not a conforming
implementation.

## Future adapter hashing boundary

Deterministic hashing is a **TARGET CONTRACT** for a future conforming adapter,
not behavior or output of stock Web Clipper 1.7.0 or this diagnostic. The
current JSON emits no hashes and has no canonical stream markers. This section
is the exact interoperability target for an additional conforming adapter; it
does not provide a hashing runtime, sanitizer, serializer, or production
adapter.

### Canonical stream bytes

The only canonical marker lines are:

```text
<!-- mdplace:article:start -->
<!-- mdplace:article:end -->
<!-- mdplace:selection:start -->
<!-- mdplace:selection:end -->
<!-- mdplace:highlights:start -->
<!-- mdplace:highlights:end -->
```

For each present stream, its input is the content between exactly one canonical
start/end marker pair for that stream, with the start marker ordered before the
end marker. Each marker must occupy its entire line. Exclude both marker lines,
the complete `CRLF`, `CR`, or `LF` line terminator immediately after the start
marker, and the complete boundary line terminator immediately before the end
marker. An absent stream has neither marker; a lone, duplicate, or reversed
marker is invalid.

After boundary extraction, convert every `CRLF` and remaining `CR` to `LF`,
then normalize the resulting Unicode text to NFC, then encode it as UTF-8.
Preserve every other byte, including every remaining space, tab, and newline;
do not trim, reflow, or append a newline. Reject a present stream when the
normalized text is empty or every remaining code point is Unicode whitespace.

The escaped payload `Cafe\u0301\r\n  line 2 \t` therefore has these exact
normalized UTF-8 bytes (shown as lowercase hexadecimal):
`436166c3a90a20206c696e6520322009`, representing
`Café\n  line 2 \t`. A candidate that retains `CRLF`, retains decomposed
`e\u0301`, trims either space, or drops the tab is not the canonical stream
input.

Hash each present stream's normalized UTF-8 bytes independently as
`sha256:<64 lowercase hex>`. Remote image bytes are never fetched or hashed.
Markdown image syntax and its URL remain ordinary normalized stream text and
therefore do affect that stream's hash.

### Source-metadata JCS input

The source-metadata object has exactly the members in this literal type form;
`string|null` is a type union, and the quoted schema value is a literal:

```text
{"adapter":{"id":string,"version":string},"captured_at":RFC3339-string,"schema":"mdplace.capture-source-metadata/v1","source":{"author":string|null,"canonical_url":sanitized-string|null,"description":string|null,"image_url":sanitized-string|null,"published_at":RFC3339-string|null,"site":string|null,"title":string|null,"word_count":nonnegative-integer|null}}
```

All members are required. Unknown optional source values are `null`, never
omitted. In particular, an unknown `word_count` is `null`, never `0`; numeric
`0` is allowed only when the adapter actually measured zero words.
`canonical_url` and `image_url` may be non-null only after the adapter has
sanitized them under the Processing Policy. Raw URLs never enter this object:
credentials, fragments, sensitive or unreviewed query data, session
identifiers, and PII must be removed before JCS serialization. Remote image
bytes never enter the object or either hash.

Canonicalize the object with
[RFC 8785/JCS](https://www.rfc-editor.org/rfc/rfc8785): recursively order object
members by the RFC's property-ordering rule, emit no inter-token whitespace or
BOM, and encode the result as UTF-8. JCS does not reorder arrays. The metadata
test vector's exact JCS bytes (with no BOM or trailing newline) are:

```json
{"adapter":{"id":"obsidian-web-clipper","version":"1.7.0"},"captured_at":"2026-07-20T00:00:00Z","schema":"mdplace.capture-source-metadata/v1","source":{"author":null,"canonical_url":"https://example.com/article","description":null,"image_url":null,"published_at":null,"site":"Example","title":"Example title","word_count":null}}
```

The exact result is:

```text
source_metadata_hash = sha256:13932d5ded70ed0a97dab4dc24043bbfc42b6dc95a60db846bdb153c5da02bb2
```

### Stream-manifest JCS input

The stream manifest has exactly this literal type form:

```text
{"schema":"mdplace.capture-stream-manifest/v1","streams":[{"hash":"sha256:<lowercase-hex>","name":"article|selection|highlights"}]}
```

Here `article|selection|highlights` is a closed string-literal union, not one
pipe-containing value. Each `hash` is the corresponding normalized stream hash
and contains exactly 64 lowercase hexadecimal digits. Omit absent streams.
Order present entries `article`, then `selection`, then `highlights`; RFC 8785
orders the members inside each entry as `hash`, then `name`, but it preserves
this array order.

The two-stream test vector has article hash `a` repeated 64 times, no selection
entry, and highlights hash `b` repeated 64 times. Its exact JCS bytes (with no
BOM or trailing newline) are:

```json
{"schema":"mdplace.capture-stream-manifest/v1","streams":[{"hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"article"},{"hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","name":"highlights"}]}
```

The exact result is:

```text
content_hash = sha256:90dd96398830cd225452be04490e7d3b241e8b8a947ca8c590f8803871e5246c
```

`source_metadata_hash` is lowercase SHA-256 over the source-metadata UTF-8 JCS
bytes, and `content_hash` is lowercase SHA-256 over the stream-manifest UTF-8
JCS bytes. These hashes are capture-version evidence only; they establish
neither Captured Tab Note identity, source identity, placement, nor semantic
authority.

Any supported implementation still needs an additional adapter or upstream
change that provides safe serialization, pre-persistence URL sanitation,
metadata-only recovery output, selection-origin provenance, unknown-metadata
semantics, and deterministic runtime hashing while preserving mdplace's
untrusted-input, Processing Policy, and no-semantic-authority boundaries.

## Evidence

The executable sources of truth are the
[JSON diagnostic](./mdplace-captured-tab-note-clipper.json), the
[ten-case driver](./prototype.sh), and the [verifier](./verify.sh). Local task
evidence is intentionally untracked under:

- `.omo/evidence/pr15/task-2-template-green.txt` for the pinned CLI/compiler
  fixture observations
- `.omo/evidence/pr15/task-3-shell-green.txt` for the exact driver
  headings/outcomes and EOF behavior
- `.omo/evidence/pr15/task-4-contract-consistency.txt` for the README/JSON/
  driver/domain relationship and adversarial documentation probe
- `.omo/evidence/pr15/task-5-hash-vectors.txt` for canonical stream, JCS byte,
  digest, locale, and adversarial hash-oracle observations

A verifier pass on an `UNSUPPORTED` row means the observed missing capability
matches this feasibility verdict. It must never be reported as successful
Captured Tab Note delivery.
