# Work Journal, Scheduler, mdplace Agent, and Control Channel contract

This Normative Material defines the non-semantic control plane for one configured vault. It consumes current Semantic Kernel truth, schedules bounded work, and recovers interrupted operations. It cannot establish semantic truth, accept a Placement Outcome, change the Category Tree, authorize Folder Projection semantics, append an OperationCommit, or bypass the Vault Mutation Gate. The contracts and conformance executables in this ticket specify behavior only; they are not production mdplace code.

## REQ-CP-001: Operational state never establishes semantic truth

The Work Journal, Scheduler, mdplace Agent lifecycle, Readiness Gate, Work Lease, Control Channel, Control Command, Child Work Invocation, retry state, cancellation state, queue state, and Work Recovery are operational. Every closed control-plane document declares `semantic_authority` as `none`, and every stateful Conformance Fixture observes an unchanged Semantic Kernel state digest. A control-plane request to establish, alter, or override semantic truth is denied and may only be resubmitted as a command to the Semantic Kernel under its own authority, exact bases, and preconditions.

The control plane may read current semantic references as inputs and may schedule a Semantic Kernel command, but neither successful scheduling nor recovery is semantic acceptance. A Work Journal receipt is never an OperationCommit or proof that an intended semantic effect occurred.

## REQ-CP-002: Work Journal and Scheduler records are closed durable and bounded

The Work Journal is durable before a Work Item becomes eligible. Each Work Item binds one stable identity, version, kind, idempotency key, exact input digest, ordered dependencies, queue state, budget, retry count, optional Work Lease, optional durable cancellation, and optional terminal result. Unknown fields, unbound work versions, duplicate live ownership, malformed digests, or budgets outside the schema are rejected before queue mutation.

The v1 public limits are at most three total attempts (an initial attempt plus a retry ceiling of two), 900,000 milliseconds wall time per attempt, 10,485,760 output bytes, one Child Work Invocation per Work Item, eight concurrently executing Work Items, four concurrent Child Work Invocations, a 300-tick Work Lease, and two recovery interruptions before terminal failure. The retry delay schedule is exactly 1,000 then 5,000 milliseconds. A policy or Work Item may tighten any limit but cannot exceed it. Exhausted time, output, process, concurrency, attempt, or recovery budgets fail closed.

The Scheduler reads only committed Work Journal state. A dispatch first publishes a version-bound Work Lease receipt and only then acknowledges dequeue. No in-memory queue, child-process state, socket response, cache, or derived view may substitute for the committed Work Journal record.

## REQ-CP-003: Queue retry cancellation and resume are version-bound

Enqueue is idempotent only when the same idempotency key resolves to the same Work Item identity and exact input digest. A different binding is rejected. Dispatch requires a current queued or retry-eligible Work Item version, current readiness, and the current Exclusive Writer Lock. Exactly one live Work Lease owns a Work Item. A stale Work Item version, stale Work Lease, duplicate owner, or expired base is rejected without changing state.

A retryable failure durably increments the retry count and records the next bounded delay before the Work Item becomes eligible. Reaching the retry ceiling produces terminal failure; any retry beyond it is an illegal transition. Cancellation before dispatch or during execution is durable, takes precedence over new dispatch and retry, and remains cancelled after restart. Cancellation during execution first records the cancellation and then terminates Child Work Invocation capability. Resume requires an authenticated vault owner, the exact cancelled version, and remaining resume budget. V1 allows one resume; it appends a resume receipt, increments the Work Item version, and returns the item to queued state without erasing cancellation history.

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

The Readiness Gate fails closed when the Work Journal, a required semantic dependency, or the Exclusive Writer Lock is unavailable. A blocked Agent exposes the durable reason through status and doctor surfaces but accepts no new work. The complete Agent, readiness, and writer matrices are `contracts/transitions/agent-lifecycle.json`, `readiness-lifecycle.json`, and `exclusive-writer-lifecycle.json`.

## REQ-CP-005: The Control Channel is local authenticated bounded and stale-safe

The Control Channel is one Unix domain socket in a same-user runtime directory with directory mode `0700` and socket mode `0600`. It is bound to one vault identity, verifies macOS peer credentials against the effective user, and accepts no TCP, loopback HTTP, cross-user, cross-vault, remote, or ambient endpoint. The protocol version and current command version are explicit.

