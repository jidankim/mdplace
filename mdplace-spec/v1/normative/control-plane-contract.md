# Work Journal, Scheduler, mdplace Agent, and Control Channel contract

This Normative Material defines the non-semantic control plane for one configured vault. It consumes current Semantic Kernel truth, schedules bounded work, and recovers interrupted operations. It cannot establish semantic truth, accept a Placement Outcome, change the Category Tree, authorize Folder Projection semantics, append an OperationCommit, or bypass the Vault Mutation Gate. The contracts and conformance executables in this ticket specify behavior only; they are not production mdplace code.

## REQ-CP-001: Operational state never establishes semantic truth

The Work Journal, Scheduler, mdplace Agent lifecycle, Readiness Gate, Work Lease, Control Channel, Control Command, Child Work Invocation, retry state, cancellation state, queue state, and Work Recovery are operational. Every closed control-plane document declares `semantic_authority` as `none`, and every stateful Conformance Fixture observes an unchanged Semantic Kernel state digest. A control-plane request to establish, alter, or override semantic truth is denied and may only be resubmitted as a command to the Semantic Kernel under its own authority, exact bases, and preconditions.

The control plane may read current semantic references as inputs and may schedule a Semantic Kernel command, but neither successful scheduling nor recovery is semantic acceptance. A Work Journal receipt is never an OperationCommit or proof that an intended semantic effect occurred.

## REQ-CP-002: Work Journal and Scheduler records are closed durable and bounded

The Work Journal is durable before a Work Item becomes eligible. Each Work Item binds one stable identity, version, kind, idempotency key, exact input digest, versioned and digest-bound dependencies, queue state, budget, retry count, durable retry-eligibility tick, recovery-interruption count, optional Work Lease, optional durable cancellation, and optional terminal result. Every Work Lease repeats the exact Work Item identity and version, owner, acquired and expiry ticks, and active, revoked, or expired status. Every terminal result repeats the exact Work Item version, lease when applicable, journal sequence, signer, output or failure, signature scheme, trusted signing-key identity, and authenticated signature digest. A terminal result is accepted only after keyed verification against trusted signer material; recomputing an unkeyed digest or naming another Agent cannot authenticate it. Unknown fields, duplicate identities or idempotency bindings, contradictory lifecycle ownership, malformed digests, invalid authentication, or budgets outside the schema are rejected before queue mutation.

The v1 public limits are at most three total attempts (an initial attempt plus a retry ceiling of two), 900,000 milliseconds wall time per attempt, 10,485,760 output bytes, one Child Work Invocation per Work Item, eight concurrently executing Work Items, four concurrent Child Work Invocations, a 300-tick Work Lease, and two recovery interruptions before terminal failure. The retry delay schedule is exactly 1,000 then 5,000 milliseconds. A policy or Work Item may tighten any limit but cannot exceed it. Exhausted time, output, process, concurrency, attempt, or recovery budgets fail closed.

The Scheduler reads only committed Work Journal state. A dispatch first publishes a version-bound Work Lease receipt and only then acknowledges dequeue. No in-memory queue, child-process state, socket response, cache, or derived view may substitute for the committed Work Journal record.

## REQ-CP-003: Queue retry cancellation and resume are version-bound

Enqueue is idempotent only when the same idempotency key resolves to the same Work Item identity and exact input digest. A different binding is rejected. Dispatch requires a current queued or retry-eligible Work Item version, current readiness, the current Exclusive Writer Lock, and a current tick at or after the durable retry-eligibility tick. Exactly one live Work Lease owns a Work Item. A failure or acknowledgement requires the exact active lease and a current tick strictly before its expiry. A stale Work Item version, revoked or expired Work Lease, early retry, duplicate owner, or expired base is rejected without changing state.

A retryable failure durably increments the retry count and records the next bounded delay before the Work Item becomes eligible. A failure or interrupted execution whose retry count already equals the retry ceiling appends an authenticated terminal-failure result; any later retry is an illegal transition. Cancellation before dispatch or during execution is durable, takes precedence over new dispatch and retry, and remains cancelled after restart. Repeating cancellation against the exact cancelled version returns the original cancellation receipt without another mutation. Cancellation during execution first records the cancellation and then terminates Child Work Invocation capability. Resume requires an authenticated vault owner, the exact cancelled version, and remaining resume budget. V1 allows one resume; it appends a resume receipt, increments the Work Item version, and returns the item to queued state without erasing cancellation history.

