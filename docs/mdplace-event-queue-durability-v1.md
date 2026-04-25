Yes, these are the right questions. For **repo-canonical v1**, I would make three decisions:

```text
Canonical append unit:
  one immutable OperationCommit file containing one semantic transaction
  and its emitted events.

Raw intake / proposed queues:
  mostly local generated state, except user-visible unresolved proposals
  should become canonical Hypothesis / ReviewTask / Conflict records.

Projection apply detail:
  canonical lifecycle summary events + canonical projection/apply manifest;
  not one canonical event per file by default.
```

Below is the detailed recommendation.

# 1. For repo-canonical v1, what should be the canonical append unit?

## Recommendation

Use an **OperationCommit file** as the canonical append unit.

Not:

```text
one event file per event
```

and not:

```text
one giant JSONL log chunk
```

but:

```text
one immutable file per accepted semantic operation
```

Example path:

```text
.kg/history/operations/2026/04/25/op-01JABC-accept-placement.json
.kg/history/operations/2026/04/25/op-01JABD-category-split.json
.kg/history/operations/2026/04/25/op-01JABE-projection-applied.json
```

An operation file can contain multiple events because many meaningful actions are transactional.

Example:

```json
{
  "op_id": "op:01JABC",
  "schema_version": 1,
  "op_type": "accept_placement",
  "workspace_id": "workspace:main",
  "actor": "user:local",
  "created_at": "2026-04-25T14:20:00+09:00",
  "idempotency_key": "accept-placement:file:01JXYZ:place:01J123",
  "base_refs": {
    "category_scheme": "scheme:v3",
    "category_scheme_hash": "sha256:...",
    "projection_policy": "policy:primary-category-folders-v1",
    "projection_policy_hash": "sha256:..."
  },
  "events": [
    {
      "event_id": "evt:01JABC1",
      "event_type": "PlacementAccepted",
      "aggregate_type": "file",
      "aggregate_id": "file:01JXYZ",
      "payload": {
        "placement_id": "place:01J123",
        "category_id": "cat:knowledge-graphs",
        "scheme_id": "scheme:v3"
      }
    },
    {
      "event_id": "evt:01JABC2",
      "event_type": "ReviewTaskResolved",
      "aggregate_type": "review_task",
      "aggregate_id": "review:01J888",
      "payload": {
        "resolution": "accepted_candidate",
        "resulting_placement_id": "place:01J123"
      }
    }
  ],
  "artifacts": [],
  "conflicts_created": []
}
```

This gives you atomic semantic history:

```text
one command/result
→ one operation commit
→ one or more canonical events
```

## Why operation file is better than event file

A single user action often emits multiple domain events.

Example:

```text
accept placement
  → PlacementAccepted
  → PreviousPlacementSuperseded
  → ReviewTaskResolved
  → FrontmatterUpdatePlanned
```

If each event is its own file, you need another mechanism to say:

```text
these events belong to one transaction
```

That adds complexity.

With an `OperationCommit`, the transaction boundary is obvious.

## Why operation file is better than JSONL chunks

JSONL chunks are compact, but they are worse for Git:

```text
multiple commands append to same file
merge conflicts are more likely
partial writes are more dangerous
manual inspection is harder
atomic rename is harder
```

For local Git-backed canonical history, many small immutable files are usually easier than shared append chunks.

## Recommended canonical append unit

```text
OperationCommit file
  immutable
  append-only
  one semantic transaction
  contains emitted canonical events
  references artifact files by hash
```

The SQLite database should be a derived cache/index of those operation files.

---

# 2. Operation file vs event file vs JSONL chunks

