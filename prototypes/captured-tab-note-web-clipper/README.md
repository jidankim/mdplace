# Stock Web Clipper 1.7.0 feasibility result

> **SUPERSEDED CONTRACT**
>
> This prototype remains historical feasibility evidence. The accepted contract
> is the two-stage [Captured Tab Note intake contract](../../docs/captured-tab-note-intake-contract-v1.md):
> stock Web Clipper is a Capture Source that writes an untrusted Capture
> Candidate, and an mdplace Capture Adapter validates and promotes it.

> **NOT A SUPPORTED CAPTURE ADAPTER**
>
> Stock Obsidian Web Clipper 1.7.0 at pinned commit
> [`48228dce63195681e9dfc4fb8760c3c36db51079`](https://github.com/obsidianmd/obsidian-clipper/tree/48228dce63195681e9dfc4fb8760c3c36db51079)
> was evaluated as a potential Capture Adapter under the superseded one-stage
> contract. Under the accepted contract it is only a Capture Source. The
> included JSON is a `NONCONFORMING` local diagnostic, not a Capture Candidate
> or Captured Tab Note producer.

This throwaway prototype records a feasibility result for the stock product.
Its narrow positive results prove only that selected template mechanics work.
Each matching negative result is passing feasibility evidence that a required
capability is absent; it is never product-success evidence.

## Requirement matrix

| Requirement | Pinned observation | Verdict | Owner path |
| --- | --- | --- | --- |
| filename | In a standalone, non-persisting probe, the pinned compiler applies `slice:0,80`, then `safe_name`, and the `Untitled` fallback. `safe_name` provides filename safety, not privacy sanitation. The persisted diagnostic filename is adapter-time-only and does not use page title or domain. The real pinned CLI does not supply a usable HTML-derived title, so this verdict covers stock filename/compiler mechanics only. | SUPPORTED | [filters](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [safe name](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters/safe_name.ts#L56-L64), [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [template](./mdplace-captured-tab-note-clipper.json) |
| Pinned CLI HTML extraction | The CLI/API takes `doc.documentElement`, an `HTMLElement`, casts it as `Document`, and passes it to Defuddle. The pinned executable consequently emits blank HTML-derived variables and `words=0` for the fixtures. This is a CLI test-seam defect, not proof that browser extraction always returns blank data. | UNSUPPORTED | [CLI parser](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/cli.ts#L143-L147), [API extraction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/api.ts#L176-L220) |
| YAML/frontmatter safety | Stock frontmatter generation double-quotes text but its escaping helper escapes only double quotes. The template cannot safely serialize arbitrary page-derived free text or enforce mdplace's ingestion allowlist, so the diagnostic persists no page-derived content or metadata field values. | UNSUPPORTED | [frontmatter generator](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L145-L205), [escaping helper](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/string-utils.ts#L9-L18), [template](./mdplace-captured-tab-note-clipper.json) |
| selection provenance | Promoting a selection creates an ordinary highlight, may merge it with existing highlights, and clears the selection. The exported shape has text, timestamp, and optional notes, but no reliable selection-origin field. | UNSUPPORTED | [selection promotion and merge](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L558-L602), [exported highlight shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/highlighter.ts#L1113-L1139) |
| metadata-only extraction artifact | Stock browser extraction rejects an empty readable-content response. The popup awaits that extraction before it initializes variables or renders template fields, so the template cannot emit the required metadata-only failure artifact. | UNSUPPORTED | [empty-content rejection](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/content-extractor.ts#L67-L123), [browser ordering](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/core/popup.ts#L678-L740) |
| template/content compiler | With controlled variables, the pinned compiler renders the diagnostic's static warning and all positive and negative presence-only branches without rendering supplied content, selection, or highlight values. This compiler capability does not make the resulting file conforming. | SUPPORTED | [compiler](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/template-compiler.ts#L29-L75), [renderer](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/renderer.ts#L95-L153) |
| URL persistence policy | Stock variables remove a text fragment but still expose the current URL, and the filter registry has no mdplace sanitizer that guarantees removal of credentials, fragments, sensitive query parameters, session identifiers, and PII before persistence. The diagnostic renders no URL. | UNSUPPORTED | [URL variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66), [filter registry](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters.ts#L73-L186), [Processing Policy](../../CONTEXT.md) |
| missing word count | Variable construction converts a missing `wordCount` to the string `0`. Stock output therefore cannot distinguish unknown metadata from a genuine zero-word observation. | UNSUPPORTED | [variable construction](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L66) |
| deterministic hash shape | Stock Web Clipper emits no mdplace hashes or canonical stream boundaries. An obsolete experiment once lived here; only the accepted two-stage contract is normative. | HISTORICAL ONLY | [accepted hash contract](../../docs/captured-tab-note-intake-contract-v1.md#hash-contract) |
| import/activation mechanics | The schema `0.1.0` JSON shape can be imported, and the pinned compiler can render it against local fixtures. Activation proves only those mechanics and supplies none of the missing ingestion guarantees. | SUPPORTED | [export shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/import-export.ts#L23-L67), [import validation](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/import-export.ts#L69-L170), [template](./mdplace-captured-tab-note-clipper.json) |
| Captured Tab Note conformance | Stock 1.7.0 lacks required safe serialization, pre-persistence URL sanitation, metadata-only recovery, selection-origin provenance, unknown-metadata semantics, and runtime hashing. The diagnostic is not a Captured Tab Note. | UNSUPPORTED | [domain contract](../../CONTEXT.md), [template](./mdplace-captured-tab-note-clipper.json), [driver](./prototype.sh) |

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
```

The former verifier was reviewed on an unmerged branch and is not part of this
repository. Its commands and schemas are deliberately not an active interface.

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

## Withdrawn hashing experiment

The superseded prototype once carried a different selection/highlights marker
model and reused schema names that the accepted two-stage contract now defines
differently. Those marker names, schemas, byte vectors, and digests are
withdrawn and must not be implemented. The only normative serialization and
hash rules are in the
[Captured Tab Note intake contract](../../docs/captured-tab-note-intake-contract-v1.md#hash-contract).

## Evidence

The surviving historical artifacts are the
[JSON diagnostic](./mdplace-captured-tab-note-clipper.json) and the
[ten-case driver](./prototype.sh). Local task evidence was intentionally
untracked under:

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
