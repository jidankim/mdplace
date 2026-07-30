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

Unattended capture promotion requires a versioned, user-approved Source Profile that
matches all of:

- Capture Source `obsidian_web_clipper`
- source version claim `1.7.0`
- candidate schema `mdplace.capture-candidate/v1`
- one approved template identifier
- template version `1`
- URL-retention mode
- the active Processing Policy and capture-contract versions

The Source Profile is an RFC 8785/JCS object with exactly these members:

| Member | JSON type | Rule |
| --- | --- | --- |
| `candidate_schema` | string | literal `mdplace.capture-candidate/v1` |
| `capture_contract_hash` | string | canonical contract hash |
| `capture_source` | string | literal `obsidian_web_clipper` |
| `capture_template` | string | one accepted template identifier |
| `capture_template_version` | string | literal `1` |
| `enabled` | Boolean | must be `true` |
| `processing_policy_hash` | string | active Processing Policy hash |
| `schema` | string | literal `mdplace.capture-source-profile/v1` |
| `source_version_claim` | string | literal `1.7.0` |
| `source_version_verified` | Boolean | literal `false` |
| `url_retention_mode` | string | `withheld` or `protected_local` |

Unknown or missing members are invalid. `source_profile_hash` is SHA-256 over
the UTF-8 JCS bytes. `capture_contract_hash` is SHA-256 over the exact UTF-8,
LF-only, no-BOM bytes of this versioned contract file. The Processing Policy
defines its own canonical hash; changing either hash requires explicit Source
Profile approval.

Stock Web Clipper provides a claim, not trustworthy runtime version
attestation. Candidates therefore contain:

```yaml
source_version_claim: "1.7.0"
source_version_verified: false
```

The Source Profile authorizes compatibility with that exact unverified claim;
it does not turn the claim into observed provenance. A missing, disabled, or
mismatched profile blocks unattended capture promotion.

## Normative encoding, parsing, and bounds

The keywords **must**, **must not**, **required**, and **forbidden** are
normative.

Candidate and promoted files must be valid UTF-8 without a byte-order mark.
Candidate marker lines may end in `LF`, `CRLF`, or `CR`; adapter output uses
`LF` only and ends with exactly one `LF`.

Frontmatter is parsed as a YAML 1.2 core-schema mapping with string keys.
Duplicate keys, merge keys, anchors, aliases, explicit tags, non-scalar
values, and unknown keys are forbidden. A candidate has exactly the seven
keys in the candidate allowlist. A promoted note has exactly the promoted
allowlist, except that `annotations_hash` is absent when there is no
Annotation Stream. YAML parsers must not apply implementation-specific
implicit timestamp or number coercions.

The scalar types are:

- `source_version_verified` is the Boolean value `false`
- `source_url`, `source_title`, `source_author`, `source_published_at`, and
  `source_site` are a string or YAML `null`
- every timestamp, identifier, enum, schema name, version, and hash is a string
- every hash matches `^sha256:[0-9a-f]{64}$`
- `source_captured_at_claim` and `intake_observed_at` use RFC 3339 date-time
  syntax with exactly three fractional-second digits and an explicit offset

Before page-derived metadata enters a promoted note, apply
`mdplace.metadata-scalar/v1`: validate UTF-8, normalize to Unicode NFC using
Unicode 15.1, replace every Unicode whitespace run with one ASCII space,
remove every code point in general categories `Cc`, `Cf`, `Cs`, `Co`, and
`Cn`, and trim ASCII spaces. Reject the value when normalization cannot be
completed. Preserve `null` rather than an empty string. `source_title` is
limited to 1,024 UTF-8 bytes; `source_author` and `source_site` to 512 bytes.
`source_published_at` is retained only when it is an RFC 3339 full-date or
date-time; date-times are rendered in UTC with exactly three fractional digits.

Hard v1 limits are:

- candidate file: 16 MiB
- frontmatter: 8 KiB
- article after safety transforms: 12 MiB
- annotations after safety transforms: 2 MiB
- raw URL field: 16 KiB
- each other raw metadata field: 64 KiB
- Capture Intake across pending, processed, and failed: 10,000 candidate files
  or 1 GiB of candidate-file bytes, whichever is reached first

Processing Policy may lower but never raise these limits. Marker parsing and
hashing must be single-pass or otherwise linear in candidate size. Intake
performs no network, DNS, redirect, preview, or image request. A limit breach
fails closed before promotion.

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

