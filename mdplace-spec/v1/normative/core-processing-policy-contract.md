# Normative Core Processing Policy and Source Profile contract

This document is Normative Material for the `mdplace-spec/v1` Specification Package. The uppercase terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are requirement strength. Canonical mdplace terms are defined only in [`CONTEXT.md`](../../../CONTEXT.md).

The accepted resolution in [issue #8](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093) is the sole decision input to this contract. This document applies that resolution without reopening it. All Intelligence Adapters remain advisory, every remote disclosure remains default-deny, and no provider, output, score, authentication method, compatibility observation, or Processing Policy establishes semantic truth.

## REQ-CPP-001: Stable requirements use canonical policy vocabulary

This contract and the requirement catalog MUST retain identifiers `REQ-CPP-001` through `REQ-CPP-007`. Processing Policy, Source Profile, Capture Source, Capture Adapter, Capture Candidate, Capture Intake, Captured Tab Note, Intelligence Adapter, Placement Automation Permission, Automation Grant, Semantic Kernel, Vault Mutation Gate, Conformance Fixture, Traceability Record, and Specification Package have only the meanings in `CONTEXT.md`.

A Processing Policy is a versioned grant document, not blanket consent. A Source Profile is a versioned user-approved compatibility permission, not observed runtime provenance, compatibility evidence, or semantic authority. Compatibility evidence MUST be a separately identified claim outside the Source Profile and MUST NOT replace user approval or binding readback.

## REQ-CPP-002: Processing Policy and Source Profile contracts are closed and complete

Every Processing Policy MUST conform to `contracts/schemas/processing-policy.schema.json`. It MUST name one vault, stable policy identity and exact version, lifecycle state, optional exact parent binding, explicit grants, local redaction obligations, provider-declared retention facts, and a nondelegated approval record. Its approval MUST bind the canonical policy payload and a separately validated, digest-bound vault-owner approval receipt present in trusted local readback. It MUST contain no credential value. A credential reference is usable only inside an exact boundary that names the operating-system credential store, authentication method, permitted provider, and permitted purposes.

The grants are exhaustive. They MUST explicitly enumerate Capture Adapter and provider identifiers, purposes, field and data-class grants, disclosure class, derived artifact kinds, destinations and exact endpoints, credential boundaries, input/output/runtime/cost budgets, retry attempts/elapsed time/cumulative cost, an ordered fallback chain, capabilities, non-authoritative semantic scope, and automation scope. Retention facts MUST bind data-use terms, region, and subprocessors. The non-configurable v1 ceiling is one retry against the same adapter and one pre-authorized fallback adapter; both share the aggregate budget. An empty collection grants nothing. A missing field, unknown field, wildcard, ambient default, inferred provider capability, or unbound fallback grants nothing.

Every Source Profile MUST conform to `contracts/schemas/source-profile.schema.json`. It MUST bind one vault and stable profile identity/version to exactly one Capture Source identity and claimed version, Capture Candidate schema identity/version/digest, template identity/version/import-artifact digest, URL-retention mode, Processing Policy identity/version/digest, capture-contract identity/version/digest, and user approval over the exact profile payload. The schema is closed; in particular, compatibility evidence, runtime observations, raw credentials, semantic claims, and inferred versions are forbidden fields.

`contracts/processing-policy-rules.json` is the complete machine-readable default-deny, monotonic-narrowing, and Source Profile binding table. `contracts/transitions/processing-policy-lifecycle.json` and `contracts/transitions/source-profile-lifecycle.json` are complete over their declared state-command products. Every row includes authority, preconditions, base references, records, filesystem effects, idempotency, terminal state, failure, and recovery.

## REQ-CPP-003: Every ungranted or stale request is denied before effect

A processing decision MUST validate its closed request and exact policy binding before inspecting permission. An intake decision MUST additionally validate and read back the active Source Profile before interpreting a Capture Candidate or evaluating any Processing Policy grant. The following precedence is binding; the first failure denies the request, emits a deterministic denial receipt, transmits zero bytes, creates no semantic operation, and has no vault filesystem effect.

| Order | Default-deny condition | Required result |
| --- | --- | --- |
| 1 | Malformed or unknown structured field | Reject at the closed-schema boundary |
| 2 | Source Profile absent, unapproved, delegated, stale, revoked, mismatched, or unreadable | Deny intake before candidate interpretation |
| 3 | Processing Policy inactive, version-mismatched, digest-mismatched, or unreadable | Deny processing |
| 3a | Processing Policy unapproved, approved by a non-owner, or delegated | Deny processing before any local or remote adapter effect |
| 4 | Vault, Capture Adapter, provider, or purpose not enumerated | Deny processing |
| 5 | Field, data class, disclosure class, or artifact not enumerated | Deny processing |
| 6 | Destination or exact endpoint not enumerated | Deny processing and transmit zero bytes |
| 7 | Credential reference, provider, purpose, store, or authentication method crosses its boundary | Deny without exposing credential material |
| 8 | Input, output, runtime, or cost budget exceeds its exact maximum | Deny before processing |
| 9 | Retry attempt, elapsed time, or cumulative retry cost exceeds its exact maximum | Terminate the chain and record denial |
| 10 | Fallback is absent from the ordered chain or does not match its exact provider, purpose, destination, and credential boundary | Deny; never silently substitute |
| 11 | Capability, semantic scope, or automation scope is not enumerated | Deny without side effect or semantic write |
| 12 | A required trusted, request/policy/payload/field-bound local redaction receipt is missing, or a destination-bound retention/data-use/region/subprocessor fact is missing; unknown retention lacks risk acknowledgment | Deny and transmit zero bytes |
| 13 | Hostile content requests shell, filesystem, browser, credential, arbitrary network, taxonomy-write, projection, or semantic-write action | Treat content as data and deny the requested action |

An exact numeric maximum is permitted; its first successor is denied. A fallback position is permitted only when every bound value matches the policy row at that position. Partial output, malformed output, provider error, quota exhaustion, or retry exhaustion cannot be promoted or silently routed elsewhere.

## REQ-CPP-004: Descendant policies narrow monotonically

A descendant Processing Policy MUST bind the exact parent identity, version, and recomputed digest. It MAY preserve or reduce permission and obligations; it MUST NOT add or widen any permission. The comparison is structural, explicit, and transitive. A one-off run is represented by a descendant policy and follows the same rule.

| Dimension | Preserve or reduce | Widening that MUST be denied |
| --- | --- | --- |
| Provider | Keep a subset of exact Capture Adapter and provider IDs | Add, replace, wildcard, or infer either identity |
| Purpose | Keep a subset of exact purposes | Add or substitute a purpose |
| Disclosure and fields | Remove fields or change `remote` to `local_only` while preserving required redaction | Add a field, weaken redaction, or change `local_only` to `remote` |
| Artifacts | Keep a subset of exact artifact kinds | Add a persisted, transmitted, or derived artifact |
| Destinations | Keep identical destination/provider/endpoint/retention tuples | Add or alter any tuple or endpoint |
| Credential boundary | Keep a credential reference with the same store, authentication method, and provider and a purpose subset | Add a credential reference, provider, purpose, store, or authentication method |
| Budget | Lower or preserve every numeric maximum | Raise any input, output, runtime, or cost maximum |
| Retry | Lower or preserve attempts, elapsed time, and cumulative cost | Raise any retry maximum |
| Fallback | Keep an order-preserving subset of identical fallback tuples | Add, reorder, or alter a fallback |
| Capabilities | Keep a subset | Add a capability |
| Semantic authority | Keep a subset of non-authoritative advisory scope | Add advisory scope or any truth-establishing authority |
| Automation scope | Keep a subset | Add Placement Automation Permission or Automation Grant scope |
| Redaction and retention | Preserve applicable redaction rules and trusted receipt binding; shorten known retention without changing data-use, region, subprocessors, status, or acknowledgment | Remove an applicable obligation or weaken or unbind a retention fact |

The conformance pack MUST include a preservation canary, a comprehensive narrowing canary, and one schema-valid attempted widening for every grant dimension. Every widening pair MUST be denied even if every other dimension narrows.

## REQ-CPP-005: Source Profile approval and readback precede intake

Only the nondelegated vault owner may approve a Source Profile. Approval binds the exact canonical profile payload excluding the approval record itself. Activation MUST publish the approval receipt and binding atomically or enter `recovery_required`; it MUST NOT expose a partially trusted binding.

Before every intake decision, the Capture Adapter MUST read back the Source Profile bytes and recompute the profile digest and approval-payload digest. It MUST compare the exact profile identity/version, approval receipt, Capture Source identity and claimed version, candidate schema identity/version/digest, template identity/version/import digest, URL-retention mode, Processing Policy identity/version/digest, and capture-contract identity/version/digest. A mismatch makes the binding stale and denies intake. Compatibility evidence may be consulted only as a separately bound claim after this permission check and cannot repair or satisfy a failed Source Profile binding.

Revocation stops future intake immediately. A Processing Policy change, capture-contract change, template change, candidate-schema change, Capture Source binding change, or approval-payload change makes the Source Profile stale until the vault owner approves a new version. No changed binding is silently rebased.

## REQ-CPP-006: Fixtures and machine evidence prove public closure

The conformance manifest MUST own exactly 50 `FIX-CPP-*` Conformance Fixtures under `conformance/scenarios/core-processing-policy/`. Classification is by identifier, path, subject kind, or scenario schema; any matching signal counts, so renaming one signal cannot hide an extra fixture. The set MUST include positive, negative, exact-boundary, stale-state, authority-denial, illegal-transition, policy-pair canary, hostile-content, and crash/recovery cases.

Every fixture MUST declare observable inputs, exact payload bytes, outputs, operations, closed receipts, filesystem and network effects, terminal state, and illegal-transition status. The reference validator MUST validate the Processing Policy, Source Profile, request, scenario, approval receipt, redaction receipt, decision receipt, rule-table, lifecycle, and recovery-report schemas; recompute policy, profile, approval-payload, receipt, fixture, and observable-result digests; verify trusted local readback bindings and all 50 oracles; prove every required default-deny code and policy-pair dimension; and validate `conformance/evidence/core-processing-policy-recovery-report.json`. It MUST NOT inspect private helper calls, class shape, or prose that no machine consumes.

Crash recovery MUST read the binding journal and exact approval receipt. A crash before approval publication discards unapproved staging and returns to `unbound`. A crash after approval publication finishes or preserves the exact approved binding only after digest readback. A crash after binding publication is idempotent. Missing, torn, mismatched, or ambiguous recovery evidence remains `recovery_required` or returns to `unbound`; it never authorizes intake.

## REQ-CPP-007: Issue number 8 is not reopened and no production code is added

Every `REQ-CPP-*` Traceability Record MUST bind accepted decision `DEC-008` exactly to [issue #8](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093) with use `input_without_reopening`. No other decision may be cited as a design input for this contract.

This contract, schemas, tables, Conformance Fixtures, conformance-only observer, validator assertions, traceability, machine evidence, and recovery report are specification and conformance artifacts only. They MUST NOT start or implement the mdplace Agent, Capture Adapter, Intelligence Adapter, Semantic Kernel, Control Channel, Vault Mutation Gate, Placement Evaluation, Taxonomy Evolution Cycle, Folder Projection, remote provider, or credential access. The validator MAY read declared package artifacts and emit a report on standard output. It MUST transmit zero bytes and MUST NOT write a vault, canonical operation, Source Profile binding, Processing Policy, receipt, or external file.

## Release gate

The package MUST fail validation unless all `REQ-CPP-*` requirements resolve; every structured object is closed; both lifecycle matrices are complete; `DEC-008` is exact and sole; exactly 50 manifest-owned fixtures pass; all default-deny reasons, exact boundaries, stale bindings, authority denials, hostile-content boundaries, policy-pair dimensions, and recovery outcomes are covered; compatibility evidence remains outside Source Profile; every receipt validates; and the fixture/result-bound recovery report recomputes without mismatch.
