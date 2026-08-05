# Stock Web Clipper 1.7.0 compatibility prototype

Issue [#27](https://github.com/jidankim/mdplace/issues/27) asks which representative browser-page shapes stock Obsidian Web Clipper 1.7.0 can render into conforming mdplace Capture Candidates, where failures occur, and which compatibility evidence must gate a product-ready Source Profile.

## Proposed decision

Treat Web Clipper compatibility as a staged capability, not a page-wide guarantee.

1. `candidate_eligible` means the stock source rendered the exact seven-property candidate envelope, the required intake path and create-only filename, and a nonempty canonical article region. The Capture Adapter still owns every promotion gate.
2. Semantic articles, documentation/reference pages, generic JSON-LD articles, settled client-rendered pages, and open shadow DOM are the supported baseline shapes.
3. Access-limited teaser pages and pages containing unsafe resource references may reach adapter validation, but must carry `access_limited_content` and `markdown_safety_transform_required` compatibility diagnostics respectively. Eligibility does not assert completeness or safety of the source rendering.
4. Closed shadow DOM, iframe-only content, and metadata-only pages render candidate shells whose empty article regions fail after Capture Intake with `article_empty`. Marker collision and a live browser selection likewise reach intake and fail with `marker_grammar_invalid` and `live_selection_present`.
5. Restricted browser pages and blank pages fail before template rendering, so they create neither a Capture Candidate nor an mdplace receipt. Stock extension, popup transport, Obsidian URI, and save failures belong to the same pre-intake class.
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

Web Clipper renders `source_captured_at_claim` as a plain YAML timestamp scalar. Under the contract's YAML 1.2 core schema this decodes to the required string value, so it is a harmless serialization difference rather than a compatibility failure.

## Required product smoke suite

A product-ready profile should be approved only after all 15 matrix cases pass with the exact outcomes above and three persistence controls pass in a disposable Obsidian vault:

1. A positive capture creates exactly one file under `.mdplace/intake/web-clipper/pending` whose bytes equal the stock popup output and whose filename follows the approved create-only format.
2. An existing target path is never overwritten or appended; the source reports a save failure and mdplace creates no receipt.
3. Popup transport, Obsidian URI, or filesystem save failure leaves no file in Capture Intake and creates no mdplace receipt.

The persistence controls are requirements derived from the capture contract. They were not observed by this browser-only prototype because Obsidian is not installed in the test environment. The rendering matrix therefore supports the compatibility decision but cannot by itself enable a production Source Profile.

## Prototype harness limitation

The complete 15-case matrix passed in one disposable Chrome run, and an independent Playwright session exercised the stock popup and both URL-retention templates. Repeated fresh browser launches can still race Chrome's unpacked-extension registration: the extension page may briefly resolve to `chrome-error://chromewebdata/` or expose no `chrome.runtime`/`chrome.storage` API. This launcher nondeterminism does not change the observed compatibility outcomes, but the product smoke runner must wait for deterministic extension registration before this harness is suitable for unattended CI.

## Run

On macOS arm64, from the repository root:

```bash
bash prototypes/web-clipper-compatibility-prototype/run.sh
```

The runner downloads Chrome for Testing 150.0.7871.124 and the official Web Clipper 1.7.0 Chrome package unless `CHROME_FOR_TESTING_ZIP` and `WEB_CLIPPER_ZIP` point to local copies. It uses disposable browser and fixture-server state and removes that state on exit.

Pinned source evidence:

- Web Clipper release: <https://github.com/obsidianmd/obsidian-clipper/releases/tag/1.7.0>
- Web Clipper source revision: <https://github.com/obsidianmd/obsidian-clipper/commit/48228dce63195681e9dfc4fb8760c3c36db51079>
- Chrome extension archive SHA-256: `8861e7a77c3aaa27d5ac0b22b66a02aea4c03f67c56c700800d4c977c384de96`
- URL-withheld template SHA-256: `25cb91a4afa9365d1c5076bd4bcea8e8136ce44f0963e7e1e8296a7abe672c2a`
- Protected-local URL template SHA-256: `5a57e8d0325838a39cf27e537df41e0d374c74788a52caf9c180dca795dc1a89`

## Human reaction

On 2026-08-05, the user accepted this compatibility boundary and asked to publish the prototype as a pull request. That reaction includes the treatment of access-limited teaser output as structurally eligible but diagnostically incomplete and the requirement for a real disposable-vault persistence smoke before a Source Profile can be enabled.