Activation must create `.mdplace/intake/web-clipper` and its lifecycle
directories with owner-only permissions, reject a symlink or non-directory at
any path component, and verify that the intake and Inbox roots share a
filesystem. The Capture Adapter accepts only regular candidate files owned
exclusively by the current user, or the platform ACL equivalent, opened
relative to the trusted `pending` directory with no-follow semantics.

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

Candidate frontmatter begins with `---\n`, uses the key order shown, and ends
with `---\n`. All values except `source_version_verified` are strings:
schema/source/template/version strings are plain or double-quoted YAML scalars
with the exact decoded values shown, `source_captured_at_claim` is a quoted
RFC 3339 millisecond date-time, and `source_version_verified` is Boolean
`false`. The validator compares decoded scalar values, so harmless choice of
plain versus double-quoted YAML string does not change conformance.

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

Any missing condition blocks unattended capture promotion.

## Source URLs

The default template withholds the raw source URL before persistence.

The retained-URL template may persist `source_url_raw` only inside protected
local intake and only when explicitly permitted by both the Source Profile and
Processing Policy.

Promotion applies `mdplace.url-sanitizer/v1` without making any network
request:

1. reject inputs longer than 16 KiB or inputs that are not an absolute RFC 3986
   URI
2. lowercase the scheme and permit only `http` or `https`
3. reject userinfo, an empty host, IP literals, `localhost`, and hosts ending
   in `.localhost`, `.local`, `.internal`, or `.home.arpa`
4. convert the host with IDNA2008 ToASCII under STD3 rules, lowercase it, and
   remove a terminal root dot
5. reject invalid ports; remove port `80` from `http` and `443` from `https`
6. use `/` for an empty path, remove dot segments using RFC 3986 section 5.2.4,
   uppercase percent-escape hex digits, decode percent-encoded unreserved ASCII
   characters, and UTF-8 percent-encode every other non-ASCII path byte
7. discard the complete query and fragment; v1 has no query-key exception
8. serialize the remaining ASCII URI as
   `scheme://host[:port]/path`

Sanitization is purely syntactic: no DNS lookup, redirect resolution, preview,
reachability check, certificate check, or fetch is permitted. A future
sanitizer version may introduce a policy-bound query allowlist, but v1 policy
cannot preserve any query value. The sanitizer identifier is included in the
source-metadata hash and promotion receipt.

A promoted note records exactly one status:

- `retained` with a non-null `source_url` produced by
  `mdplace.url-sanitizer/v1`
- `withheld_by_policy` with `source_url: null`
- `unusable` with `source_url: null` when a retained raw value is absent or
  rejected

A withheld or unusable URL does not invalidate an otherwise conforming
Captured Tab Note.

Example:

```text
input:  HTTPS://Example.COM:443/a/../b/%7euser?utm_source=x#fragment
output: https://example.com/b/~user
```

## Images

Image Localization is deferred and low priority.

A Capture Candidate may contain image references as ordinary article or
annotation text. Capture Intake never downloads remote image bytes.

Promotion applies `mdplace.markdown-safety/v1` to article and annotations
before stream hashing:

- parse CommonMark 0.31.2; raw HTML is escaped as text and never interpreted
- sanitize every inline, reference-style, and autolink destination with
  `mdplace.url-sanitizer/v1`
- retain a normal Markdown link only when sanitation succeeds; otherwise
  replace it with its escaped visible label
- replace an image whose destination sanitizes with
  `[Image: <escaped alt text>](<sanitized URL>)`
- replace every other image, HTML image/picture/source element, or CSS
  `url(...)` reference with the literal text
  `[Image omitted: unsafe remote reference]`
- discard image titles and reference definitions that are no longer used

Escaped labels use `mdplace.markdown-display/v1` below. The transform performs
no network or filesystem access. Its exact output, not the raw candidate text,
enters the stream hashes.

Later Image Localization requires explicit Processing Policy authorization,
preserves source provenance, and creates a new observed note version. It does
not block initial capture and does not change Captured Tab Note identity.

## Promotion gates

A Capture Adapter may promote only when all gates pass:

- the candidate is in `pending`
- candidate bytes have not already been promoted
- candidate encoding, YAML, scalar types, and hard size limits are valid
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
- every source-derived scalar satisfies `mdplace.metadata-scalar/v1`
- candidate and output handles resolve beneath their trusted roots, name
  regular files, traverse no symlink, and use restrictive owner-only modes
- the exact promoted path and filename are valid and do not collide
- all required hashes reproduce from the planned output

Any failed gate moves the candidate to `failed` with exactly one primary reason
code from this closed v1 set:

