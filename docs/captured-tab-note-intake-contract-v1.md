# Captured Tab Note intake contract v1

## Status

Accepted while resolving
[Prototype the Captured Tab Note and Web Clipper contract](https://github.com/jidankim/mdplace/issues/12).
This contract supersedes the earlier one-stage Web Clipper contract and the
historical feasibility prototype under
`prototypes/captured-tab-note-web-clipper`.

The accepted primary-source prototype is commit
[`0ddf832`](https://github.com/jidankim/mdplace/tree/0ddf83227aeff008761addd5344d6e3f91807dd1/prototypes/captured-tab-note-two-stage-intake)
on the throwaway branch `codex/captured-tab-note-two-stage-prototype`.

## Boundary

Stock Obsidian Web Clipper 1.7.0 is a **Capture Source**, not a Capture
Adapter. It can write an untrusted Capture Candidate, but it cannot create a
valid Captured Tab Note by itself.

The mdplace Capture Adapter owns validation, sanitation, normalization,
hashing, promotion, and failure recording. It has no semantic placement or
taxonomy authority.

The lifecycle is:

1. Web Clipper creates a Capture Candidate under
   `.mdplace/intake/web-clipper/pending`.
2. The Capture Adapter validates the exact candidate against a user-approved
   Source Profile and the active Processing Policy.
3. A conforming candidate is promoted atomically into the Inbox as a Captured
   Tab Note, receives a durable ledger receipt, and moves to `processed`.
4. A candidate that reached intake but fails a gate moves to `failed` with a
   stable reason and never produces a partial Inbox note.

Capture Intake is protected local state. Pending, processed, and failed
candidates are excluded from indexing, semantic processing, Folder Projection,
publishing, and remote transmission. Sync is disabled unless an explicit
Processing Policy rule permits the exact intake fields and destination.
Retention and purging are explicit user actions or versioned policy decisions.

Only a promoted Captured Tab Note enters the Inbox.

## Source Profile and provenance

Automatic promotion requires a versioned, user-approved Source Profile that
matches all of:

- Capture Source `obsidian_web_clipper`
- source version claim `1.7.0`
- candidate schema `mdplace.capture-candidate/v1`
- one approved template identifier
- template version `1`
- URL-retention mode
- the active Processing Policy and capture-contract versions

Stock Web Clipper provides a claim, not trustworthy runtime version
attestation. Candidates therefore contain:

```yaml
source_version_claim: "1.7.0"
source_version_verified: false
```

The Source Profile authorizes compatibility with that exact unverified claim;
it does not turn the claim into observed provenance. A missing, disabled, or
mismatched profile blocks automatic promotion.

## Exact Web Clipper creation coordinate

The accepted importable templates are stored on the primary-source prototype
branch:

- `mdplace-web-clipper-candidate-url-withheld.json` is the default.
- `mdplace-web-clipper-candidate-url-retained.json` requires explicit protected
  local raw-URL retention in both the Source Profile and Processing Policy.

Both templates use:

```text
behavior: create
path: .mdplace/intake/web-clipper/pending
filename: candidate-{{date|date:"YYYYMMDD-HHmmss-SSS"}}
```

A filename collision is a hard failure. The Capture Source must never append
to or overwrite an existing candidate.

Page-derived data is forbidden in the candidate filename and frontmatter. It
may appear only inside the body marker envelopes defined below.

### Candidate frontmatter

The complete candidate-frontmatter allowlist is:

```yaml
mdplace_candidate_schema: mdplace.capture-candidate/v1
capture_source: obsidian_web_clipper
source_version_claim: "1.7.0"
source_version_verified: false
capture_template: mdplace-web-clipper-candidate-url-withheld
capture_template_version: "1"
source_captured_at_claim: "<RFC3339 timestamp with millisecond precision and offset>"
```

The retained-URL variant changes only `capture_template` to
`mdplace-web-clipper-candidate-url-retained`.

No identity, placement, review, status, taxonomy, projection, hash, page title,
page URL, arbitrary metadata, description, image URL, or word-count field is
allowed in candidate frontmatter.

### Candidate body

The body begins with a static warning that the artifact is untrusted intake,
then contains exactly one outer envelope:

```text
<!-- mdplace:candidate:v1:start -->
...
<!-- mdplace:candidate:v1:end -->
```

Inside it, markers occur in this order:

1. exactly one live-selection state marker:
   `<!-- mdplace:candidate:live-selection:present -->` or
   `<!-- mdplace:candidate:live-selection:absent -->`
2. the URL-withheld marker
   `<!-- mdplace:candidate:source-url:withheld-by-policy -->` in the default
   variant, or an optional `source-url-raw` start/end pair in the protected
   local variant
3. optional `source-title-raw` start/end pair
4. optional `source-author-raw` start/end pair
5. optional `source-published-at-raw` start/end pair
6. optional `source-site-raw` start/end pair
7. exactly one required `article` start/end pair
8. optional `annotations` start/end pair

Every marker uses the `mdplace:candidate:` namespace and occupies its complete
line. A missing, duplicate, injected, nested, reversed, or reordered marker
fails closed. The article must remain nonempty and non-whitespace after safety
transforms.

The optional raw fields are the complete page-derived metadata allowlist.
Description, image URL, word count, arbitrary metadata, and a canonical
selection stream are excluded.

## Selection and annotations

A live selection makes the candidate invalid. Before clipping, the user must
clear it. The Capture Adapter never guesses whether selected text replaced or
modified readable article extraction.

Saved Web Clipper highlights may be retained as an optional Annotation Stream.
Stock Web Clipper does not preserve reliable live-selection origin when it
creates or merges highlights, so annotations have unknown origin and never
replace or outrank the article.

The accepted activation checklist is:

- import and explicitly select the exact approved template
- match the template to an enabled Source Profile and Processing Policy
- record the user-approved version claim and template version
- set Web Clipper Interpreter use to disabled
- set highlight note-content behavior to **Do nothing**
- clear any live selection before capture
- exclude Capture Intake from search, indexing, projection, publishing, sync,
  and remote processing

Any missing condition blocks automatic promotion.

## Source URLs

The default template withholds the raw source URL before persistence.

The retained-URL template may persist `source_url_raw` only inside protected
local intake and only when explicitly permitted by both the Source Profile and
Processing Policy. The Capture Adapter must sanitize the URL before promotion,
removing credentials, fragments, sensitive or unreviewed query data, session
identifiers, and PII.

A promoted note records exactly one status:

- `retained` with a sanitized non-null `source_url`
- `withheld_by_policy` with `source_url: null`
- `unusable` with `source_url: null`

A withheld or unusable URL does not invalidate an otherwise conforming
Captured Tab Note.

## Images

Image Localization is deferred and low priority.

A Capture Candidate may contain image references as ordinary article or
annotation text. Capture Intake never downloads remote image bytes. During
promotion, safe remote Markdown embeds become inert links or placeholders and
unsafe URLs are removed before hashing.

Later Image Localization requires explicit Processing Policy authorization,
preserves source provenance, and creates a new observed note version. It does
not block initial capture and does not change Captured Tab Note identity.

## Promotion gates

A Capture Adapter may promote only when all gates pass:

- the candidate is in `pending`
- candidate bytes have not already been promoted
- frontmatter matches the exact schema and allowlist
- an enabled Source Profile matches source, version claim, schema, template,
  template version, and URL-retention mode
- the active Processing Policy authorizes every retained field
- live selection is absent
- the exact marker grammar is valid
- normalized article content is nonempty
- raw and promoted URLs satisfy their respective policy boundaries
- image references have been made inert or removed
- candidate and promoted YAML are safe and match their allowlists
- the promoted path and filename are valid and do not collide
- all required hashes reproduce from the planned output

Any failed gate moves the candidate to `failed` with a stable reason. No
frontmatter, body, ledger receipt, or file from a partial promotion may be
treated as a Captured Tab Note.

A stock extension, transport, or empty-extraction failure that occurs before
template rendering creates no candidate and no mdplace receipt. The user may
retry. A failure after a candidate reaches Capture Intake is recorded there.

Retries and recovery are idempotent.

## Promoted Captured Tab Note

### Filename

The Capture Adapter derives the promoted filename from its local intake
observation time:

```text
YYYYMMDD-HHmmss--<safe title up to 80 characters or Untitled>--<candidate-hash prefix>.md
```

The path and filename are operational coordinates, not identity or evidence.
A collision fails closed.

### Frontmatter

The complete portable-frontmatter allowlist is:

```yaml
mdplace_id: "<minted by mdplace>"
capture_schema: mdplace.captured-tab-note/v1
capture_source: obsidian_web_clipper
source_version_claim: "1.7.0"
source_captured_at_claim: "<candidate claim>"
intake_observed_at: "<mdplace RFC3339 timestamp>"
source_url: null # or a sanitized URL
source_url_status: retained # or withheld_by_policy or unusable
source_title: null # or a sanitized string
source_author: null # or a sanitized string
source_published_at: null # or a sanitized string
source_site: null # or a sanitized string
article_hash: "sha256:<64 lowercase hexadecimal digits>"
annotations_hash: "sha256:<64 lowercase hexadecimal digits>"
content_hash: "sha256:<64 lowercase hexadecimal digits>"
```

`source_url_status` is one of `retained`, `withheld_by_policy`, or `unusable`.
`annotations_hash` is omitted when there is no Annotation Stream. The identity
minting algorithm belongs to the identity decision; it is not derived from
path, filename, source URL, or any content hash.

Candidate hash, Source Profile and Processing Policy identifiers and hashes,
contract and normalization versions, validation results, promotion identifier,
and recovery details are ledger-only. Placement, category, taxonomy, review,
projection, and generated-summary fields are forbidden.

### Body

The body contains:

1. one H1 using the sanitized source title or `Untitled`
2. a source callout reflecting the sanitized URL disposition and available
   allowlisted provenance
3. exactly one canonical article envelope
4. an optional `Annotations` heading and canonical Annotation Stream envelope

Canonical promoted markers are:

```text
<!-- mdplace:article:start -->
<!-- mdplace:article:end -->
<!-- mdplace:annotations:start -->
<!-- mdplace:annotations:end -->
```

No generated summary, placement, category, taxonomy, or projection content is
added during capture promotion.

## Hash contract

All digests use SHA-256 and render as `sha256:` followed by 64 lowercase
hexadecimal digits. Hashes are evidence for one observed capture version; they
never establish identity or semantic authority.

### Candidate hash

`candidate_hash` is SHA-256 over the exact candidate file bytes received by
Capture Intake. It is the idempotency key for a candidate and is ledger-only.

### Stream hashes

`article_hash` and optional `annotations_hash` are computed after all safety
transforms, including URL sanitation and inert-image conversion, from the
inner bytes of their promoted marker envelopes.

For each stream:

1. require one ordered marker pair whose markers occupy complete lines
2. exclude the marker lines and their boundary line terminators
3. convert `CRLF` and remaining `CR` to `LF`
4. normalize Unicode to NFC
5. encode as UTF-8
6. preserve every other byte; do not trim, reflow, or add a newline
7. reject an article that is empty or entirely Unicode whitespace

### Source metadata hash

The Capture Adapter constructs this exact object from sanitized promoted
metadata:

```text
{"capture_source":"obsidian_web_clipper","schema":"mdplace.capture-source-metadata/v1","source_author":string|null,"source_captured_at_claim":RFC3339-string,"source_published_at":string|null,"source_site":string|null,"source_title":string|null,"source_url":sanitized-string|null,"source_url_status":"retained"|"withheld_by_policy"|"unusable","source_version_claim":"1.7.0"}
```

It canonicalizes the object with RFC 8785/JCS, encodes the result as UTF-8, and
hashes those bytes as `source_metadata_hash`. This digest is ledger-only.

### Content hash

The versioned manifest has exactly this logical shape:

```text
{"annotations_hash":"sha256:<64 lowercase hexadecimal digits>"|null,"article_hash":"sha256:<64 lowercase hexadecimal digits>","normalization":"mdplace.capture-normalization/v1","schema":"mdplace.capture-content-manifest/v1","source_metadata_hash":"sha256:<64 lowercase hexadecimal digits>"}
```

The Capture Adapter canonicalizes the manifest with RFC 8785/JCS, encodes it as
UTF-8, and hashes those bytes as `content_hash`. A missing Annotation Stream is
represented by JSON `null`, not by omission or an empty-stream digest.

Schema and normalization versions are mandatory hash inputs so a future rule
change cannot silently reproduce an old digest under new semantics.

## Journaled promotion and recovery

`promotion_id` is deterministically derived from the candidate hash, Source
Profile hash, Processing Policy hash, and capture-contract hash. It is
ledger-only.

Promotion proceeds as a recoverable journal:

1. persist the complete promotion plan under `promotion_id`
2. write a temporary sibling of the planned Inbox note
3. validate the temporary file and reproduce every planned hash
4. atomically rename it to the collision-free Inbox path
5. persist the canonical ledger receipt durably
6. move the candidate to `processed` only after the note and receipt are
   durable

After interruption, the Capture Adapter reconciles the journal, candidate,
Inbox file, and ledger by `promotion_id` and hashes. Matching state resumes or
commits idempotently. Drift or a collision fails closed; recovery never creates
a duplicate Captured Tab Note.