| Option                    | Verdict                              | Why                                                                                          |
| ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| **Operation file**        | Best for v1                          | Git-friendly, transaction boundary is clear, easy to inspect, easy to merge, easy to replay. |
| **Event file**            | Acceptable but too granular          | Simple but noisy; multi-event operations need grouping anyway.                               |
| **JSONL chunks**          | Not ideal as repo-canonical          | Compact but higher merge risk, partial-write risk, and harder conflict recovery.             |
| **SQLite canonical**      | Good local cache, weak Git canonical | Easy to query, but hard to merge across branches and less transparent.                       |
| **Git commit as event**   | Tempting but too implicit            | Git knows file changes, not semantic intent.                                                 |
| **CRDT/event-log system** | Overkill for v1                      | Useful only if multi-user concurrent editing becomes central.                                |

My recommendation:

```text
Canonical:
  .kg/history/operations/**/*.json

Derived:
  .kg/ledger.sqlite

Artifacts:
  .kg/projections/*.json
  .kg/validation/*.json
  .kg/conflicts/*.json if needed
```

---

# 3. What should an OperationCommit contain?

Minimum fields:

```json
{
  "op_id": "op:...",
  "schema_version": 1,
  "op_type": "accept_placement | create_hypothesis | split_category | projection_applied | ...",
  "workspace_id": "workspace:...",
  "actor": "user:local | system:scanner | system:semantic-merge",
  "created_at": "ISO timestamp",
  "idempotency_key": "...",
  "base_refs": {},
  "input_refs": [],
  "events": [],
  "artifacts": [],
  "conflicts_created": [],
  "significance": "semantic | operational | projection | consumer"
}
```

`base_refs` are important because they protect against stale operations.

Example:

```json
"base_refs": {
  "category_scheme_id": "scheme:v3",
  "category_scheme_hash": "sha256:abc",
  "projection_policy_id": "policy:primary-category-folders-v1",
  "projection_policy_hash": "sha256:def",
  "file_content_hash": "sha256:ghi"
}
```

This helps detect:

```text
projection applied against stale policy hash
accepted placement using stale evidence
category modified after proposal was created
file changed after placement proposal was scored
```

---

# 4. How durable should raw intake and proposed-event queues be in local CLI?

## Recommendation

For v1:

```text
Raw intake queue:
  local/generated, not canonical by default.

Proposed-event queue:
  local/generated for ephemeral suggestions,
  but durable/canonical once it becomes a Hypothesis, ReviewTask, Conflict,
  or CategoryChangeProposal.
```

In other words:

```text
Do not track every scanner blip.
Do track semantically meaningful unresolved states.
```

## Three levels of durability

### Level 1 — Raw intake

Examples:

```text
scanner saw file
frontmatter parsed
embedding job produced score
CLI command submitted
sync payload received
```

Recommended durability:

```text
local/generated only
```

Path:

```text
.kg/work/intake/
.kg/work/queues/
```

Usually Git-ignored.

Why?

```text
Most raw intake is reproducible.
Scanner output can be regenerated.
Embedding scores can be recomputed.
Raw queues create noise in Git.
```

Exception:

```text
If external input is non-repeatable, store a content-addressed raw artifact.
```

Example:

```text
.kg/raw/sha256/ab/cd/<hash>.json
```

But do not make it semantic truth.

---

### Level 2 — Proposed events

Examples:

```text
proposed placement
proposed category split
manual move detected
projection apply requested
```

Recommendation:

```text
Do not make all proposals canonical.
```

Instead:

```text
low-value generated proposals → local queue only
user-visible unresolved proposals → canonical Hypothesis/ReviewTask/Conflict
approved proposal → OperationCommit with canonical events
```

Example:

A classifier suggests:

```text
file:abc → cat:knowledge-graphs, score 0.62
```

If this is just a suggestion, keep it local.

If the system decides it cannot safely categorize:

```text
PlacementHypothesisCreated
ReviewTaskCreated
MissingEvidenceRequirementCreated
```

then those become canonical operation files.

---

### Level 3 — Canonical semantic events

These must be durable:

