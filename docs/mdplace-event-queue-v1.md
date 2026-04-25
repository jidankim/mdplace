Yes, this is a **valid and important design question**. The questioner is not confused. They are identifying a real missing layer: the previous design described **what state exists** and **what invariants must hold**, but not enough about **how events, proposals, projections, and filesystem mutations flow through the system**.

The core issue is that the word “event” was doing too much work. Some things are merely received inputs, some are proposed semantic changes, some are canonical domain events, some are projection jobs, and some are dangerous filesystem mutations. Those should not share one vague queue.

# What this question reveals

The design needs an explicit **post-ingestion processing model**.

Previously, the architecture had:

```text
Markdown files
Semantic ledger
Placement assertions
Hypotheses
Evidence
Review tasks
Projection runs
Validation runs
Path/category aliases
```

But it did not fully specify:

```text
How do raw inputs become canonical?
Who is allowed to write to the ledger?
When is SQLite updated?
What happens when two sources propose conflicting events?
How are projections rebuilt?
How are dangerous file mutations separated from safe read-model updates?
```

So yes, this is a valid design gap.

# The main correction

Add a processing topology like this:

```text
Raw inputs / proposals
  ↓
Intake validation
  ↓
Semantic merge / conflict detection
  ↓
Canonical event store
  ↓
Projectors
  ↓
SQLite/read-model cache
  ↓
Consumer read models
  ↓
Mutation/apply queue for filesystem changes
```

The key distinction:

```text
Proposed events are not canonical events.
Canonical events are not projection jobs.
Projection jobs are not filesystem mutations.
```

That distinction should become a design requirement.

---

# Recommended topology

I agree with the proposed topology, with one refinement: separate **untrusted proposed-event intake** from the **canonical event stream**.

## 1. Ingestion

Accepts raw inputs from:

```text
scanner output
CLI commands
sync payloads
manual review decisions
category-change proposals
projection dry-run requests
external automation
```

Examples:

```text
MarkdownFileSeen
FrontmatterParsed
PlacementProposalSubmitted
ManualMoveDetected
CategorySplitRequested
ProjectionApplyRequested
```

At this stage, the system has only received something. It should not yet assume semantic validity.

---

## 2. Intake validation queue

Checks basic shape and trust.

Validation examples:

```text
valid event envelope
valid event_id
valid workspace_id
valid file_id format
valid timestamp
valid actor/source
valid schema version
valid signature, if used
no duplicate event_id
payload parses correctly
```

This stage answers:

```text
Is this input well-formed enough to process?
```

It does **not** answer:

```text
Is this semantically compatible with the current taxonomy?
```

A malformed input may be rejected here.

---

## 3. Semantic merge queue

This is where the system checks whether a proposed event can become canonical.

Examples:

```text
Does the file_id exist?
Does the category_id exist in this scheme?
Is this placement compatible with the active scheme?
Does accepting this placement violate “one primary category”?
Does this event conflict with a newer event for the same file?
Does this category change require review?
Does this projection plan match current filesystem state?
```

This stage can produce:

```text
canonical event
review task
semantic conflict
rejected proposal
new hypothesis
missing evidence requirement
```

This is especially important for adaptive taxonomy because many inputs are not simply true or false. They may become:

```text
PlacementHypothesis
ReviewTask
SemanticConflict
MissingEvidenceRequirement
CategoryChangeProposal
```

---

## 4. Canonical event store

Only after semantic validation or explicit review should an event become canonical.

Canonical events include things like:

```text
FileIdentityMinted
FileVersionObserved
PlacementHypothesisCreated
PlacementAccepted
PlacementSuperseded
ReviewTaskCreated
ReviewDecisionRecorded
CategoryChangeApproved
CategoryMappingCreated
ProjectionPolicyActivated
ProjectionPlanned
ProjectionValidated
ProjectionApplied
PathAliasCreated
```

This is the system’s durable semantic history.

The design should be explicit:

```text
Canonical events are append-only.
Projectors may read them.
Only the command/semantic processor may append them.
Arbitrary components may not mutate canonical state directly.
```

---

## 5. Projection/cache queue

This updates derived state.

Derived state includes:

```text
SQLite read-model tables
accepted graph view
hypothesis graph view
evidence graph view
review/change graph view
category indexes
path-resolution indexes
API JSON exports
search index
Obsidian resolver data
```

The important rule:

```text
SQLite cache/read models should be updated by controlled projectors,
not arbitrary writers.
```

This matters because otherwise one component may update `placement_assertions`, another may update `events`, another may update `path_aliases`, and the system will drift.

---

## 6. Consumer queues

These are downstream and should be treated as projections, not truth.

Examples:

```text
search index rebuild
JSON API export
category page generation
publishing status
Obsidian resolver update
automation hooks
backlink index update
```

These consumers should be idempotent and rebuildable.

If a consumer projection fails, the canonical event store should remain valid.

---

## 7. Mutation/apply queue

This is the dangerous queue.

It performs side effects:

```text
move Markdown files
rewrite frontmatter
create folders
write path aliases
materialize projection tree
restore files on rollback
```

