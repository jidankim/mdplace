# Normative validator evidence and claim contract

This document is Normative Material for the `mdplace-spec/v1` Specification Package. The uppercase terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as requirement strength. Canonical mdplace terms are defined only in [`CONTEXT.md`](../../../CONTEXT.md).

The accepted conformance decision in [issue #10](https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153) is an input to this contract. This document applies that decision to validator evidence and does not reopen it.

## REQ-VAL-001: Validator extensions are closed and version-bound

A Validator Extension MUST be selected by an exact `extension_id` present in `contracts/validator-extensions.json`. The registry, invocation schema, accepted subject schemas, Evidence Envelope schema, Claim Manifest schema, validator identity, validator version, Specification Package series, and release version MUST be explicit and closed. Unknown extensions, undeclared subject schemas, ambient defaults, directory-based inference, and caller-selected validators MUST be denied before the subject is evaluated.

The registry contains one reference evidence extension. A later extension requires a Package Amendment that adds its identifier, exact schemas, validator binding, Conformance Fixtures, traceability, and digest bindings. The extension point does not authorize production mdplace behavior.

## REQ-VAL-002: Every validation artifact shares one immutable version binding

Every validator invocation, Evidence Envelope, artifact binding, Claim Manifest, recovery report, and Conformance Verdict MUST bind the same `package_series`, `release_version`, `validator_id`, and `validator_version`. The package manifest and extension registry are the only version authorities. A literal that differs from either authority is stale and MUST be non-pass even when every other field matches.

Every referenced artifact MUST name a safe package-relative path and lowercase SHA-256 digest. Readback MUST open the declared path without following symbolic or hard links, recompute the digest from observed bytes, and compare it with the declared binding. A caller assertion that bytes match has no authority.

## REQ-VAL-003: Evidence envelopes are deterministic and complete

An Evidence Envelope MUST identify one stable requirement, one declared subject, and one Validator Extension invocation. It MUST carry ordered input digests, ordered output digests, ordered receipts, ordered artifact digests, explicit execution context, and one Conformance Verdict. Ordinals MUST begin at zero, be contiguous, and be unique in each ordered collection. Artifact references MUST be unique within the envelope.

The declared subject contains its kind, stable identifier, schema, and digest. Execution context contains runner identity, platform, architecture, filesystem class, locale, time zone, and network disposition. No field may be recovered from a filename, parent directory, current process, environment variable, host default, or prior invocation.

## REQ-VAL-004: Claim manifests bind one claim to required evidence

A Claim Manifest MUST identify exactly one claim, Conformance Profile, subject, normative requirement, applicability result, evidence requirement set, Evidence Envelope bindings, and aggregate Conformance Verdict. Every binding MUST declare whether it is mandatory, its availability, applicability, evidence reference when one exists, evidence digest when one exists, and evidence verdict.

The closed Conformance Profile set is Core, Stock Web Clipper 1.7.0 Product Readiness, Local Intelligence Adapter, Remote Intelligence Adapter, Codex Intelligence Adapter, Placement Automation, New-Leaf Automatic Promotion, and Alias Automatic Promotion. `claims-and-evidence.yaml` MUST contain exactly one independently digest-bound example Claim Manifest for every profile. One profile's evidence or verdict MUST NOT satisfy another profile.

## REQ-VAL-005: Verdict aggregation denies absent mandatory proof

The only Conformance Verdict values are `pass`, `fail`, `unsupported`, and `inconclusive`. `pass` means every applicable mandatory Evidence Envelope is present, current, version-matched, digest-matched, supported, and pass. `fail` records a contradicted requirement, invalid artifact or transition, or authority denial. `unsupported` records that the declared validator cannot evaluate the subject or capability. `inconclusive` records that evaluation occurred but current evidence cannot determine the requirement.

Missing, stale, skipped, unsupported, or inconclusive mandatory evidence MUST NOT aggregate to pass. Missing, stale, or skipped evidence aggregates to inconclusive unless a separate contradicted, invalid, or denied observation requires fail. Unsupported evidence remains unsupported unless a fail takes precedence. Aggregate precedence is fail, unsupported, inconclusive, then pass. Optional or not-applicable evidence cannot upgrade or downgrade an otherwise complete mandatory result.

## REQ-VAL-006: Readback and recovery preserve non-pass results

Readback MUST re-resolve the declared Validator Extension, revalidate every schema and version binding, reopen every declared artifact, recompute every digest, and reproduce the evidence aggregation without ambient inference. A mismatched binding marks the evidence stale and makes the effective result non-pass. Readback MUST NOT replace a recorded verdict.

A recorded fail or inconclusive verdict MUST remain effective across retry, process crash, partial report write, and readback until fresh required evidence is explicitly supplied. Supplying fresh evidence returns the claim to `awaiting_evidence`; only a new complete invocation may record another verdict. Recovery MUST emit an Evidence Recovery Report with prior and effective verdicts, recomputed bindings, ordered operations and receipts, filesystem effects, terminal state, and whether fresh evidence was supplied.

The evidence lifecycle table is complete over `awaiting_evidence`, `verdict_recorded`, and `evidence_stale` for `record_verdict`, `readback`, `mark_stale`, and `supply_fresh_evidence`. Every denied row is an observable illegal transition with unchanged state and no filesystem effect.

## REQ-VAL-007: Validator evidence artifacts are specification-only

This contract, its schemas, registry, verdict and lifecycle tables, fixtures, examples, validator assertions, traceability, and generated evidence are specification and conformance artifacts only. They MUST NOT implement or invoke the mdplace Agent, Semantic Kernel, Control Channel, Vault Mutation Gate, Capture Adapter, Placement Evaluation, Taxonomy Evolution Cycle, Folder Projection, Intelligence Adapter, Placement Automation Permission, or Automation Grant.

The reference validator MAY read declared package artifacts and write only the requested generated report under `conformance/evidence/`. It MUST observe inputs, outputs, operations, receipts, filesystem effects, terminal states, and illegal transitions, and MUST NOT assert private helper calls, internal class shape, or unconsumed prose.

## Verdict table

`contracts/verdicts/validator-verdicts.json` is the complete machine-readable verdict table. The table declares meaning, mandatory-proof effect, aggregate precedence, permitted availability, and recovery for all four Conformance Verdict values. A consumer MUST use the table row matching the explicit verdict and MUST NOT coerce unsupported or inconclusive to fail or pass.

## Claim-profile isolation

The eight Claim Manifest examples are structural conformance examples over synthetic fixture subjects, not product claims. Their manifest index records the profile, claim identifier, package-relative manifest reference, and SHA-256 digest. Product readiness or implementation conformance exists only when an implementation emits fresh envelopes and manifests for its own declared subject.

## Release gate

The package MUST fail validation for an unknown extension, undeclared schema, mixed specification or validator versions, invalid digest length, duplicate or noncontiguous ordinal, unresolved artifact, digest mismatch, unregistered profile, duplicate profile, missing profile row, a Claim Manifest without a required evidence binding, pass with non-pass mandatory evidence, incomplete evidence lifecycle, uncovered illegal transition, or recovery that upgrades fail or inconclusive without fresh required evidence.