```text
PlacementAccepted
PlacementSuperseded
PlacementHypothesisCreated
ReviewTaskCreated
ReviewDecisionRecorded
CategoryChangeProposed
CategoryChangeApproved
CategoryMappingCreated
SemanticConflictDetected
ProjectionValidated
ProjectionApplied
PathAliasMaterialized
```

These go into operation files.

---

# 5. Should there be “no raw intake”?

For a simple local CLI, yes, you can start with **no durable raw intake**.

Recommended v1 rule:

```text
Only canonicalize semantic outcomes, not raw scanner mechanics.
```

So:

```text
kg scan
```

may directly produce canonical operation files like:

```text
FileIdentityMinted
FileVersionObserved
FileMissingDetected
```

after schema/dedup validation.

But it should not canonicalize every intermediate parser output.

The scanner can also update local cache:

```text
.kg/ledger.sqlite
```

without writing raw intake files.

Good v1 compromise:

```text
No tracked raw intake queue.
Local work queue for processing.
Canonical operation files for accepted semantic outcomes.
```

---

# 6. Proposed queue durability policy

| Item                                 | Track in Git? |       Canonical? | Notes                                          |
| ------------------------------------ | ------------: | ---------------: | ---------------------------------------------- |
| Raw scanner output                   |            No |               No | Regenerate with `kg scan`.                     |
| Parsed frontmatter cache             |            No |               No | Derived cache.                                 |
| Embedding scores                     | No by default |               No | Store model/hash metadata if used as evidence. |
| Low-confidence generated suggestions | No by default |               No | Regenerate unless promoted.                    |
| PlacementHypothesis                  |           Yes |              Yes | Durable unresolved semantic state.             |
| ReviewTask                           |           Yes |              Yes | User-visible work item.                        |
| SemanticConflict                     |           Yes |              Yes | Consumers need predictable behavior.           |
| CategoryChangeProposal               |           Yes |              Yes | Taxonomy evolution proposal.                   |
| Approved Placement                   |           Yes |              Yes | Canonical semantic state.                      |
| ProjectionPlan                       |           Yes | Yes, as artifact | Needed for reproducibility.                    |
| ProjectionApply result               |           Yes |              Yes | Needed for history and rollback.               |

---

# 7. Alternative durability models

## Alternative A — Everything canonical

```text
Every intake item becomes canonical.
```

Pros:

```text
maximum auditability
```

Cons:

```text
huge noise
harder Git merges
harder to understand history
lots of meaningless events
```

Not recommended for v1.

## Alternative B — Nothing before acceptance is durable

```text
Only accepted placements and applied projections are canonical.
```

Pros:

```text
simple
low noise
```

Cons:

```text
no durable unresolved state
no explanation for “unable to categorize”
no durable review queue
```

Not recommended because you explicitly need abstention, hypotheses, and review states.

## Alternative C — Canonical proposals as first-class objects

```text
Every generated proposal becomes a durable Proposal object.
```

Pros:

```text
auditable proposal history
```

Cons:

```text
very noisy unless curated
```

Possible later, but not v1.

## Recommended hybrid

```text
Raw intake:
  local only

Generated proposals:
  local unless promoted

Unresolved semantic state:
  canonical Hypothesis / ReviewTask / Conflict

Accepted decisions:
  canonical OperationCommit
```

---

# 8. For projection apply, what mutation detail should become canonical events?

## Recommendation

Use a hybrid:

```text
Canonical summary lifecycle events
+ canonical projection/apply manifest with per-file details
```

Do **not** create one canonical event per moved file by default.

Do **not** store only “ProjectionApplied” without details.

## Why not per-file events?

A projection might move hundreds or thousands of files.

If every file move becomes its own canonical event:

```text
ProjectionFileMoved
ProjectionFileMoved
ProjectionFileMoved
...
```

you get:

```text
huge event noise
more Git files
harder history inspection
more merge overhead
```

But you still need per-file detail for rollback and explanation.

So store per-file detail in a canonical manifest.

---

# 9. Projection apply canonical structure