```text
candidate_too_large
intake_quota_exceeded
invalid_utf8
invalid_yaml
schema_mismatch
source_profile_mismatch
policy_denied
live_selection_present
marker_grammar_invalid
article_empty
metadata_invalid
url_unusable
markdown_transform_failed
filesystem_boundary_violation
path_invalid
path_collision
hash_mismatch
promotion_drift
```

`url_unusable` applies only when policy requires a retained URL; otherwise the
candidate may promote with `source_url_status: unusable`. The ledger may carry
additional non-authoritative diagnostics, but the primary reason remains
stable. A failed-intake receipt has exactly
`candidate_hash`, `failed_at` (UTC RFC 3339 milliseconds), `promotion_id`
(hash string or null), `reason` (one code above), and
`schema: "mdplace.capture-failure/v1"`; it contains no page-derived value. No
frontmatter, body, ledger receipt, or file from a partial promotion may be
treated as a Captured Tab Note.

A stock extension, transport, or empty-extraction failure that occurs before
template rendering creates no candidate and no mdplace receipt. The user may
retry. A failure after a candidate reaches Capture Intake is recorded there.

Retries and recovery are idempotent.

## Promoted Captured Tab Note

### Filename

The promoted path is `Inbox/<filename>`. `Inbox` and `.mdplace/intake` are
trusted roots opened by directory handle. The Capture Adapter must use
descriptor-relative operations, reject symlinks and non-regular files, verify
containment after every open, create files with owner-only permissions, and
use exclusive create plus no-replace rename on the same filesystem.

The filename is deterministic:

```text
<UTC intake time>--<safe title>--<candidate hash prefix>.md
```

Derive each component as follows:

1. Convert `intake_observed_at` to UTC, discard fractional seconds, and render
   `YYYYMMDD-HHmmss`.
2. Start from the normalized non-null `source_title`, or `Untitled`.
3. Replace each maximal run containing `/`, `\`, `<`, `>`, `:`, `"`, `|`,
   `?`, `*`, or a Unicode 15.1 code point in categories `Cc`, `Cf`, `Cs`,
   `Co`, or `Cn` with one ASCII hyphen.
4. Collapse Unicode whitespace to one ASCII space and trim ASCII spaces,
   periods, and hyphens from both ends.
5. If the result is empty, `.` or `..`, use `Untitled`. If the
   ASCII-case-insensitive stem before the first period is `CON`, `PRN`, `AUX`,
   `NUL`, `COM1` through `COM9`, or `LPT1` through `LPT9`, prefix `_`.
6. Truncate at a Unicode scalar boundary before the UTF-8 encoding would exceed
   80 bytes, trim trailing ASCII spaces, periods, and hyphens again, and use
   `Untitled` if empty.
7. Remove `sha256:` from `candidate_hash` and take the first 20 hexadecimal
   digits as the candidate hash prefix.

For `intake_observed_at=2026-07-30T00:15:42.123Z`,
`source_title=CON`, and a candidate digest beginning
`0123456789abcdef0123`, the filename is:

```text
20260730-001542--_CON--0123456789abcdef0123.md
```

Path and filename are operational coordinates, not identity or evidence.
Any collision or boundary mismatch fails closed; the adapter never overwrites,
follows a symlink, or chooses a suffix.

### Frontmatter

The complete portable-frontmatter allowlist, in serialization order, is:

```yaml
mdplace_id: "<minted by mdplace>"
capture_schema: "mdplace.captured-tab-note/v1"
capture_source: "obsidian_web_clipper"
source_version_claim: "1.7.0"
source_captured_at_claim: "<candidate claim normalized to UTC milliseconds>"
intake_observed_at: "<mdplace RFC3339 timestamp>"
source_url: null
source_url_status: "withheld_by_policy"
source_title: null
source_author: null
source_published_at: null
source_site: null
article_hash: "sha256:<64 lowercase hexadecimal digits>"
annotations_hash: "sha256:<64 lowercase hexadecimal digits>"
content_hash: "sha256:<64 lowercase hexadecimal digits>"
```

`source_url_status` is one of `retained`, `withheld_by_policy`, or `unusable`.
`annotations_hash` is omitted when there is no Annotation Stream. The identity
minting algorithm belongs to the identity decision; it is not derived from
path, filename, source URL, or any content hash.

Serialization begins with `---\n` and ends with `---\n`. Keys use the order
above. Strings use double-quoted YAML scalars with RFC 8259 JSON escaping and
without optional solidus escaping; null values use the literal `null`. No
comments, blank lines, tags, anchors, aliases, or extra keys are emitted.
`source_url` is a double-quoted string only when status is `retained`;
otherwise it is `null`. Optional source fields use a double-quoted string when
present and `null` otherwise.

