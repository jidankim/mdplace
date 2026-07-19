# Captured Tab Note + Web Clipper contract prototype

> **THROWAWAY PROTOTYPE — not a production specification**

## Question

Does this capture contract preserve the readable article, current selection,
and saved highlights as independent streams from one browser tab, while giving
mdplace enough provenance to validate ingestion without letting the Capture
Adapter assert identity, placement, or Category Tree truth?

The prototype is deliberately concrete: it includes an importable Obsidian Web
Clipper template and a tiny terminal driver for representative capture cases.

Run it with:

```sh
bash prototypes/captured-tab-note-web-clipper/prototype.sh
```

## Proposed contract

### Template and destination

- Export format: Obsidian Web Clipper template schema `0.1.0`.
- Behavior: `create`; never append, prepend, or overwrite.
- Inbox path: vault-relative `Inbox`.
- Filename stem:
  `YYYYMMDD-HHmmss--<safe domain>--<safe title up to 80 characters>`.
- The filename and path are operational coordinates, not note identity or
  semantic evidence. Collision, recapture, and duplicate semantics remain owned
  by **Resolve source identity, recapture, and duplicate semantics**.
- The template must be the first fallback template, or be selected explicitly.
- Obsidian Web Clipper Interpreter is not used by this template.

### Frontmatter ownership

| Owner | Keys | Rule |
| --- | --- | --- |
| Capture Adapter | `capture_contract`, `capture_adapter`, `capture_template_version`, `captured_at`, `capture_workflow_status`, `capture_article_status`, `capture_selection_status`, `capture_highlights_status`, `capture_image_policy`, `source_*` | Preserved as observed capture provenance. They may be incomplete, but must not be silently invented or upgraded. |
| mdplace | `mdplace_id`, accepted-placement, review, and projection bridge keys | Absent at capture. mdplace may add or update only its managed keys after ingestion. |
| User | Any other keys added later | Preserved semantically by mdplace. |

The Capture Adapter must not write `mdplace_id`, `primary_category`,
`category_scheme`, `placement_state`, `placement_id`, `hypothesis_id`,
`review_task_id`, or `projection_id`.

`capture_adapter: obsidian-web-clipper` plus
`capture_template_version: 1` identifies the adapter contract that mdplace can
actually observe. The official template language exposes no variable for the
installed extension version, so the prototype does not fabricate one.

### Independent capture streams

The confirmed invariant is **preserve every available stream without
precedence-based deletion**:

1. The normalized readable article is the primary content stream.
2. A current browser selection is preserved as selection side data.
3. Saved Web Clipper highlights are preserved as structured highlight side
   data, including the text/element data and timestamps exposed by Web Clipper.

Web Clipper must be configured to **Do nothing** when adding highlights to note
content. That keeps `{{content}}` as the readable article when no live selection
exists, while `{{highlights}}` is written separately.

The v1 capture workflow is:

1. If browser text is currently selected, promote it to a Web Clipper highlight.
2. Clear the live browser selection.
3. Clip the page.

The newly promoted selection becomes the newest durable highlight. Its
timestamp preserves recency, while the readable article remains available in
`{{content}}`. A capture attempted with a live selection records
`capture_workflow_status: invalid_live_selection`; the selection and existing
highlights are retained for recovery, but the artifact is not a valid Captured
Tab Note.

Each stream has its own delimiters:

```text
<!-- mdplace:article:start -->
...
<!-- mdplace:article:end -->

<!-- mdplace:selection:start -->
...
<!-- mdplace:selection:end -->

<!-- mdplace:highlights:start -->
...
<!-- mdplace:highlights:end -->
```

Absent optional streams omit their delimiter pair. The body may identify the
source and stream type, but it contains no category, placement, or
machine-generated semantic summary.

### Official Web Clipper limitation

Web Clipper `1.7.0` replaces its clean `{{content}}` article variable with
`{{selection}}` whenever a live selection exists. The template still receives
`{{selection}}`, `{{highlights}}`, and `{{fullHtml}}`, but it does not receive a
second independent Defuddle-normalized article variable.

The confirmed workflow avoids that limitation by promoting the current
selection to a highlight before clipping. If the rule is violated, the
prototype preserves the selection and highlights, records
`capture_article_status: unavailable_active_selection`, and requires recapture.
It does not disguise the unprocessed full page HTML as a normalized readable
article.

### Extraction failures

- If the template can render source metadata but no valid readable article
  stream, it creates an explicitly invalid artifact in the Inbox. The artifact
  retains the available source metadata and any selection/highlight side data
  for recovery.
- mdplace records a blocking ingestion diagnostic, does **not** recognize the
  artifact as a Captured Tab Note, and forbids semantic placement.
- The invalid artifact remains in the Inbox for recapture or manual inspection.
  mdplace must not fill the body from `fullHtml`, run Interpreter, or infer
  missing content remotely.