## Canonical events

The operation file should contain lifecycle summary events:

```text
ProjectionApplyRequested
ProjectionApplyStarted
ProjectionApplied
```

or, on failure:

```text
ProjectionApplyRequested
ProjectionApplyStarted
ProjectionApplyFailed
```

or rollback:

```text
ProjectionRollbackRequested
ProjectionRolledBack
```

Example operation file:

```json
{
  "op_id": "op:01JPROJAPPLY",
  "op_type": "projection_apply",
  "created_at": "2026-04-25T15:00:00+09:00",
  "base_refs": {
    "projection_id": "proj:v12",
    "plan_hash": "sha256:plan...",
    "validation_id": "validation:proj-v12",
    "validation_hash": "sha256:validation..."
  },
  "events": [
    {
      "event_id": "evt:apply-started",
      "event_type": "ProjectionApplyStarted",
      "aggregate_type": "projection",
      "aggregate_id": "proj:v12",
      "payload": {
        "plan_hash": "sha256:plan..."
      }
    },
    {
      "event_id": "evt:applied",
      "event_type": "ProjectionApplied",
      "aggregate_type": "projection",
      "aggregate_id": "proj:v12",
      "payload": {
        "files_moved": 37,
        "frontmatter_updated": 41,
        "path_aliases_created": 37,
        "apply_manifest": ".kg/projections/proj-v12.apply.json",
        "apply_manifest_hash": "sha256:apply..."
      }
    }
  ],
  "artifacts": [
    {
      "artifact_type": "projection_apply_manifest",
      "path": ".kg/projections/proj-v12.apply.json",
      "hash": "sha256:apply..."
    }
  ]
}
```

## Canonical artifact: apply manifest

The apply manifest contains per-file mutation detail.

```json
{
  "projection_id": "proj:v12",
  "plan_hash": "sha256:plan...",
  "policy_id": "policy:primary-category-folders-v1",
  "policy_hash": "sha256:policy...",
  "scheme_id": "scheme:v3",
  "scheme_hash": "sha256:scheme...",
  "applied_at": "2026-04-25T15:00:00+09:00",
  "mutations": [
    {
      "file_id": "file:01JABC",
      "path_reason": "accepted_category",
      "placement_id": "place:01JABD",
      "from_path": "notes/Inbox/adaptive-taxonomy.md",
      "to_path": "notes/Research/Knowledge Graphs/adaptive-taxonomy.md",
      "action": "move_and_update_frontmatter",
      "before": {
        "content_hash": "sha256:before...",
        "frontmatter_hash": "sha256:fm-before...",
        "managed_frontmatter": {
          "primary_category": null,
          "placement_state": "insufficient_evidence"
        }
      },
      "after": {
        "content_hash": "sha256:after...",
        "frontmatter_hash": "sha256:fm-after...",
        "managed_frontmatter": {
          "primary_category": "cat:knowledge-graphs",
          "placement_state": "accepted",
          "placement_id": "place:01JABD",
          "projection_id": "proj:v12"
        }
      },
      "path_alias_created": {
        "old_path": "notes/Inbox/adaptive-taxonomy.md",
        "new_path": "notes/Research/Knowledge Graphs/adaptive-taxonomy.md"
      }
    }
  ]
}
```

This manifest is the canonical per-file detail.

The event is the summary.

---

# 10. Answering the three projection options

## Option A — Summary events

Good, but only if paired with a canonical manifest.

Recommended:

```text
ProjectionApplied event
+ apply manifest with per-file detail
```

## Option B — Per-file events

Useful only if consumers need a file-level event stream.

For v1, not recommended as canonical default.

But you may derive per-file events from the manifest for consumers:

```text
SearchIndexerFileMoved
ObsidianResolverAliasUpdated
```

Those are consumer-local, not canonical semantic history.

## Option C — Applied only

Not enough.

If you only store:

```text
ProjectionApplied
```