This queue must be stricter than read-model queues.

Requirements:

```text
must reference a validated ProjectionRun
must reference a passed ValidationRun
must use the same plan_hash
must use a ProjectionManifest
must check filesystem drift before apply
must be idempotent or safely retryable
must emit success/failure events
```

The mutation queue should not be mixed with consumer queues.

A failed search-index update is annoying. A failed half-applied file move can damage the workspace.

---

# The most important design distinction

You need at least two queues before canonicalization:

```text
1. Proposed-event queue
   Untrusted or semi-trusted inputs.
   May be rejected, merged, converted to review tasks, or canonicalized.

2. Canonical-event projection queue
   Accepted append-only events.
   Used to update read models and consumer projections.
```

Without this distinction, the design blurs:

```text
received
validated
canonical
projected
applied
```

Those are different states.

# Should ingestion append canonical events immediately?

The best answer is:

```text
No, not generally.
```

Ingestion should first append to a **raw intake log** or **proposed-event queue**. Then semantic validation decides whether the proposal becomes a canonical event.

However, there is a useful nuance.

## Recommended model

Use three tiers:

```text
Raw intake log
  Records that something was received.

Proposed semantic events
  Well-formed but not yet canonical.

Canonical domain events
  Accepted by semantic validation or review.
```

So the flow is:

```text
raw input
  → intake log
  → proposed-event queue
  → semantic validation
  → canonical event store
  → projectors
```

This gives you auditability without polluting the canonical semantic stream.

---

# Why not append everything as canonical immediately?

Because some inputs are not true domain events yet.

Example:

```text
PlacementProposalSubmitted:
  file = foo.md
  proposed_category = cat:knowledge-graphs
```

That should not immediately become:

```text
PlacementAccepted
```

It may instead become:

```text
PlacementHypothesisCreated
ReviewTaskCreated
SemanticConflictDetected
PlacementProposalRejected
MissingEvidenceRequirementCreated
```

Similarly:

```text
CategorySplitRequested
```

should not immediately become:

```text
CategorySplitApplied
```

It should pass through review, migration planning, validation, and projection dry-run.

---

# But should raw receipt itself be canonical?

Only if you distinguish event kinds.

It is safe to have a canonical operational event like:

```text
InputReceived
```

or:

```text
CommandReceived
```

But that is not the same as canonical semantic truth.

For clarity, I would keep raw intake separate:

```text
intake_log:
  received envelopes, scanner output, external payloads

canonical_events:
  accepted semantic/domain events
```

That way the canonical stream remains meaningful.

---

# Proposed terminology

To avoid confusion, use these names:

```text
InputEnvelope
  raw received thing

Proposal
  well-formed request or candidate event

CanonicalEvent
  accepted domain event

ProjectionJob
  work item to update a read model

MutationJob
  work item that changes files/frontmatter/folders

ConsumerJob
  work item for search/export/publishing/etc.
```

This avoids the vague overloaded word “queue.”

---

# Ordering rules

The proposed scoped ordering rule is correct.

Do not require one global total order for everything unless you really need it. Prefer scoped ordering.

## File-level ordering

For events about one file:

```text
FileDiscovered
FileVersionObserved
PlacementHypothesisCreated
PlacementAccepted
PlacementSuperseded
FrontmatterUpdated
```

These should be ordered by file.

Use:

```text
aggregate_type = file
aggregate_id = file:...
event_seq per aggregate
```

## Workspace-level ordering

For category scheme and projection policy changes:

```text
CategorySchemeCreated
CategorySchemeActivated
ProjectionPolicyActivated
MigrationApplied
```

These affect many files and should be workspace-level events.

Use:

```text
aggregate_type = workspace
aggregate_id = workspace:...
```

## Projection-level ordering

For projection lifecycle:

```text
ProjectionPlanned
ProjectionValidated
ProjectionApplyStarted
ProjectionApplied
ProjectionApplyFailed
ProjectionRolledBack
```

Use:

```text
aggregate_type = projection
aggregate_id = proj:...
```

## Consumer-local ordering

For search/export/indexing:

```text
SearchIndexRebuildRequested
SearchIndexUpdated
JsonExportUpdated
```

These can be consumer-local and retryable.

---

# Barrier events

The questioner is right: some events should act as barriers.

Examples:

```text
CategorySchemeActivated
ProjectionPolicyActivated
MigrationApplied
ProjectionApplied
```

These affect interpretation downstream.

A projector should not process later file placement events under an old category scheme if a scheme activation barrier has already occurred.

Barrier event requirements:

```text
must be workspace-scoped
must be globally ordered within workspace
must flush or invalidate affected projections
must trigger rebuild or migration jobs
must be recorded before dependent events are accepted
```

Example:

```text
CategorySchemeActivated(scheme:v4)
```

should cause:

```text
invalidate category-profile cache
re-evaluate accepted placements if migration requires it
rebuild category index
update category aliases
schedule projection dry-run
```

---

# Added requirements for the design document

Yes, add a section called:

```text
Post-Ingestion Processing Model
```

It should include these requirements.

## Proposed new requirements

