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
| filename | With controlled title variables, the pinned compiler applies `slice:0,80`, then `safe_name`, and the `Untitled` fallback. The real pinned CLI does not supply a usable HTML-derived title, so this verdict covers filter semantics only. | SUPPORTED | [filters](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [safe name](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters/safe_name.ts#L56-L64), [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [template](./mdplace-captured-tab-note-clipper.json) |
| Pinned CLI HTML extraction | The CLI/API takes `doc.documentElement`, an `HTMLElement`, casts it as `Document`, and passes it to Defuddle. The pinned executable consequently emits blank HTML-derived variables and `words=0` for the fixtures. This is a CLI test-seam defect, not proof that browser extraction always returns blank data. | UNSUPPORTED | [CLI parser](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/cli.ts#L143-L147), [API extraction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/api.ts#L176-L220), [verifier](./verify.sh) |
| YAML/frontmatter safety | Stock frontmatter generation double-quotes text but its escaping helper escapes only double quotes. The template cannot safely serialize arbitrary page-derived free text or enforce mdplace's ingestion allowlist, so the diagnostic retains none. | UNSUPPORTED | [frontmatter generator](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L145-L205), [escaping helper](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/string-utils.ts#L9-L18), [template](./mdplace-captured-tab-note-clipper.json) |
| selection provenance | Promoting a selection creates an ordinary highlight, may merge it with existing highlights, and clears the selection. The exported shape has text, timestamp, and optional notes, but no reliable selection-origin field. | UNSUPPORTED | [selection promotion and merge](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L558-L602), [exported highlight shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L1113-L1139) |
| metadata-only extraction artifact | Stock browser extraction rejects an empty readable-content response. The popup awaits that extraction before it initializes variables or renders template fields, so the template cannot emit the required metadata-only failure artifact. | UNSUPPORTED | [empty-content rejection](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/content-extractor.ts#L67-L123), [browser ordering](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/core/popup.ts#L678-L740) |
| template/content compiler | The pinned compiler renders the diagnostic's static warning and three presence-only conditionals. This compiler capability does not make the resulting file conforming. | SUPPORTED | [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [renderer](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/renderer.ts#L95-L153), [verifier](./verify.sh) |
| URL persistence policy | Stock variables remove a text fragment but still expose the current URL, and the filter registry has no mdplace sanitizer that guarantees removal of credentials, fragments, sensitive query parameters, session identifiers, and PII before persistence. The diagnostic renders no URL. | UNSUPPORTED | [URL variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66), [filter registry](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [Processing Policy](../../CONTEXT.md) |
| missing word count | Variable construction converts a missing `wordCount` to the string `0`. Stock output therefore cannot distinguish unknown metadata from a genuine zero-word observation. | UNSUPPORTED | [variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66), [verifier](./verify.sh) |
| deterministic hash shape | Stock Web Clipper emits no mdplace hashes, and this diagnostic has no canonical stream boundaries. A reproducible future-adapter schema remains a target contract for Todo 5. | TARGET CONTRACT | [template](./mdplace-captured-tab-note-clipper.json), [driver](./prototype.sh) |
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
  `NONCONFORMING-{{date|date:"YYYYMMDD-HHmmss"}}--{{domain|safe_name}}--{{title|slice:0,80|safe_name ?? "Untitled"}}`

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
conditionals render only `present` or `absent`. The artifact retains no
page-derived title, URL, article, selection text, highlight text, author, site,
description, image, publication time, or word count. It has no
`mdplace:article`, `mdplace:selection`, or `mdplace:highlights` canonical stream
markers. Its path and filename have no identity, placement, or semantic
authority.

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
supplies explicit variables. Its pass proves only the `slice:0,80`,
`safe_name`, and `Untitled` template semantics. It does not erase or work
around the CLI defect, and it does not prove end-to-end filename capture.

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
avoids those unsafe surfaces by retaining no page-derived values at all; that
avoidance is diagnostic containment, not a conforming implementation.

## Future adapter hashing boundary

Deterministic hashing is a **TARGET CONTRACT** for a future conforming adapter,
not behavior of stock Web Clipper or this diagnostic. Todo 5 must complete the
literal source-metadata and stream-manifest schemas, normalization rules,
absent-value semantics, canonical byte inputs, order, and fixed test vectors.
Until that work is complete, there is no reproducible hash schema and no
runtime enforcement here. The current JSON emits no hashes and has no canonical
stream markers.

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

A verifier pass on an `UNSUPPORTED` row means the observed missing capability
matches this feasibility verdict. It must never be reported as successful
Captured Tab Note delivery.