Candidate hash, Source Profile and Processing Policy identifiers and hashes,
contract and normalization versions, validation results, promotion identifier,
and recovery details are ledger-only. Placement, category, taxonomy, review,
projection, and generated-summary fields are forbidden.

### Body

`mdplace.markdown-display/v1` first applies
`mdplace.metadata-scalar/v1`, then prefixes a backslash to every ASCII
Markdown punctuation character in this set:

```text
!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
```

A null display value is the unescaped literal `null`.

The promoted body is serialized exactly in this order, with `LF` line endings:

```text
# <escaped source_title or Untitled>

> [!info] Source
> URL status: <retained|withheld_by_policy|unusable>
> URL: <sanitized URL enclosed in angle brackets, or null>
> Title: <escaped value or null>
> Author: <escaped value or null>
> Published: <escaped value or null>
> Site: <escaped value or null>

<!-- mdplace:article:start -->
<normalized article bytes>
<!-- mdplace:article:end -->
```

When annotations exist, append:

```text

## Annotations

<!-- mdplace:annotations:start -->
<normalized annotation bytes>
<!-- mdplace:annotations:end -->
```

Append exactly one final `LF`. For each stream, serialize one `LF` after its
start marker and one additional boundary `LF` before its end marker. The
boundary `LF` is not part of the stream. If stream bytes already end in `LF`,
the serialized body therefore contains two consecutive `LF` bytes before the
end marker, preserving the stream's final newline. Reject a transformed stream
containing a complete line equal to any canonical promoted marker.

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
2. exclude the marker lines, the one `LF` after the start marker, and the one
   additional boundary `LF` before the end marker
3. convert `CRLF` and remaining `CR` to `LF`
4. normalize Unicode to NFC
5. encode as UTF-8
6. preserve every other byte; do not trim, reflow, or add a newline
7. reject an article that is empty or entirely Unicode whitespace

For the normalized bytes represented by `Café\n  line 2 \t`, the exact UTF-8
hex and stream hash are:

```text
436166c3a90a20206c696e6520322009
sha256:97eb26bd3309e495f4393409c877a1845fd6cf89d91e47bd927d109721830d56
```

### Source metadata hash

The source-metadata object has exactly these required members:

| Member | JSON type | Rule |
| --- | --- | --- |
| `capture_source` | string | literal `obsidian_web_clipper` |
| `metadata_scalar` | string | literal `mdplace.metadata-scalar/v1` |
| `schema` | string | literal `mdplace.capture-source-metadata/v1` |
| `source_author` | string or null | `mdplace.metadata-scalar/v1` |
| `source_captured_at_claim` | string | UTC RFC 3339 with three fractional digits |
| `source_published_at` | string or null | canonical full-date or UTC RFC 3339 |
| `source_site` | string or null | `mdplace.metadata-scalar/v1` |
| `source_title` | string or null | `mdplace.metadata-scalar/v1` |
| `source_url` | string or null | `mdplace.url-sanitizer/v1` output |
| `source_url_status` | string | `retained`, `withheld_by_policy`, or `unusable` |
| `source_version_claim` | string | literal `1.7.0` |
| `url_sanitizer` | string | literal `mdplace.url-sanitizer/v1` |

Unknown members and missing members are invalid. Canonicalize the object with
RFC 8785/JCS, encode it as UTF-8 without BOM or trailing newline, and hash
those bytes as `source_metadata_hash`. The digest is ledger-only.

This exact JCS vector:

```json
{"capture_source":"obsidian_web_clipper","metadata_scalar":"mdplace.metadata-scalar/v1","schema":"mdplace.capture-source-metadata/v1","source_author":null,"source_captured_at_claim":"2026-07-30T00:15:42.123Z","source_published_at":null,"source_site":"Example","source_title":"Example title","source_url":"https://example.com/b/~user","source_url_status":"retained","source_version_claim":"1.7.0","url_sanitizer":"mdplace.url-sanitizer/v1"}
```

produces:

```text
sha256:b886030cfdb15902d6f4c7537c35bb4ef9bc19aff197c0bd49dda731df1f93e0
```

### Content hash

The content-manifest object has exactly these required members:

| Member | JSON type | Rule |
| --- | --- | --- |
| `annotations_hash` | string or null | stream hash, or null when absent |
| `article_hash` | string | required stream hash |
| `markdown_safety` | string | literal `mdplace.markdown-safety/v1` |
| `normalization` | string | literal `mdplace.capture-normalization/v1` |
| `schema` | string | literal `mdplace.capture-content-manifest/v1` |
| `source_metadata_hash` | string | source-metadata hash |

Unknown or missing members are invalid. A missing Annotation Stream is JSON
`null`, not omission or an empty-stream digest. Canonicalize with RFC 8785/JCS,
encode as UTF-8 without BOM or trailing newline, and hash as `content_hash`.

With the source-metadata hash above and an article hash of `a` repeated 64
times, the exact JCS bytes are:

```json
{"annotations_hash":null,"article_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","markdown_safety":"mdplace.markdown-safety/v1","normalization":"mdplace.capture-normalization/v1","schema":"mdplace.capture-content-manifest/v1","source_metadata_hash":"sha256:b886030cfdb15902d6f4c7537c35bb4ef9bc19aff197c0bd49dda731df1f93e0"}
```

and `content_hash` is:

```text
sha256:b795982dacd1a64c985cc565fec06b7fb2c7948631d0fbb5e82d5ce0ca8db9fa
```

Schema, sanitizer, and normalization versions are mandatory hash inputs so a
future rule change cannot silently reproduce an old digest under new semantics.

## Journaled promotion and recovery

The promotion-key object has exactly these required members, each hash using
the canonical `sha256:<hex>` rendering:

```text
candidate_hash
capture_contract_hash
processing_policy_hash
schema = "mdplace.capture-promotion-key/v1"
source_profile_hash
```

Unknown or missing members are invalid. Canonicalize the object with RFC
8785/JCS, encode as UTF-8 without BOM or trailing newline, and SHA-256 those
bytes. The resulting `sha256:<hex>` string is `promotion_id`; it is ledger-only.

For candidate/profile/policy/contract digests containing `a`, `b`, `c`, and
`d` respectively repeated 64 times, the exact JCS bytes are:

```json
{"candidate_hash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capture_contract_hash":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","processing_policy_hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","schema":"mdplace.capture-promotion-key/v1","source_profile_hash":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

and the result is:

```text
promotion_id = sha256:b724afde26f6818e8792fd6e6d6472349d571b460b49f33b3e3dbc9191f9aaf6
```

Promotion proceeds as a recoverable journal:

1. Persist and fsync the complete immutable promotion plan under
   `promotion_id`, including `mdplace_id`, trusted root identities, final
   relative path, every output byte length and hash, schema/sanitizer versions,
   and candidate filesystem identity.
2. Remove the `sha256:` prefix from `promotion_id` and exclusively create an
   owner-only regular staging file under
   `.mdplace/intake/web-clipper/.promotion/<64 lowercase hexadecimal digits>.md`.
   The staging and Inbox roots must be on the same filesystem. Use
   descriptor-relative no-follow operations.
3. Write the exact promoted bytes, fdatasync the file, reread it through the
   open descriptor, validate its schema, and reproduce every planned hash.
4. Persist and fsync the canonical ledger receipt in state
   `publication_authorized`. This state authorizes only the exact
   `promotion_id`, file hash, filesystem roots, and final relative path; it
   does not assert that publication has occurred.
5. Atomically move the staged file to the planned Inbox path with a
   no-replace rename primitive, then fsync the Inbox directory. Startup must
   fail rather than emulate this step when the platform cannot guarantee
   same-filesystem atomic no-replace publication.
6. Append and fsync receipt state `published`, then move the candidate to
   `processed` with a no-replace rename and fsync the intake directories.

An Inbox file is admitted as a Captured Tab Note only when:

- a `publication_authorized` or `published` receipt exists
- the receipt names the file's exact relative path, regular-file identity,
  byte length, and content hash
- the file remains beneath the trusted no-symlink Inbox root

All indexers, projections, publishers, and processors must enforce this
admission check. A file without a matching receipt is an untrusted orphan and
is quarantined without reading its body.

Recovery is state-specific:

- before `publication_authorized`, discard or resume only the matching staging
  file
- after authorization but before publication, publish the exact staged file
  or record `promotion_drift`
- after publication but before the `published` state, verify the admitted
  Inbox file and append `published`
- after publication but before the candidate move, complete the move

Any path collision, symlink, filesystem identity change, byte/hash mismatch, or
missing authorized staging file appends `promotion_drift`, revokes further
publication for that plan, and fails closed. Recovery never overwrites,
guesses, or creates a duplicate Captured Tab Note.
