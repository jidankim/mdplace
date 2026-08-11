# Normative Semantic Kernel operation and replay contract

This document is Normative Material for the `mdplace-spec/v1` Specification Package. The uppercase terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as requirement strength. Canonical mdplace terms are defined only in [`CONTEXT.md`](../../../CONTEXT.md).

The accepted reconciliation in [issue #2](https://github.com/jidankim/mdplace/issues/2#issuecomment-5012541174) is an input to this contract. This document does not reopen that decision. In particular, immutable `.op.json` operation records replace draft JSONL history, the Semantic Kernel is the sole semantic writer, and Folder Projection, frontmatter, adapters, indexes, and caches remain derived or advisory consumers.

## REQ-SK-001: The canonical operation envelope is closed

Every accepted semantic append MUST emit exactly one immutable canonical operation conforming to `contracts/schemas/semantic-operation.schema.json`. The record MUST carry stable operation identity, schema version, command identity, actor authority, declared operation kind, ordered base references, deterministic ordering material, a closed payload, idempotency material, ordered preconditions, and its closure receipt. Unknown fields, unknown operation kinds, unsupported schema versions, malformed records, torn records, and noncanonical JSON bytes MUST be rejected.

Canonical JSON is UTF-8 JSON with object keys sorted by Unicode code-point order at every depth, arrays retained in declared order, no insignificant whitespace, and one trailing line feed. A closure receipt binds the command, operation, sequence, outcome, and resulting semantic-state digest. Operation records are named `<operation_id>.op.json`; their identity never derives from a path, projection, cache row, or wall-clock timestamp.

## REQ-SK-002: Compare-and-append is serialized and fail-closed

The Semantic Kernel MUST serialize append attempts. A new command is accepted only from an authorized actor, against the exact current semantic head, with contiguous ordering material, a recognized operation kind, satisfied preconditions, and a new idempotency key. Success emits one canonical operation and one matching closure receipt. It MUST NOT emit a partial record, a second operation, or an independent semantic filesystem effect.

Rejection precedence is malformed or noncanonical input; unsupported schema or unknown operation kind; unauthorized actor; duplicate-incompatible idempotency material; stale or future base; noncontiguous ordering; failed precondition or illegal semantic transition. Every rejection is deterministic, preserves the semantic head and state, emits a Semantic Rejection receipt, and creates no canonical operation. A compatible duplicate returns the original receipt and creates no new operation even when the current head has advanced.

## REQ-SK-003: Replay, snapshots, ordering, and views are deterministic

The first base reference MUST bind the exact semantic-head sequence, operation identity, and state digest. Later ordered base references MAY bind immutable input artifacts by identifier and digest. Ordering uses the monotonic sequence, predecessor operation identity, and stable sort key; wall-clock arrival order and filesystem enumeration order have no authority.

Replay MUST validate canonical bytes, schemas, operation kinds, bases, ordering, preconditions, closure receipts, and idempotency before applying an operation. It MUST reproduce the same semantic state and Semantic Snapshot from the same canonical operation set and bound base inputs. A Semantic Snapshot MUST bind its head, state digest, and complete ordered state entries. Replay from a valid snapshot plus its suffix MUST equal full replay. A stale or mismatched snapshot is rejected rather than trusted.

`contracts/semantic-operation-kinds.json` is the closed recognized-kind registry for this conformance foundation. A later Package Amendment MAY add a schema-bound kind without changing existing kinds. The recognized `compatibility_marker` kind has an explicit no-state replay effect and demonstrates forward compatibility; an unregistered kind is never skipped. Folder Projection, projections, frontmatter, adapters, indexes, and caches are rebuildable consumers and MUST NOT establish or append semantic truth.

## REQ-SK-004: Stateful fixtures observe complete closure outcomes

The conformance manifest MUST own exactly 30 `FIX-SK-*` stateful scenarios. Together they MUST cover valid append and replay, exact and stale bases, compatible and incompatible duplicate commands, unknown operations, malformed and torn records, noncanonical records, snapshot equivalence, deterministic rebuild, recognized forward-compatible records, authority denial, illegal transitions, and crash recovery.

Every scenario oracle MUST expose its accepted append or deterministic rejection, canonical record identity or `none`, receipt, semantic state, Semantic Snapshot or replay result when applicable, rebuilt view when applicable, filesystem effects, terminal state, and illegal-transition result. Scenario inputs MUST be explicit; a validator MUST NOT infer actor authority, base state, ordering, idempotency, filesystem state, or recovery state from ambient process context.

## REQ-SK-005: Validation and evidence bind public behavior

The reference validator MUST validate operation and scenario schemas, the complete Semantic Kernel lifecycle table, exactly 30 manifest entries, all observable fixture dimensions, stable traceability, and `conformance/evidence/semantic-kernel-recovery-report.json`. It MUST assert public inputs, outputs, operations, receipts, filesystem effects, ordering, idempotency, Semantic Snapshots, replay, rebuild, and illegal transitions without inspecting a private implementation.

Machine evidence MUST bind the scenario count, replay and snapshot equivalence, deterministic rebuild, crash outcomes, and semantic-write denials. Missing, extra, stale, malformed, or digest-incompatible evidence is non-pass.

## REQ-SK-006: The accepted reconciliation remains an input

Traceability MUST bind every REQ-SK requirement to accepted decision `DEC-002`, whose exact source is [issue #2](https://github.com/jidankim/mdplace/issues/2#issuecomment-5012541174) and whose use is `input_without_reopening`. This contract MUST NOT restore deprecated JSONL canonical history, path-derived truth, Unknown-like categories, multiple primary placements, coarse remote-processing authority, or generic taxonomy mutation authority.

## REQ-SK-007: Artifacts are specification and conformance only

This contract, its schemas, registry, lifecycle table, stateful Conformance Fixtures, conformance-only observer, traceability, and machine evidence MUST NOT implement or invoke production mdplace behavior. They MUST NOT start the mdplace Agent, host a Semantic Kernel, use the Control Channel, call the Vault Mutation Gate, mutate a vault, or grant semantic authority to a Capture Adapter, Intelligence Adapter, Folder Projection, projection, frontmatter bridge, index, or cache.

The validator MAY read declared Specification Package artifacts and emit its deterministic validation report on standard output. It MUST NOT write canonical operations, Semantic Snapshots, rebuilt views, receipts, or external files.

## Semantic Kernel lifecycle

`contracts/transitions/semantic-kernel-lifecycle.json` is complete over `ready` and `recovery_required` for `append_operation` and `recover_operation`. Append is legal only while ready. Recovery is legal only while recovery is required. Every denied row is a first-class illegal transition with unchanged semantic state and no canonical write.

## Release gate

The package MUST fail validation unless the operation envelope and supporting registries are closed, the lifecycle matrix is complete, `DEC-002` is exact, exactly 30 stateful scenarios are manifest-owned and passing, every denied lifecycle row has an illegal-transition fixture, replay and snapshot evidence agree, rebuild evidence is deterministic, the recovery report is schema-valid, and all adapter, projection, frontmatter, and cache write attempts are denied without a semantic write.
