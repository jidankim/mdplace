# Vault Mutation Gate contract

This Normative Material defines the single filesystem-mutation authority inside one configured vault. The Vault Mutation Gate accepts only a closed Authorized Mutation Plan for Capture Promotion or Folder Projection, proves its descriptor-bound preconditions, journals and applies the exact physical effect, and returns an Operation Receipt. It consumes accepted semantic and placement inputs but cannot create, infer, accept, revise, or retract a Placement Outcome, Category Tree, Captured Tab Note Identity, Processing Policy, or other semantic truth. This contract and its conformance executable specify behavior only; they do not implement production mdplace or mutate a vault.

## REQ-VMG-001: Stable requirements use canonical mutation vocabulary

Every Vault Mutation Gate requirement, schema, lifecycle row, Conformance Fixture, recovery row, and evidence record uses the canonical terms Vault Mutation Gate, Authorized Mutation Plan, Descriptor Identity, Operation Receipt, Mutation Journal, Vault Mutation Recovery, Terminal Manual Repair, Capture Promotion, Folder Projection, and Specification Package. Requirement identifiers are stable `REQ-VMG-001` through `REQ-VMG-010`.

## REQ-VMG-002: The Authorized Mutation Plan is closed and exact

The closed `authorized-mutation-plan.schema.json` binds one plan identity and version, vault and trusted-root identities, caller authority, exclusive ownership receipt, exactly one declared operation, source and target components, immutable input digests, expected precondition and post-operation Descriptor Identities, placement outcome reference, durability policy, idempotency key, and one recovery intent. Unknown or missing fields, unknown operations, absolute or empty components, dot or parent traversal, embedded separators, undeclared sources or targets, unauthorized callers, stale ownership, stale plan state, incompatible idempotency reuse, collision, malformed digest, stale content hash, or identity mismatch deny before unsafe mutation.

The closed v1 operations are `promote_capture`, `move_projection`, `create_directory`, `remove_empty_owned_directory`, and `write_managed_frontmatter`. Capture Adapter may submit only Capture Promotion operations. Folder Projection may submit only projection operations. Foreground recovery may execute only the recovery action already declared by the same plan. The plan carries an accepted placement outcome reference as an input; the gate never creates or changes it.

## REQ-VMG-003: Every authoritative read is descriptor-relative and same-handle

Every authoritative source and target resolution starts by opening the configured trusted vault root as a directory descriptor. Each plan component is resolved from the preceding descriptor with descriptor-relative `openat` and `O_NOFOLLOW`. The probe rejects a symlink at any component, a component outside the trusted root, or any resolution that cannot preserve descriptor ancestry.

The executable conformance-probe contract performs this exact sequence: open trusted root; resolve each component descriptor-relatively; capture `fstat`; read and compute SHA-256 through that same open handle; rerun `fstat`; compare device, inode, size, and content hash with the Authorized Mutation Plan; perform only the declared operation through retained descriptors; emit and durably publish the exact operation echo; read back through the retained post-operation descriptor; and bind the Operation Receipt and readback to the identical expected tuple. No validated pathname may be reopened as authority for validation, mutation, receipt, recovery, or readback. Pathname observations may be reported as non-authoritative diagnostics only.

## REQ-VMG-004: Preconditions receipt echo and readback bind identical identity

A precondition passes only when the first and second `fstat` device, inode, and size remain equal and the same-handle content SHA-256 equals the Authorized Mutation Plan. The Operation Receipt must echo the same plan, operation, source, target, caller, ownership, idempotency key, and precondition tuple. Post-operation readback must match the plan's expected result tuple through the retained descriptor. Identity drift, size drift, stale hash, changed metadata, incomplete echo, malformed receipt, digest mismatch, or readback mismatch is an observable non-success requiring Vault Mutation Recovery. A success-looking console string never overrides parsed plan, journal, receipt, echo, digest, or readback failure.

## REQ-VMG-005: Exclusive ownership and durability precede effects

Only the current persistent mdplace Agent or foreground recovery core holding the exact current Exclusive Writer Lock receipt may enter prepare. The Mutation Journal binds that receipt, the complete Authorized Mutation Plan digest, the Work Item and Work Lease when scheduled, and the exact prior journal head. Ownership loss before commit blocks further mutation and enters recovery.

Folder Projection apply is additionally serialized per vault. Once one projection plan enters prepare, every different projection plan is denied until the active plan commits, completes exact rollback, or remains bound to its own recovery; the Agent's Exclusive Writer Lock cannot substitute for this cross-plan guard.

The durability order is strict: publish and sync prepared journal intent; sync the journal directory; validate all descriptor-bound preconditions; publish and sync the validated journal entry; perform the single declared data or metadata operation; sync affected file data; sync affected metadata and parent directories; publish and sync the Operation Receipt and its echo; perform retained-descriptor readback; publish and sync the readback entry; publish and sync commit evidence; and sync the journal directory. A later event cannot substitute for a missing or unsynced predecessor.

