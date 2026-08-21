# Remote Intelligence Adapter profile

This Normative Material packages the independently claimable Remote Intelligence Adapter profile. It applies the accepted Processing Policy and Intelligence Adapter decision at [issue #8](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093) as an input without reopening that decision. The profile extends the default-deny Intelligence Adapter proposal protocol; it assumes neither Core conformance nor any Local Intelligence Adapter, Codex Intelligence Adapter, Placement Automation, or product-readiness claim.

## REQ-RAP-001: Canonical Remote Intelligence Adapter vocabulary and stable identifiers are normative

The profile uses the canonical terms Remote Intelligence Adapter, Processing Policy, Intelligence Adapter, Intelligence Adapter Attempt, Processing Envelope, Intelligence Proposal, Adapter Run Receipt, Adapter Isolation Canary, Conformance Fixture, Claim Manifest, Conformance Profile, and Conformance Verdict. Every Remote Intelligence Adapter requirement has one stable `REQ-RAP-*` identifier.

## REQ-RAP-002: The profile claim and all lifecycle tables are closed

`remote-adapter` is one isolated, version-bound Conformance Profile owned by `remote-adapter`. Its closed profile-claim schema and the permitted-egress, denial, failure, retry, fallback, recovery, and verdict tables cover every structured field and every state-command pair. Illegal rows preserve state, emit deterministic denial evidence, and transmit zero bytes.

## REQ-RAP-003: Fixtures observe the public remote profile boundary

Positive, negative, exact-boundary, stale-state, authority-denial, and crash/recovery Conformance Fixtures declare observable policy and profile inputs, exact destinations, exact transmitted bytes, attempts, receipts, verdicts, operations, and filesystem effects. They inspect no private implementation state, own no intake fixture, and own no stateful product scenario.

## REQ-RAP-004: Permitted egress and every pre-egress denial are byte exact

Before each permitted initial, retry, or fallback attempt, the observer binds the approved destination and exact payload bytes. Its receipt records the measured byte count and SHA-256 of those same bytes. Missing, stale, malformed, unsupported, unauthorized, over-budget, unapproved-destination, forbidden-retry, forbidden-fallback, and failed-boundary inputs are denied before egress with an empty payload, zero transmitted bytes, and no provider request identifier. Retries and fallbacks remain independently authorized and bounded.

## REQ-RAP-005: Credential evidence proves only the normative prerequisite boundary

Credential-boundary evidence records a non-secret boundary identifier, approved store and authentication mechanism, prerequisite status, and zero adapter visibility. The profile never reads or records secret values, environment values, ambient configuration, cookies, browser sessions, or private tokens. Authentication is only a prerequisite fact and never establishes residency, retention, training, deletion, entitlement, privacy behavior, semantic authority, or filesystem authority.

## REQ-RAP-006: Provider facts remain disclosed, unsupported, or inconclusive

Retention evidence records only disclosed facts bound to a provider artifact digest. The closed provider-fact dimensions are residency, retention, training, deletion, entitlement, and privacy behavior. Unproven facts remain explicitly unsupported or inconclusive; authentication, successful transport, provider output, retry, fallback, or absence of contrary evidence cannot convert them into disclosed facts or evidence for pass.

## REQ-RAP-007: The independent verdict derives from one exact evidence digest

The Remote Intelligence Adapter Claim Manifest contains exactly one row with `id: remote-adapter` and `owner: remote-adapter`. Its only verdicts are pass, fail, unsupported, or inconclusive, resolved in that precedence. The row binds one ordered evidence digest covering the profile, credential-boundary evidence, retention evidence, fixture manifest, every fixture, machine evidence, and every profile receipt. Missing, stale, failed, unsupported, or inconclusive Remote Intelligence Adapter evidence cannot elevate Core, Web Clipper product readiness, Local Intelligence Adapter, Codex Intelligence Adapter, Placement Automation, or any other claim.

## REQ-RAP-008: The Remote Intelligence Adapter is advisory-only

The profile has zero semantic, note-placement, taxonomy, projection, filesystem, tool, or automation authority. A validated Intelligence Proposal remains inert advice. No proposal, provider response, authentication result, retry, fallback, receipt, or profile verdict can establish semantic truth or mutate the vault.

## REQ-RAP-009: Traceability preserves the accepted decision input

Every Remote Intelligence Adapter requirement traces to decision `DEC-008`, the accepted issue #8 resolution, plus its normative anchors, schemas or transition tables, positive and negative fixtures, acceptance gate, scope, and machine-readable evidence.

## REQ-RAP-010: The profile is specification and conformance only

This profile adds no production mdplace code, performs no network operation, executes no provider or model, reads no credential or ambient configuration, owns zero intake fixtures and zero stateful scenarios, and establishes no semantic truth. Its recovery report revalidates exact attempt, claim, and evidence digests without transmitting or mutating anything.