The complete matrices in `contracts/transitions/work-queue-lifecycle.json`, `retry-lifecycle.json`, and `cancellation-lifecycle.json` enumerate every legal and illegal state-command pair with actor authority, preconditions, bases, records, filesystem effects, idempotency, terminal result, failure result, and recovery.

## REQ-CP-004: One persistent mdplace Agent becomes ready in strict order

One persistent per-vault mdplace Agent is supervised by the user's LaunchAgent. Foreground recovery hosts the same Agent core and must acquire the same Exclusive Writer Lock. A competing Agent is denied; lock possession is retained and revalidated during readiness, wake, and work claim. Lock loss stops new claims and moves the Agent to blocked recovery.

Startup and restart execute these gates in order before accepting work:

1. acquire the Exclusive Writer Lock;
2. verify the configured vault and bound filesystem profile;
3. validate and replay canonical Semantic Kernel state;
4. validate executable and schema compatibility;
5. replay or rebuild required disposable views;
6. reconcile the Work Journal with exact mutation plans, manifests, and receipts;
7. open the Control Channel and publish ready status.

The Agent may enter `ready` only when the keyed writer receipt names the persistent Agent, vault, retained token, prior epoch, and exact next epoch; all seven gate observations occur in the canonical order with keyed receipts binding the Agent, vault, gate, ordinal, verdict, observation digest, and preceding writer-or-gate signature; and the Control Channel is open. A patterned receipt identifier is not evidence. Restart and Work Recovery repeat these checks; a competing writer, stale journal head, stale epoch, missing or forged receipt, broken receipt chain, reordered gate, or failed gate leaves the Agent blocked. A blocked Agent exposes the durable reason through status and doctor surfaces but accepts no new work. The complete Agent, readiness, and writer matrices are `contracts/transitions/agent-lifecycle.json`, `readiness-lifecycle.json`, and `exclusive-writer-lifecycle.json`.

## REQ-CP-005: The Control Channel is local authenticated bounded and stale-safe

The Control Channel is one Unix domain socket in a same-user runtime directory with directory mode `0700` and socket mode `0600`. It is bound to one vault identity, verifies macOS peer credentials against the effective user, and accepts no TCP, loopback HTTP, cross-user, cross-vault, remote, or ambient endpoint. The protocol version and current command version are explicit.

One request is limited to 65,536 bytes, one response to 1,048,576 bytes, five seconds, and eight concurrent requests. A Control Command binds its vault, authenticated peer, command identity, idempotency key, payload digest, expected command version, and exact Work Item or semantic base references when applicable. Nonlocal, unauthenticated, wrong-vault, oversized, timed-out, over-concurrency, unsupported-version, and stale commands are denied before dispatch. Successful local authentication admits a request but grants no semantic or Vault Mutation Gate authority. The complete matrix is `contracts/transitions/control-channel-lifecycle.json`.

## REQ-CP-006: Child work is isolated and disposable

Every Child Work Invocation is a fresh process for one Work Item. It receives only a policy-authorized Processing Envelope, one output schema, bounded scratch storage, a named credential reference, an exact endpoint allowlist, and the Work Item budget. It receives no vault, repository instructions, shell, browser, ambient environment, arbitrary network, mutable queue, Work Journal, Semantic Kernel writer, or Vault Mutation Gate capability.

A child crash, timeout, malformed output, budget exhaustion, attempted capability use, or attempted semantic write terminates that invocation. The closed `contracts/schemas/child-work-invocation.schema.json` contract binds the persistent Agent, exact Work Item, lease, journal head, Processing Envelope, policy version and digest, scratch boundary, credential reference without material, endpoint allowlist, budgets, denied capabilities, schema-valid non-authoritative output, fresh-process lifecycle, and completion receipt. Only a keyed receipt whose trusted signer is the bound persistent Agent and whose signature binds the exact invocation, work, version, lease, journal sequence, and output digest may affect operational completion. Absence, mismatch, competing signer, forgery, or ambiguity invokes Work Recovery and never represents success.

