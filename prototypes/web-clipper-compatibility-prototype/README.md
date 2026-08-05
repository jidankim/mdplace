# Stock Web Clipper 1.7.0 compatibility prototype

Issue [#27](https://github.com/jidankim/mdplace/issues/27) asks which representative browser-page shapes stock Obsidian Web Clipper 1.7.0 can render into conforming mdplace Capture Candidates, where failures occur, and which compatibility evidence must gate a product-ready Source Profile.

## Proposed decision

Treat Web Clipper compatibility as a staged capability, not a page-wide guarantee.

1. `candidate_eligible` means the stock source rendered the exact seven-property candidate envelope, the required intake path and create-only filename, and a nonempty canonical article region. The Capture Adapter still owns every promotion gate.
2. Semantic articles, documentation/reference pages, generic JSON-LD articles, settled client-rendered pages, and open shadow DOM are the supported baseline shapes.
3. Access-limited teaser pages and pages containing unsafe resource references may reach adapter validation, but must carry `access_limited_content` and `markdown_safety_transform_required` compatibility diagnostics respectively. Eligibility does not assert completeness or safety of the source rendering.
4. Closed shadow DOM, iframe-only content, and metadata-only pages render candidate shells whose empty article regions fail after Capture Intake with `article_empty`. Marker collision and a live browser selection likewise reach intake and fail with `marker_grammar_invalid` and `live_selection_present`.
5. Restricted browser pages and blank pages are genuine `pre_intake_no_candidate` compatibility outcomes: the stock popup rejects them before template rendering, so they create neither a Capture Candidate nor an mdplace receipt. Popup transport, clipboard interception, and runner failures are test-infrastructure failures and cannot be reported as page compatibility outcomes. Obsidian URI and filesystem save failures remain separate product smoke controls outside this browser harness.
6. The protected-local template may retain a raw URL only in protected Capture Intake. Sanitization remains mandatory before promotion.

The existing `mdplace.capture-source-profile/v1` object has an exact, closed member set. Compatibility test results must therefore remain a separate activation artifact rather than adding unknown members to the Source Profile. Enabling a profile should require a local `mdplace.capture-source-compatibility/v1` evidence record bound to:

- the Source Profile hash and both the capture-contract and Processing Policy hashes;
- exact template identifier, version, and import-artifact hash;
- the Web Clipper release asset digest, release tag, and source revision, without upgrading its unverified runtime version claim into attestation;
- browser family, exact browser version, operating system, and architecture;
- fixture-suite revision and observation time;
- one result per required case with `pre_intake_no_candidate`, `candidate_failed`, or `candidate_eligible`, the stable failure reason where applicable, non-authoritative diagnostics, and a candidate digest or `null`;
- a successful disposable-vault persistence smoke for create-only file materialization.

Changing any bound template, contract, policy, source release asset, browser family/version, platform, or fixture-suite revision invalidates the evidence and disables unattended promotion until the suite is rerun and approved. This is activation evidence only. It is not candidate provenance.

## Observed matrix

The runner uses the official Chrome release asset for Web Clipper 1.7.0, verifies its SHA-256 digest, loads it in Chrome for Testing, installs the two immutable v1 template artifacts into the stock extension's own compressed storage representation, invokes the stock popup, and captures its exact generated candidate bytes through the popup's Copy to clipboard action.

The committed [Chrome 150/macOS arm64 matrix evidence](evidence/matrix-chrome-150-macos-arm64.json) is a browser-compatibility observation, not the complete `mdplace.capture-source-compatibility/v1` activation artifact described above. It records the exact browser, extension, template, capture-contract, and fixture-suite bindings available to this prototype, plus observation time, activation-style per-case status, assertions, compatibility outcomes, and candidate digests. It sets `activationArtifact` to `false` and lists the missing Source Profile hash, Processing Policy hash, and disposable-vault persistence smoke. It contains no candidate bodies, credentials, or user data.

| Case | Stock result | Intake boundary | Required diagnostic or reason |
| --- | --- | --- | --- |
| Semantic `<article>` | Candidate with sentinel | Eligible for adapter validation | None |
| Documentation/reference `<main>` | Candidate with sentinel | Eligible for adapter validation | None |
| Generic JSON-LD `Article` | Candidate with sentinel | Eligible for adapter validation | None |
| Settled client-rendered page | Candidate with sentinel | Eligible for adapter validation | None |
| Open shadow DOM | Candidate with sentinel | Eligible for adapter validation | None |
| Closed shadow DOM | Empty candidate shell | Fails after intake | `article_empty` |
| Iframe-only article | Empty candidate shell | Fails after intake | `article_empty` |
| Metadata-only page | Empty candidate shell | Fails after intake | `article_empty` |
| Access-limited teaser | Candidate with teaser sentinel | Eligible for adapter validation | `access_limited_content` |
| Unsafe remote resources | Candidate with sentinel | Eligible for adapter validation | `markdown_safety_transform_required` |
| Injected canonical marker | Candidate with duplicate marker | Fails after intake | `marker_grammar_invalid` |
| Live selection | Candidate with selection marker | Fails after intake | `live_selection_present` |
| Protected-local URL template | Candidate retains synthetic query and fragment | Eligible for adapter validation | `url_sanitization_required_before_promotion` |
| `chrome://version` | No candidate | Fails before intake | Stock popup says the page cannot be clipped |
| `about:blank` | No candidate | Fails before intake | Stock popup says the page cannot be clipped |

The templates declare `source_captured_at_claim` as text so stock Web Clipper emits the rendered RFC 3339 value as the contract-required quoted string scalar.

## Required product smoke suite

A product-ready profile should be approved only after all 15 matrix cases pass with the exact outcomes above and three persistence controls pass in a disposable Obsidian vault:

1. A positive capture creates exactly one file under `.mdplace/intake/web-clipper/pending` whose bytes equal the stock popup output and whose filename follows the approved create-only format.
2. An existing target path is never overwritten or appended; the source reports a save failure and mdplace creates no receipt.
3. Popup transport, Obsidian URI, or filesystem save failure leaves no file in Capture Intake and creates no mdplace receipt.

The persistence controls are requirements derived from the capture contract. They were not observed by this browser-only prototype because Obsidian is not installed in the test environment. The rendering matrix therefore supports the compatibility decision but cannot by itself enable a production Source Profile.

## Prototype harness limitation

The complete 15-case browser matrix is recorded in the linked evidence artifact. The runner bounds target discovery, CDP commands, popup clipboard capture, and shutdown; it also waits for the exact unpacked-extension target and confirms the required extension APIs before storage bootstrap. An infrastructure failure is reported separately from a genuine pre-intake page rejection, so a missing Copy action or stalled clipboard interception cannot masquerade as a compatibility result.

This remains a browser-rendering prototype. It does not exercise the required disposable Obsidian-vault persistence controls and therefore cannot enable a production Source Profile by itself.

## Stock filename precision

The approved template asks for `candidate-{{date|date:"YYYYMMDD-HHmmss-SSS"}}`, but pinned Web Clipper 1.7.0 builds `{{date}}` and `{{time}}` from a timestamp formatted only through seconds. The later date filter can reformat that value, but cannot recover the discarded milliseconds, so `SSS` renders as `000`. See the pinned [`buildVariables()` source](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/shared.ts#L40-L52) and [date filter](https://github.com/obsidianmd/obsidian-clipper/blob/48228dce63195681e9dfc4fb8760c3c36db51079/src/utils/filters/date.ts#L12-L50).

The checked observation therefore contains 13 distinct candidate digests but only five distinct stock filenames. The browser matrix intentionally preserves those collisions: it does not retry, deduplicate, or claim filename uniqueness. Collision-safe create-only behavior, including no overwrite or append, belongs to issue #27's separate disposable-vault persistence smoke and was not observed here.

## Run

On macOS arm64, from the repository root:

```bash
bash prototypes/web-clipper-compatibility-prototype/run.sh
```

The runner downloads Chrome for Testing 150.0.7871.124 and the official Web Clipper 1.7.0 Chrome package unless `CHROME_FOR_TESTING_ZIP` and `WEB_CLIPPER_ZIP` point to local copies. `FIXTURE_PORT` defaults to `8766` and `DEBUG_PORT` defaults to `9228`; the ports must differ and both must be available on `127.0.0.1`. `FIXTURE_SUITE_REVISION` defaults to the Git HEAD resolved from the prototype directory. Set it explicitly when running a copy outside a Git checkout so evidence remains bound to an exact revision.

The runner uses disposable browser and fixture-server state and removes that state on exit. Because Chrome permits `chrome.action.openPopup()` only for the frontmost application window, the runner asks macOS System Events to foreground the exact Chrome-for-Testing process by PID before opening the popup. The browser may briefly take focus, and macOS may request Automation permission for the invoking terminal.

Set `EVIDENCE_OUTPUT` to atomically retain the matrix JSON only after a passing matrix. A failed matrix does not publish output or replace an existing destination:

```bash
EVIDENCE_OUTPUT=/absolute/path/matrix.json \
  bash prototypes/web-clipper-compatibility-prototype/run.sh
```

Pinned source evidence:

- Web Clipper release: <https://github.com/obsidianmd/obsidian-clipper/releases/tag/1.7.0>
- Web Clipper source revision: <https://github.com/obsidianmd/obsidian-clipper/commit/48228dce63195681e9dfc4fb8760c3c36db51079>
- Chrome extension archive SHA-256: `8861e7a77c3aaa27d5ac0b22b66a02aea4c03f67c56c700800d4c977c384de96`
- Chrome for Testing 150.0.7871.124 macOS arm64 archive SHA-256: `36c8b5fe04c08a418a172206bb392600ec1550941bde6af2d4353df21db87a47`
- URL-withheld template SHA-256: `fa72c5fbe5e0da5cfd88d58427af875ded19c75866e0b47d9e2ec6117af10fff`
- Protected-local URL template SHA-256: `0c3d4be3391f12cc5aab5b4b85e4d14153e7bf5e1dd1edcac6faa9ae76ed7084`

## Human reaction

On 2026-08-05, the user accepted this compatibility boundary and asked to publish the prototype as a pull request. That reaction includes the treatment of access-limited teaser output as structurally eligible but diagnostically incomplete and the requirement for a real disposable-vault persistence smoke before a Source Profile can be enabled.