```text
1. The system distinguishes raw inputs, proposed events, canonical events,
   projection jobs, consumer jobs, and mutation jobs.

2. Ingestion accepts inputs from scanner output, CLI commands, sync payloads,
   manual decisions, and automation hooks.

3. Raw inputs are deduplicated by event_id or input_id.

4. Intake validation checks schema, IDs, source, actor, timestamp, and envelope.

5. Semantic validation determines whether a proposal becomes canonical,
   becomes a hypothesis, becomes a review task, or is rejected.

6. Canonical events are append-only.

7. SQLite/read-model cache is updated only by controlled projectors.

8. Projectors are idempotent.

9. Semantic conflicts are first-class outputs, not silent failures.

10. Consumer read models are downstream projections and can be rebuilt.

11. Mutation/apply work uses a separate queue from read-model projections.

12. Projection apply requires a passed validation run for the same plan_hash.

13. Workspace-level barrier events control scheme, migration, and projection transitions.

14. Queue processors must support retry without duplicating canonical state.

15. Every queue item must have a stable idempotency key.
```

---

# What changes in the existing design?

The data model mostly remains valid, but its role becomes clearer.

Earlier, `ledger.sqlite` could be interpreted as both:

```text
canonical state
and
read-model cache
```

Now you must choose.

## Option A — SQLite is canonical

```text
SQLite contains canonical events and current tables.
Projectors update tables inside the same DB.
```

This is simpler for MVP.

## Option B — Event store is canonical; SQLite is cache

```text
Canonical event store is append-only.
SQLite is a projected read model.
```

This is cleaner for async queues and multi-source ingestion.

Given the proposed queue topology, I would recommend:

```text
Canonical event store + SQLite read-model cache.
```

But for a first implementation, you can still store the canonical event store inside SQLite:

```text
events table = canonical event store
other tables = projected read models
```

The key rule is:

```text
Only the projector writes derived tables.
Only the command processor appends canonical events.
```

That prevents arbitrary components from mutating state inconsistently.

---

# Updated architecture

```text
Raw inputs
  scanner / CLI / sync / automation
        ↓
Intake log
  received envelopes, deduplication
        ↓
Proposed-event queue
  schema-valid but not yet canonical
        ↓
Semantic processor
  merge, conflict detection, review generation
        ↓
Canonical event store
  append-only accepted domain events
        ↓
Projector queues
  accepted graph projector
  hypothesis graph projector
  evidence graph projector
  review/change graph projector
        ↓
SQLite read-model cache
        ↓
Consumer queues
  search index, JSON export, Obsidian resolver
        ↓
Mutation/apply queue
  strict side-effect queue for file moves/frontmatter rewrites
```

Actually, the mutation queue may branch earlier:

```text
ProjectionValidated canonical event
        ↓
Mutation/apply queue
        ↓
ProjectionApplied / ProjectionApplyFailed canonical event
        ↓
Projectors update read models
```

That is better because file mutation result should itself become canonical.

---

# Important refinement: mutation events

For file moves, do not immediately write:

```text
ProjectionApplied
```

when a user requests apply.

Use lifecycle events:

```text
ProjectionApplyRequested
ProjectionApplyStarted
ProjectionFileMoveSucceeded
ProjectionFrontmatterUpdateSucceeded
ProjectionApplyFailed
ProjectionApplied
```

The mutation queue performs the side effect. Only after successful completion should the canonical event stream get:

```text
ProjectionApplied
```

If it fails, append:

```text
ProjectionApplyFailed
```

not a partial silent state.

---

# Answer to the final question

> Should ingestion be allowed to append canonical events immediately after schema validation, or should every ingested event first pass semantic merge validation before becoming canonical?

For this design:

```text
Raw ingestion should not append semantic canonical events immediately after schema validation.
```

Recommended:

```text
Schema-valid inputs become proposed events.
Proposed events pass semantic merge validation.
Only then are canonical semantic events appended.
```

But record raw receipt separately:

```text
Raw intake log records everything received.
Canonical event store records only accepted semantic/domain events.
```

There can be exceptions for low-risk operational observations, such as:

```text
FileSeen
FileVersionObserved
ScannerRunCompleted
```

Even then, I would treat them as canonical only after schema validation and deduplication, because they are observational events, not semantic commitments.

For semantic commitments such as:

```text
PlacementAccepted
CategorySchemeActivated
CategoryMerged
ProjectionApplied
```

require semantic validation, review if needed, and proper lifecycle transitions.

---

# Final verdict

This is a valid and valuable design question. It is not confusion.

It exposes a real missing part of the system:

```text
The design needs an explicit post-ingestion processing model.
```

The biggest added rule is:

```text
Do not blur proposed events, canonical events, projection jobs,
consumer jobs, and mutation jobs.
```

The best design is:

```text
raw intake log
+ proposed-event queue
+ semantic merge processor
+ append-only canonical event store
+ controlled projectors
+ SQLite/read-model cache
+ separate mutation/apply queue
+ downstream consumer queues
```

That gives the adaptive taxonomy system a clean operational backbone: events are truth, queues move work, projectors build views, and mutation is isolated behind stricter validation.