## REQ-CP-007: Work Recovery is default-deny and receipt-driven

Work Recovery reads the exact Work Journal head, Work Item version, Work Lease identity, status and ticks, idempotency binding, retry and resume budgets, durable recovery-interruption count, cancellation record, authenticated completion receipt, mutation plan and filesystem observations when relevant, current Exclusive Writer Lock receipt and epoch, ordered Readiness Gate receipts, and versioned semantic dependency references. It must not infer completion from process absence, queue absence, a child output file, a derived view, a Boolean completion claim, or another caller assertion.

Committed enqueue survives process loss. A leased or executing item without an authenticated terminal receipt remains recoverable only after its exact lease is expired or revoked and within existing retry and recovery budgets. Recovering interrupted execution consumes the same retry budget as an ordinary retry. Completed work is never repeated after restart. Cancelled work remains cancelled. Unknown physical completion is blocked for explicit reconciliation. Repeated interruption must advance the durable counter by exactly one and cannot create duplicate work; a third interruption, or interrupted execution with an exhausted retry ceiling, atomically appends an authenticated terminal-failure result and durable terminal record. The closed `contracts/control-plane/recovery-matrix.json` supplies exactly `RC-CP-001` through `RC-CP-015`; the digest-bound `conformance/evidence/control-plane-recovery-report.json` records those cases, every scenario result, and the validator-owned denied rows in all seven control-plane transition tables.

The v1 conformance executables use HMAC-SHA-256 with the fixed `signer-key:primary-001` test trust anchor solely to make authentication deterministic and independently testable. That key is Conformance Fixture material, not a production key or storage design. A production implementation must provision equivalent trusted signer material outside untrusted receipt fields and may choose another authenticated-signature mechanism while preserving every bound field and rejection behavior above.

## REQ-CP-008: Exactly twenty-five stateful scenarios prove the public boundary

The Conformance Manifest owns exactly 25 stateful `CP-001` through `CP-025` scenarios under `conformance/scenarios/control-plane/`, in the order listed by issue #34: durable enqueue; receipt-before-ack dequeue; recoverable lease; first retry; retry-ceiling failure; retry-beyond-ceiling denial; pre-dispatch cancellation; in-execution cancellation; cancellation after restart; authorized bounded resume; queued restart; in-flight crash; completed restart; idempotent duplicate enqueue; single durable concurrent owner; stale Work Item version; stale Work Lease; stale Control Command; three fail-closed Readiness Gate cases; authenticated local access; unauthenticated or nonlocal denial; persistent writer acquisition and retention; and competing-writer denial.

The scenarios include positive, negative, exact-boundary, stale-state, authority-denial, illegal-transition, crash/recovery, cancellation, restart, resume, and repeated-interruption coverage. Separate artifact fixtures prove valid isolated Child Work Invocation output, denied capability escalation, forged completion-receipt rejection, and rejection of a receipt naming a competing signer; they do not add stateful `CP-*` scenarios. Assertions observe only declared inputs, outputs, ordered operations, receipts, filesystem effects, unchanged semantic-state digest, terminal state, and illegal-transition status. They never inspect a private helper, thread, database row, or implementation strategy.

## REQ-CP-009: Accepted component and lifecycle decisions remain inputs

The accepted component/process boundary at [issue #26](https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948) and packaging/process-lifecycle boundary at [issue #28](https://github.com/jidankim/mdplace/issues/28#issuecomment-5196131324) are normative decision inputs. This contract specializes their one-Agent topology, operational Work Journal, isolated child process, Unix-domain Control Channel, LaunchAgent supervision, startup ordering, and exclusive-writer recovery rules without reopening either decision.

## REQ-CP-010: This package contains no production control plane

The issue #34 closure consists only of Normative Material, closed schemas, transition and recovery tables, Conformance Fixtures, conformance-only observers and validators, traceability, and machine-readable evidence. It does not create a production Work Journal, Scheduler, mdplace Agent, Control Channel, listener, child-process host, lock manager, Semantic Kernel writer, or Vault Mutation Gate implementation, and it performs no vault mutation or service installation.