- A hard extension or transport failure that cannot render the template creates
  no file.

### Images

- Image references remain remote URLs in the captured Markdown.
- `capture_image_policy: remote_url` makes that limitation explicit.
- The Capture Adapter does not download image bytes. Obsidian's separate
  **Download attachments for current file** command may localize them later,
  which creates a new observed file version.
- An article or selection stream hash includes Markdown image syntax and its
  URL exactly as captured. Image binary bytes are never part of a stream hash.

### Hashing after the file reaches the vault

The Web Clipper template does not write hashes. mdplace computes them during
ingestion and records them in the semantic ledger:

1. Locate at most one correctly ordered delimiter pair for each stream.
   Missing article markers, duplicate markers, or reversed markers are a
   blocking invalid-capture diagnostic. Selection and highlight markers are
   optional only when their corresponding status is `absent`.
2. For each present stream, take only the bytes between its marker lines,
   excluding the line break immediately after the start marker and immediately
   before the end marker.
3. Require valid UTF-8, normalize line endings to LF, and normalize Unicode to
   NFC. Preserve all other Markdown bytes; do not reflow whitespace, rewrite
   links, or fetch images.
4. Reject an empty or whitespace-only present stream.
5. SHA-256 hash each normalized stream independently as `article_content_hash`,
   `selection_hash`, or `highlights_hash`, using
   `sha256:<64 lowercase hex>`.
6. Build a canonical JSON object from the Capture Adapter-owned frontmatter
   fields, representing absent optional values as `null`, canonicalize it with
   RFC 8785/JCS, and SHA-256 hash it as the source-metadata hash.
7. JCS-canonicalize the ordered stream-name/hash manifest and SHA-256 hash it as
   the capture-stream manifest hash.

These hashes are capture-version evidence. They are not Captured Tab Note
identity, source identity, or semantic placement.

## Decisions confirmed

- Preserve the article, current selection, and saved highlights as independent
  streams. No stream deletes another through precedence.
- Before clipping, promote a live selection to a Web Clipper highlight and
  clear the selection. The promoted selection is preserved as the newest
  timestamped highlight so the readable article remains available.
- If source metadata can be rendered but no readable article can be extracted,
  preserve an explicitly invalid artifact in the Inbox for recovery. It is not
  a Captured Tab Note and cannot be placed. A hard extension or transport
  failure still creates no file.
- Preserve image references as remote URLs and do not automatically download
  image bytes. A later explicit attachment download creates a new observed file
  version while retaining file identity.
- Omit hashes from the Web Clipper output. During ingestion, mdplace computes
  independent normalized hashes for each present stream, adapter-owned source
  metadata, and the ordered stream manifest. These hashes are capture-version
  evidence, not identity or placement authority.
- Create every clip in the vault-relative `Inbox` using the filename stem
  `YYYYMMDD-HHmmss--<safe domain>--<safe title up to 80 characters>`. The
  filename and path are operational coordinates only, never note identity or
  semantic placement evidence.
- Limit Capture Adapter-owned frontmatter to the observable capture
  contract/version, capture time, workflow and stream statuses, remote-image
  policy, and `source_*` metadata listed above. Identity, placement, review,
  and projection fields are absent until mdplace owns them after ingestion.
- Use a human-readable title and source callout followed by independently
  delimited article, optional unexpected-selection, and optional saved-highlight
  streams. Marker pairs are canonical ingestion boundaries, and the body
  contains no category, placement, or generated semantic summary.
- Require the exact JSON template to be selected explicitly or as the first
  fallback, Web Clipper highlight note-content behavior set to **Do nothing**,
  any live selection promoted and cleared before capture, and Interpreter not
  invoked.

## Verdict

The complete v1 prototype contract is accepted. A file is a valid Captured Tab
Note only when it was produced through the confirmed workflow and contains a
valid readable article stream with conforming provenance, statuses, and marker
boundaries. Invalid recovery artifacts remain visible in the Inbox but have no
Captured Tab Note or placement status.

## Verified upstream constraints

This prototype was checked against Obsidian Web Clipper `1.7.0` at commit
[`48228dce63195681e9dfc4fb8760c3c36db51079`](https://github.com/obsidianmd/obsidian-clipper/tree/48228dce63195681e9dfc4fb8760c3c36db51079):

- [Template export and import shape](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/import-export.ts)
- [Template variables and selection/highlight processing](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/content-extractor.ts)
- [Filename/path handoff to Obsidian](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/obsidian-note-creator.ts)
- [Official capture and image behavior](https://obsidian.md/help/web-clipper/capture)
- [Official variable semantics](https://obsidian.md/help/web-clipper/variables)
- [Official highlight behavior](https://obsidian.md/help/web-clipper/highlight)