without:

```text
started
failed
manifest
plan hash
validation reference
per-file detail
```

then you cannot safely answer:

```text
What moved?
Was there a partial failure?
Can we roll it back?
Was this applied against the validated plan?
What old paths point to this file?
```

So avoid “applied only.”

## Recommended

```text
Projection lifecycle summary events
+ immutable plan manifest
+ immutable apply manifest
+ derived per-file aliases/read models
```

---

# 11. Should `PathAliasCreated` be a per-file canonical event?

For v1, I would not make every path alias a separate canonical event.

Instead:

```text
Path aliases are canonical records inside the projection apply manifest.
SQLite path_aliases table is derived from that manifest.
```

The operation can emit one summary event:

```text
PathAliasesMaterialized
```

with count and manifest hash.

Example:

```json
{
  "event_type": "PathAliasesMaterialized",
  "payload": {
    "projection_id": "proj:v12",
    "count": 37,
    "source_manifest": ".kg/projections/proj-v12.apply.json",
    "source_manifest_hash": "sha256:..."
  }
}
```

If a specific path alias later causes a conflict, create a `SemanticConflict` for that alias.

---

# 12. Projection apply failure

For failure, write a canonical operation file too.

Example:

```json
{
  "op_type": "projection_apply_failed",
  "events": [
    {
      "event_type": "ProjectionApplyFailed",
      "aggregate_type": "projection",
      "aggregate_id": "proj:v12",
      "payload": {
        "failure_reason": "file_modified_since_plan",
        "failed_file_id": "file:01JABC",
        "partial_apply_manifest": ".kg/projections/proj-v12.partial-failed.json",
        "semantic_conflict_id": "conflict:stale-file-during-apply"
      }
    }
  ]
}
```

This prevents half-applied filesystem state from becoming invisible.

---

# 13. Recommended v1 choices

## Canonical append unit

Choose:

```text
OperationCommit file
```

Not:

```text
standalone event file
JSONL chunk
SQLite-only canonical history
```

## Raw intake durability

Choose:

```text
local/generated raw intake
```

except for non-repeatable external inputs, which can be content-addressed artifacts.

## Proposed-event durability

Choose:

```text
local/generated suggestions by default
canonical Hypothesis / ReviewTask / Conflict when unresolved state matters
canonical OperationCommit when accepted/rejected/resolved
```

## Projection mutation canonicality

Choose:

```text
summary lifecycle events
+ canonical per-file manifest
```

Not:

```text
per-file canonical events by default
```

and not:

```text
applied-only event
```

---

# 14. Concrete repo-canonical v1 layout

```text
.kg/
  history/
    operations/
      2026/
        04/
          25/
            op-01JABC-accept-placement.json
            op-01JABD-create-hypothesis.json
            op-01JABE-detect-conflict.json
            op-01JABF-projection-applied.json

  projections/
    proj-v12.plan.json
    proj-v12.validation.json
    proj-v12.apply.json

  categories/
    scheme-v3.yaml

  policies/
    projection-policy-primary-v1.yaml

  cache/
    ledger.sqlite        # derived, rebuildable

  work/                  # git-ignored
    intake/
    queues/
    locks/
```

Recommended Git behavior:

```text
Track:
  .kg/history/operations/
  .kg/categories/
  .kg/policies/
  .kg/projections/*.plan.json
  .kg/projections/*.apply.json
  .kg/projections/*.validation.json

Ignore:
  .kg/cache/
  .kg/work/
  embeddings cache
  temporary queue files
```

---

# 15. Final answer in one sentence

For repo-canonical v1, use **immutable OperationCommit files** as the canonical append unit; keep raw intake and low-value proposals local/generated; promote meaningful unresolved states into canonical `Hypothesis`, `ReviewTask`, or `SemanticConflict` operations; and represent projection apply with **summary lifecycle events plus an immutable per-file apply manifest**, not per-file canonical events by default.