## REQ-VMG-006: Mutation lifecycle and idempotency are complete

The complete matrix in `contracts/transitions/vault-mutation-gate-lifecycle.json` covers every state-command pair for `prepare`, `validate`, `mutate`, `record_receipt`, `verify_readback`, `commit`, `resume`, `rollback`, `compensate`, and `halt_manual_repair`. The states are `authorized`, `prepared`, `validated`, `mutated`, `receipt_recorded`, `readback_verified`, `committed`, `recovery_required`, `rolled_back`, `compensated`, and `terminal_manual_repair`.

An idempotency key is compatible only with the same plan digest, operation, immutable inputs, ownership, and recovery intent. A retry of a committed compatible plan returns the original Operation Receipt and appends no effect. A nonterminal compatible retry enters Vault Mutation Recovery. Reuse with different bindings is denied. Cancellation never invents a terminal result: before mutation it preserves zero unsafe effects; after mutation it durably enters recovery.

## REQ-VMG-007: Recovery is deterministic at every crash boundary

The crash matrix enumerates the boundaries immediately before and after prepared journal publication, validation journal publication, data mutation, metadata sync, Operation Receipt publication, receipt echo publication, retained-descriptor readback, and commit publication. For each boundary it specifies the durable prefix, possible physical effect, required observations, allowed outcomes, prohibited inference, and the complete cancellation, cancel-and-resume, restart, and repeated-interruption mode set. Each mode at every boundary deterministically resumes, performs an exact safe rollback, executes the plan's explicit compensation, or halts in Terminal Manual Repair.

Resume requires the exact plan, ownership, Descriptor Identity, durable journal prefix, receipt and echo if present, and the next unapplied effect. Exact rollback is permitted only when the plan declares it, every reverse precondition still matches through retained or newly trusted-root-resolved descriptors, and no later dependency exists. Compensation is permitted only when the plan names the exact compensating plan identity and its separately authorized effect. Unknown completion, drift, missing evidence, exhausted recovery interruption budget, or unsafe reverse precondition reaches Terminal Manual Repair. Recovery never guesses, duplicates an effect, reports success from console text, or treats a pathname observation as authority.

## REQ-VMG-008: Public fixtures prove safe and unsafe boundaries

The Conformance Manifest owns exactly 88 `FIX-VMG-*` fixtures: 24 named contract cases and 64 boundary-mode recovery cases. They cover valid Capture Promotion and Folder Projection, exact tuple and idempotency boundaries, symlink swap, pathname swap, traversal, collision, ownership drift, unauthorized caller, undeclared operation, malformed plan, stale plan state, stale hash, device or inode drift, size drift, incomplete journal, receipt-echo mismatch, readback mismatch, misleading success output, safe resume, exact rollback, explicit compensation, and the complete crash/recovery matrix including cancellation and repeated interruptions.

Each fixture asserts only observable inputs, outputs, ordered operations, receipts, filesystem effects, terminal state, and illegal-transition status. Unsafe fixtures require zero unsafe filesystem effects and no pathname reopening as authority. The conformance probe models descriptor operations and deterministic bytes in a closed virtual vault; it neither touches a real vault nor asserts private production structure.

## REQ-VMG-009: Traceability and machine evidence are complete

Every `REQ-VMG-*` requirement has exactly one Traceability Record binding the accepted issue #7 and issue #26 decision inputs, canonical terms, normative anchor, schema or transition references, positive and negative fixtures, acceptance gate, scope, recovery report, and generated validation report. The closed `vault-mutation-recovery-report.schema.json` binds all 16 crash boundaries, four interruption modes, fixture results, distinct recovered, rolled-back, compensated, recovery-required, denied, and Terminal Manual Repair outcomes, and exact artifact digests. Its terminal repair section identifies the unresolved evidence, prohibited inference, and the exact new authorization required before work may continue. Missing, stale, unsupported, inconclusive, or digest-mismatched evidence cannot pass.

## REQ-VMG-010: Accepted decisions remain inputs and artifacts remain non-production

The accepted Folder Projection decision at [issue #7](https://github.com/jidankim/mdplace/issues/7#issuecomment-5181591072) and component boundary at [issue #26](https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948) are normative decision inputs with `input_without_reopening` status. This contract specializes their exact-plan, single-gate, ownership, journal, receipt, recovery, and semantic-denial boundaries without changing placement or projection decisions.

Issue #35 adds only Normative Material, closed schemas, transition and crash tables, Conformance Fixtures, a conformance-only descriptor probe, validator assertions, traceability, and machine evidence. It implements no production mdplace code, opens no real trusted vault root, executes no real `openat`, changes no filesystem object outside isolated fixture data, and performs no external write.
