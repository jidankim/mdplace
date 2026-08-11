# Normative validator evidence and claim contract

This document is Normative Material for the `mdplace-spec/v1` Specification Package. The uppercase terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as requirement strength. Canonical mdplace terms are defined only in [`CONTEXT.md`](../../../CONTEXT.md).

The accepted conformance decision in [issue #10](https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153) is an input to this contract. This document applies that decision to validator evidence and does not reopen it.

## REQ-VAL-001: Validator extensions are closed and version-bound

A Validator Extension MUST be selected by an exact `extension_id` present in `contracts/validator-extensions.json`. The registry, invocation schema, accepted subject schemas, Evidence Envelope schema, Claim Manifest schema, validator identity, validator version, Specification Package series, and release version MUST be explicit and closed. Unknown extensions, undeclared subject schemas, ambient defaults, directory-based inference, and caller-selected validators MUST be denied before the subject is evaluated.

The registry contains one reference evidence extension. A later extension requires a Package Amendment that adds its identifier, exact schemas, validator binding, Conformance Fixtures, traceability, and digest bindings. The extension point does not authorize production mdplace behavior.

## REQ-VAL-002: Every validation artifact shares one immutable version binding

Every validator invocation, Evidence Envelope, artifact binding, Claim Manifest, recovery report, and Conformance Verdict MUST bind the same `package_series`, `release_version`, `validator_id`, and `validator_version`. The package manifest and extension registry are the only version authorities. A literal that differs from either authority is stale and MUST be non-pass even when every other field matches.

Every referenced artifact and receipt MUST name a safe package-relative path and lowercase SHA-256 digest. Readback MUST open the declared path without following symbolic or hard links, recompute the digest from observed bytes, and compare it with the declared binding. Each receipt MUST bind bytes already declared as an output or artifact digest by the same Evidence Envelope. A caller assertion that bytes match has no authority.

## REQ-VAL-003: Evidence envelopes are deterministic and complete

An Evidence Envelope MUST identify one stable requirement, one declared subject, and one Validator Extension invocation. It MUST carry ordered input digests, ordered output digests, ordered receipts, ordered artifact digests, explicit execution context, and one Conformance Verdict. Every v1 receipt MUST use the closed `EvidenceValidationReceipt` type and bind a verified output or artifact path and digest from that envelope. The envelope's ordered input digests and execution context MUST exactly reproduce those of its bound invocation. Ordinals MUST begin at zero, be contiguous, and be unique in each ordered collection. Artifact references MUST be unique within the envelope.

The declared subject contains its kind, stable identifier, schema, and digest. The invocation additionally binds the subject's package-relative path; the validator MUST reopen that path, recompute its digest, and validate its bytes against a subject schema explicitly accepted by the extension registry. A digest-matching subject or invocation that cannot be parsed and schema-validated is non-pass. Execution context contains runner identity, platform, architecture, filesystem class, locale, time zone, and network disposition. No field may be recovered from a filename, parent directory, current process, environment variable, host default, or prior invocation.

## REQ-VAL-004: Claim manifests bind one claim to required evidence

A Claim Manifest MUST identify exactly one claim, Conformance Profile, subject, normative requirement, applicability result, evidence requirement set, Evidence Envelope bindings, and aggregate Conformance Verdict. Every binding MUST declare whether it is mandatory, its availability, applicability, evidence reference when one exists, evidence digest when one exists, and evidence verdict.

The closed Conformance Profile set is Core, Stock Web Clipper 1.7.0 Product Readiness, Local Intelligence Adapter, Remote Intelligence Adapter, Codex Intelligence Adapter, Placement Automation, New-Leaf Automatic Promotion, and Alias Automatic Promotion. `claims-and-evidence.yaml` MUST contain exactly one independently digest-bound profile Claim Manifest for every profile. One profile's evidence or verdict MUST NOT satisfy another profile.

## REQ-VAL-005: Verdict aggregation denies absent mandatory proof

The only Conformance Verdict values are `pass`, `fail`, `unsupported`, and `inconclusive`. `pass` means every applicable mandatory Evidence Envelope is present, current, version-matched, digest-matched, supported, and pass. `fail` records a contradicted requirement, invalid artifact or transition, or authority denial. `unsupported` records that the declared validator cannot evaluate the subject or capability. `inconclusive` records that evaluation occurred but current evidence cannot determine the requirement.

Every evidence binding's availability MUST be permitted by the row for its explicit verdict in `contracts/verdicts/validator-verdicts.json`. Missing, stale, skipped, unsupported, unknown-applicability, or inconclusive mandatory evidence MUST NOT aggregate to pass. Missing, stale, skipped, or unknown-applicability evidence aggregates to inconclusive unless a separate contradicted, invalid, or denied observation requires fail. Unsupported evidence remains unsupported unless a fail takes precedence. Aggregate precedence is fail, unsupported, inconclusive, then pass. Optional or not-applicable evidence cannot upgrade or downgrade an otherwise complete mandatory result.

## REQ-VAL-006: Readback and recovery preserve non-pass results

Readback MUST bind the exact Claim Manifest by claim identifier, package-relative path, and digest; re-resolve the declared Validator Extension; recursively revalidate the claim, its Evidence Envelopes, and their invocations; reopen every transitively declared artifact and receipt binding; recompute every digest; reject an omitted or extra recomputed binding; and reproduce the evidence aggregation without ambient inference. A mismatched binding marks the evidence stale and makes the effective result non-pass. Readback MUST NOT replace a recorded verdict.

A recorded non-pass verdict MUST remain effective across retry, process crash, partial report write, and readback until fresh required evidence is explicitly supplied. The `fresh_evidence_supplied` Boolean is descriptive only and cannot satisfy a precondition. Each readback or mark-stale transition MUST bind a current Evidence Recovery Report by identifier, path, and digest, recursively validate that report, and require its terminal state to match the lifecycle row. A fresh-evidence or record-verdict transition MUST bind a current Claim Manifest by identifier, path, and digest, recursively validate every mandatory Evidence Envelope and invocation, and reproduce its aggregate verdict. A fresh-evidence transition additionally MUST bind the recorded Claim Manifest and require at least one newly supplied applicable mandatory evidence binding to use a new Evidence Envelope, invocation digest, invocation identifier, and recomputed input, output, or artifact digest value absent from all recoverable recorded mandatory proof. Ordering, ordinals, labels, paths, collection roles, receipts, and container identifiers do not independently establish freshness; current valid mandatory bindings MAY carry forward unchanged. If a recorded present proof cannot be safely reopened, freshness remains unproven. Supplying genuinely new proof, including replacement of mandatory evidence previously declared missing, stale, skipped, or unsupported, returns the claim to `awaiting_evidence`; only a new complete invocation may record another verdict. A record-verdict transition MUST bind the current Evidence Recovery Report emitted for that fresh supply, validate its `awaiting_evidence` terminal state, and require its fresh Claim Manifest binding to equal the claim being recorded. Recovery MUST emit an Evidence Recovery Report with its current and, when fresh evidence is supplied, recorded Claim Manifest bindings, prior and effective verdicts, the complete recursively enumerated recomputed binding set, ordered operations and receipts, filesystem effects, terminal state, and whether fresh evidence was supplied. A missing or unsafe artifact MUST be represented by a null observed digest and a false match result. Staleness MAY contain only digest-binding failures demonstrated by those recomputations and MUST NOT suppress unrelated schema, requirement, version, authority, or semantic validation failures.

The evidence lifecycle table is complete over `awaiting_evidence`, `verdict_recorded`, and `evidence_stale` for `record_verdict`, `readback`, `mark_stale`, and `supply_fresh_evidence`. Every denied row is an observable illegal transition with unchanged state and no filesystem effect.

## REQ-VAL-007: Validator evidence artifacts are specification-only

This contract, its schemas, registry, verdict and lifecycle tables, fixtures, reference artifacts, validator assertions, traceability, and generated evidence are specification and conformance artifacts only. They MUST NOT implement or invoke the mdplace Agent, Semantic Kernel, Control Channel, Vault Mutation Gate, Capture Adapter, Placement Evaluation, Taxonomy Evolution Cycle, Folder Projection, Intelligence Adapter, Placement Automation Permission, or Automation Grant.

The reference validator MAY read declared package artifacts and write only the requested generated report under `conformance/evidence/`. Report publication MUST commit relative to a validated evidence-directory identity, verify that the identity remains bound to the validated package path immediately before replacement, and fail closed if either binding changes before the commit begins. It MUST observe inputs, outputs, operations, receipts, filesystem effects, terminal states, and illegal transitions, and MUST NOT assert private helper calls, internal class shape, or unconsumed prose.

## Verdict table

`contracts/verdicts/validator-verdicts.json` is the complete machine-readable verdict table. The table declares meaning, mandatory-proof effect, aggregate precedence, permitted availability, and recovery for all four Conformance Verdict values. A consumer MUST use the table row matching the explicit verdict and MUST NOT coerce unsupported or inconclusive to fail or pass.

## Claim-profile isolation

The eight indexed Claim Manifests are structural profile claims over synthetic fixture subjects, not product claims. Their manifest index records the profile, claim identifier, package-relative manifest reference, and SHA-256 digest. A separately bound `recovery_snapshot` Claim Manifest exists only to exercise recursive readback and is not a ninth profile claim. Product readiness or implementation conformance exists only when an implementation emits fresh envelopes and manifests for its own declared subject.

## Release gate

The package MUST fail validation for an unknown extension, undeclared schema, mixed specification or validator versions, invalid digest length, duplicate input identifier, duplicate or noncontiguous ordinal, unresolved artifact or requirement, digest mismatch, unregistered profile, duplicate profile, missing profile row, a Claim Manifest without a required evidence binding, an availability forbidden by its verdict row, pass with non-pass mandatory evidence, caller-asserted freshness without a valid claim binding, replayed evidence presented as fresh, readback or staleness without a valid Recovery Report binding, incomplete evidence lifecycle, uncovered illegal transition, an incomplete recovery binding set, or recovery that upgrades any non-pass verdict without fresh required evidence.