One request is limited to 65,536 bytes, one response to 1,048,576 bytes, five seconds, and eight concurrent requests. A Control Command binds its vault, authenticated peer, command identity, idempotency key, payload digest, expected command version, and exact Work Item or semantic base references when applicable. Nonlocal, unauthenticated, wrong-vault, oversized, timed-out, over-concurrency, unsupported-version, and stale commands are denied before dispatch. Successful local authentication admits a request but grants no semantic or Vault Mutation Gate authority. The complete matrix is `contracts/transitions/control-channel-lifecycle.json`.

## REQ-CP-006: Child work is isolated and disposable

Every Child Work Invocation is a fresh process for one Work Item. It receives only a policy-authorized Processing Envelope, one output schema, bounded scratch storage, a named credential reference, an exact endpoint allowlist, and the Work Item budget. It receives no vault, repository instructions, shell, browser, ambient environment, arbitrary network, mutable queue, Work Journal, Semantic Kernel writer, or Vault Mutation Gate capability.

A child crash, timeout, malformed output, budget exhaustion, attempted capability use, or attempted semantic write terminates that invocation. Only a schema-valid non-authoritative Intelligence Proposal and an authenticated completion receipt may affect operational completion. Absence or ambiguity of the receipt invokes Work Recovery and never represents success.

## REQ-CP-007: Work Recovery is default-deny and receipt-driven

Work Recovery reads the exact Work Item version, Work Lease, idempotency binding, retry and resume budgets, cancellation record, completion receipt, mutation plan and filesystem observations when relevant, current Exclusive Writer Lock epoch, and current semantic dependency references. It must not infer completion from process absence, queue absence, a child output file, a derived view, or caller assertion.

Committed enqueue survives process loss. A leased or executing item without an authenticated terminal receipt remains recoverable within its existing budgets. Completed work is never repeated after restart. Cancelled work remains cancelled. Unknown physical completion is blocked for explicit reconciliation. Repeated interruption consumes the declared recovery budget and cannot create duplicate work. The closed `contracts/control-plane/recovery-matrix.json` supplies every recovery decision, and the digest-bound `conformance/evidence/control-plane-recovery-report.json` records the fixture and observable-result bindings.

## REQ-CP-008: Exactly twenty-five stateful scenarios prove the public boundary

The Conformance Manifest owns exactly 25 stateful `CP-001` through `CP-025` scenarios under `conformance/scenarios/control-plane/`, in the order listed by issue #34: durable enqueue; receipt-before-ack dequeue; recoverable lease; first retry; retry-ceiling failure; retry-beyond-ceiling denial; pre-dispatch cancellation; in-execution cancellation; cancellation after restart; authorized bounded resume; queued restart; in-flight crash; completed restart; idempotent duplicate enqueue; single durable concurrent owner; stale Work Item version; stale Work Lease; stale Control Command; three fail-closed Readiness Gate cases; authenticated local access; unauthenticated or nonlocal denial; persistent writer acquisition and retention; and competing-writer denial.

The scenarios include positive, negative, exact-boundary, stale-state, authority-denial, illegal-transition, crash/recovery, cancellation, restart, resume, and repeated-interruption coverage. Assertions observe only declared inputs, outputs, ordered operations, receipts, filesystem effects, unchanged semantic-state digest, terminal state, and illegal-transition status. They never inspect a private helper, thread, database row, or implementation strategy.

## REQ-CP-009: Accepted component and lifecycle decisions remain inputs

The accepted component/process boundary at [issue #26](https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948) and packaging/process-lifecycle boundary at [issue #28](https://github.com/jidankim/mdplace/issues/28#issuecomment-5196131324) are normative decision inputs. This contract specializes their one-Agent topology, operational Work Journal, isolated child process, Unix-domain Control Channel, LaunchAgent supervision, startup ordering, and exclusive-writer recovery rules without reopening either decision.

## REQ-CP-010: This package contains no production control plane

The issue #34 closure consists only of Normative Material, closed schemas, transition and recovery tables, Conformance Fixtures, conformance-only observers and validators, traceability, and machine-readable evidence. It does not create a production Work Journal, Scheduler, mdplace Agent, Control Channel, listener, child-process host, lock manager, Semantic Kernel writer, or Vault Mutation Gate implementation, and it performs no vault mutation or service installation.
