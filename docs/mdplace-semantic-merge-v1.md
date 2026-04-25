Yes — this feedback is valid, and it identifies another real implementation hole.

The queue model defines **where** conflicts are detected, but the design still needs to define **what a conflict is**, how it is stored, how consumers react, and how conflicts are resolved. Without a first-class conflict object, each consumer will invent its own behavior, which defeats the point of having a controlled semantic ledger.

The design should add a new layer:

```text
SemanticConflict ledger
```

or, in graph terms:

```text
Conflict graph
```

This graph is distinct from:

```text
Accepted graph      → accepted placements only
Hypothesis graph    → candidate / uncertain placements
Evidence graph      → evidence and provenance
Review/change graph → tasks, decisions, taxonomy changes
Conflict graph      → contradictions, invalid states, stale assumptions, blocked transitions
```

# 1. Why `SemanticConflict` is necessary

A `ReviewTask` says:

```text
A human/system action is needed.
```

A `ValidationRun` says:

```text
This planned operation passed or failed preflight checks.
```

A `SemanticConflict` says:

```text
The semantic state or proposed transition contains a contradiction,
ambiguity, or unsafe interpretation that consumers must handle predictably.
```

Those are different things.

Example:

```text
Two accepted primary placements exist for the same file.
```

This is not merely a review task. It is a **semantic conflict** that should block publishing, affect projection behavior, and maybe allow search indexing with a warning.

So yes, define the conflict object.

---

# 2. Add requirement

Add this requirement to the design:

```text
15. Semantic conflicts must be first-class durable objects with typed severity,
    affected entities, causal events, consumer impact, and resolution options.
```

Also add this invariant:

```text
No consumer should infer its own conflict behavior from raw ledger state.
Consumers must read explicit SemanticConflict and ConsumerImpact records.
```

That means publishing, search, Obsidian resolver, JSON export, projection, and automation hooks all receive predictable guidance.

---

# 3. Conflict lifecycle

A conflict should have a lifecycle.

```text
detected
→ open
→ acknowledged
→ resolving
→ resolved
```

Alternative terminal states:

```text
dismissed
suppressed
superseded
expired
```

Recommended statuses:

```text
open
acknowledged
resolving
resolved
dismissed
suppressed
superseded
```

Recommended severities:

```text
blocking
degraded
warning
info
```

Meaning:

| Severity   | Meaning                                        |
| ---------- | ---------------------------------------------- |
| `blocking` | Must stop mutation/apply or publishing.        |
| `degraded` | Consumers may continue with fallback behavior. |
| `warning`  | Continue, but expose warning.                  |
| `info`     | Diagnostic only.                               |

---

# 4. Core `SemanticConflict` object

A good conflict object should look like this:

```yaml
SemanticConflict:
  conflict_id: conflict:01JXYZ
  conflict_type: duplicate_primary_placement
  severity: blocking
  status: open

  scope:
    scope_type: file
    scope_id: file:01JABC

  affected_entities:
    - entity_type: file
      entity_id: file:01JABC
      role: subject
    - entity_type: placement
      entity_id: place:001
      role: conflicting_assertion
    - entity_type: placement
      entity_id: place:002
      role: conflicting_assertion

  detected_from_events:
    - evt:placement-accepted-001
    - evt:placement-accepted-002

  detected_by: semantic-merge:v1
  detected_at: 2026-04-25T12:20:00+09:00

  explanation: >
    File file:01JABC has two accepted primary placements under scheme:v3.

  consumer_impact:
    publishing: block
    projection: block_semantic_folder
    search_index: include_with_warning
    obsidian_resolver: use_last_stable
    json_export: include_conflict_marker

  resolution_options:
    - option_type: supersede_placement
      target: place:001
    - option_type: supersede_placement
      target: place:002
    - option_type: create_hypothesis
    - option_type: request_review
```

This is the right shape.

For API responses, this is similar in spirit to **Problem Details**: RFC 9457 defines a machine-readable problem-detail format for HTTP APIs so clients do not need a custom error format for every problem type. Your `SemanticConflict` is not exactly an HTTP error, but it should follow the same philosophy: stable type, title/explanation, affected instance, and extension fields for domain-specific detail. ([RFC Editor][1])

For event envelopes, you can use a CloudEvents-like event shape. CloudEvents is a specification for describing event data in common formats across services, platforms, and systems; the useful idea here is a standard envelope around domain payloads. ([GitHub][2])

---

# 5. Conflict types to define

Start with a controlled enum. Do not let arbitrary strings proliferate.

## Placement conflicts

```text
duplicate_primary_placement
accepted_placement_without_evidence
accepted_placement_uses_stale_evidence
accepted_placement_to_invalid_category
accepted_placement_to_review_state
accepted_placement_category_scheme_mismatch
placement_supersession_cycle
manual_override_conflict
```

## Hypothesis/review conflicts

```text
hypothesis_without_candidates
insufficient_evidence_without_missing_requirements
review_task_without_hypothesis
review_task_resolved_without_decision
candidate_scores_ambiguous
conflicting_evidence
```

## Category/taxonomy conflicts

```text
category_mapping_conflict
category_alias_cycle
category_parent_cycle
category_deleted_but_referenced
category_deprecated_but_still_accepted
category_split_without_migration
category_merge_without_alias
category_slug_collision
reserved_slug_used_as_category
```

## Projection conflicts

```text
projection_against_stale_policy_hash
projection_against_stale_scheme_hash
projection_plan_hash_mismatch
projection_path_collision
projection_overwrites_untracked_file
projection_uses_unaccepted_placement
projection_review_folder_without_review_state
projection_normal_folder_without_accepted_placement
```

## Filesystem conflicts

```text
manual_move_conflicts_with_projection
file_missing_during_apply
file_modified_since_projection_plan
duplicate_kg_id
missing_kg_id
path_alias_cycle
path_alias_target_missing
```

## Consumer conflicts

```text
consumer_contract_broken
consumer_uses_deprecated_category
consumer_requires_removed_view
consumer_export_stale
```

---

# 6. Schema addition

Add five tables:

```text
semantic_conflicts
semantic_conflict_entities
semantic_conflict_events
semantic_conflict_consumer_impacts
semantic_conflict_resolution_options
```

Optionally add:

```text
semantic_conflict_resolutions
```

## `semantic_conflicts`

```sql
CREATE TABLE semantic_conflicts (
  conflict_id TEXT PRIMARY KEY,

  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (
    severity IN ('blocking', 'degraded', 'warning', 'info')
  ),

  status TEXT NOT NULL CHECK (
    status IN (
      'open',
      'acknowledged',
      'resolving',
      'resolved',
      'dismissed',
      'suppressed',
      'superseded'
    )
  ),

  scope_type TEXT NOT NULL CHECK (
    scope_type IN (
      'workspace',
      'file',
      'category',
      'placement',
      'hypothesis',
      'projection',
      'consumer'
    )
  ),

  scope_id TEXT NOT NULL,

  title TEXT NOT NULL,
  explanation TEXT,

  detected_by TEXT NOT NULL,
  detected_at TEXT NOT NULL,

  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,

  supersedes TEXT REFERENCES semantic_conflicts(conflict_id),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_summary TEXT
);

CREATE UNIQUE INDEX idx_semantic_conflicts_fingerprint_open
ON semantic_conflicts(fingerprint)
WHERE status IN ('open', 'acknowledged', 'resolving');
```

The `fingerprint` is important. It prevents repeated detection jobs from creating duplicate conflicts for the same issue.

Example fingerprint:

```text
sha256(conflict_type + scope_type + scope_id + sorted affected entity IDs)
```

---

## `semantic_conflict_entities`

```sql
CREATE TABLE semantic_conflict_entities (
  conflict_id TEXT NOT NULL REFERENCES semantic_conflicts(conflict_id),

  entity_type TEXT NOT NULL CHECK (
    entity_type IN (
      'file',
      'category',
      'category_scheme',
      'placement',
      'hypothesis',
      'evidence',
      'review_task',
      'projection',
      'projection_policy',
      'path_alias',
      'category_mapping',
      'category_alias',
      'consumer',
      'event'
    )
  ),

  entity_id TEXT NOT NULL,

  role TEXT NOT NULL CHECK (
    role IN (
      'subject',
      'conflicting_assertion',
      'stale_reference',
      'missing_dependency',
      'invalid_target',
      'blocked_consumer',
      'causal_entity',
      'affected_entity'
    )
  ),

  PRIMARY KEY (conflict_id, entity_type, entity_id, role)
);
```

---

## `semantic_conflict_events`

```sql
CREATE TABLE semantic_conflict_events (
  conflict_id TEXT NOT NULL REFERENCES semantic_conflicts(conflict_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),

  role TEXT NOT NULL CHECK (
    role IN (
      'detected_from',
      'caused_by',
      'superseded_by',
      'resolution_event'
    )
  ),

  PRIMARY KEY (conflict_id, event_id, role)
);
```

This ties a conflict to the event stream.

---

## `semantic_conflict_consumer_impacts`

```sql
CREATE TABLE semantic_conflict_consumer_impacts (
  conflict_id TEXT NOT NULL REFERENCES semantic_conflicts(conflict_id),

  consumer_id TEXT NOT NULL,

  impact_action TEXT NOT NULL CHECK (
    impact_action IN (
      'block',
      'block_mutation',
      'use_last_stable',
      'include_with_warning',
      'exclude',
      'defer',
      'rebuild_required',
      'no_impact'
    )
  ),

  impact_summary TEXT,
  payload_json TEXT,

  PRIMARY KEY (conflict_id, consumer_id)
);
```

Example consumer actions:

```yaml
consumer_impact:
  publishing: block
  projection: block_mutation
  search_index: include_with_warning
  obsidian_resolver: use_last_stable
  json_export: include_with_warning
```

This is the part the feedback correctly says is missing.

---

## `semantic_conflict_resolution_options`

```sql
CREATE TABLE semantic_conflict_resolution_options (
  option_id TEXT PRIMARY KEY,

  conflict_id TEXT NOT NULL REFERENCES semantic_conflicts(conflict_id),

  option_type TEXT NOT NULL CHECK (
    option_type IN (
      'accept_placement',
      'supersede_placement',
      'reject_placement',
      'create_hypothesis',
      'request_review',
      'add_evidence',
      'refresh_evidence',
      'rerun_projection',
      'rollback_projection',
      'update_category_mapping',
      'create_category_alias',
      'reactivate_category',
      'migrate_category',
      'dismiss_conflict',
      'suppress_conflict'
    )
  ),

  target_entity_type TEXT,
  target_entity_id TEXT,

  preconditions_json TEXT,
  expected_effect_json TEXT,

  recommended INTEGER NOT NULL DEFAULT 0 CHECK (recommended IN (0, 1))
);
```

---

## `semantic_conflict_resolutions`

```sql
CREATE TABLE semantic_conflict_resolutions (
  resolution_id TEXT PRIMARY KEY,

  conflict_id TEXT NOT NULL REFERENCES semantic_conflicts(conflict_id),
  option_id TEXT REFERENCES semantic_conflict_resolution_options(option_id),

  actor TEXT,
  decision TEXT NOT NULL CHECK (
    decision IN (
      'applied',
      'dismissed',
      'suppressed',
      'deferred',
      'escalated'
    )
  ),

  rationale TEXT,
  resulting_event_id TEXT REFERENCES events(event_id),
  resulting_review_task_id TEXT REFERENCES review_tasks(review_task_id),

  created_at TEXT NOT NULL
);
```

---

# 7. Conflict events

The canonical event stream should include conflict lifecycle events:

```text
SemanticConflictDetected
SemanticConflictAcknowledged
SemanticConflictResolutionProposed
SemanticConflictResolved
SemanticConflictDismissed
SemanticConflictSuppressed
SemanticConflictSuperseded
```

Example event:

```json
{
  "event_type": "SemanticConflictDetected",
  "aggregate_type": "conflict",
  "aggregate_id": "conflict:01JXYZ",
  "payload": {
    "conflict_type": "duplicate_primary_placement",
    "severity": "blocking",
    "scope_type": "file",
    "scope_id": "file:01JABC",
    "fingerprint": "sha256:..."
  }
}
```

This keeps conflicts in the append-only history rather than just storing them as mutable issue records.

---

# 8. How semantic merge should use conflicts

The semantic merge processor should output one of these:

```text
1. Canonical event accepted
2. SemanticConflict created
3. ReviewTask created
4. PlacementHypothesis created
5. Proposal rejected
```

Example flow:

```text
Proposal:
  Accept placement place:002 as primary for file:01JABC

Semantic merge sees:
  place:001 is already accepted primary under same scheme

Output:
  SemanticConflict(type=duplicate_primary_placement, severity=blocking)
  ReviewTask(type=manual_override_needed)
  Proposal not canonicalized as PlacementAccepted
```

So the proposed placement does not become accepted until the conflict is resolved.

---

# 9. Consumer behavior matrix

Define default behavior by severity.

| Severity   | Publishing              | Projection apply               | Search index                    | JSON export             | Obsidian resolver          |
| ---------- | ----------------------- | ------------------------------ | ------------------------------- | ----------------------- | -------------------------- |
| `blocking` | Block                   | Block                          | Include with warning or exclude | Include conflict marker | Use last stable            |
| `degraded` | Warn or block by policy | Defer affected files           | Include with warning            | Include warning         | Use last stable or warning |
| `warning`  | Continue with warning   | Continue if no filesystem risk | Include                         | Include warning         | Continue                   |
| `info`     | Continue                | Continue                       | Continue                        | Continue                | Continue                   |

Then allow conflict-specific overrides through `semantic_conflict_consumer_impacts`.

Example:

```yaml
SemanticConflict:
  conflict_type: accepted_placement_using_stale_evidence
  severity: degraded
  consumer_impact:
    publishing: block
    search_index: include_with_warning
    obsidian_resolver: use_last_stable
```

The consumer should not guess. It should read the declared impact.

---

# 10. Examples of conflict objects

## Example A — duplicate accepted primary placements

```yaml
SemanticConflict:
  conflict_id: conflict:dup-primary-001
  conflict_type: duplicate_primary_placement
  severity: blocking
  status: open
  scope:
    scope_type: file
    scope_id: file:adaptive-taxonomy
  affected_entities:
    - file:adaptive-taxonomy
    - place:kg
    - place:rag
  detected_from_events:
    - evt:accept-place-kg
    - evt:accept-place-rag
  consumer_impact:
    publishing: block
    projection: block_mutation
    search_index: include_with_warning
    obsidian_resolver: use_last_stable
  resolution_options:
    - supersede_placement: place:kg
    - supersede_placement: place:rag
    - create_hypothesis
    - request_review
```

---

## Example B — same category mapped to different targets

```yaml
SemanticConflict:
  conflict_id: conflict:mapping-001
  conflict_type: category_mapping_conflict
  severity: blocking
  status: open
  scope:
    scope_type: category
    scope_id: cat:to-review
  affected_entities:
    - category_mapping: map:to-review-to-status
    - category_mapping: map:to-review-to-category
  explanation: >
    cat:to-review is mapped both to workflow_status:to-review
    and category:review-notes under scheme:v3.
  consumer_impact:
    category_api: block
    projection: use_last_stable
    publishing: block
  resolution_options:
    - update_category_mapping
    - suppress_conflict
    - request_review
```

---

## Example C — projection applied against stale policy hash

```yaml
SemanticConflict:
  conflict_id: conflict:stale-policy-001
  conflict_type: projection_against_stale_policy_hash
  severity: blocking
  status: open
  scope:
    scope_type: projection
    scope_id: proj:v12
  affected_entities:
    - projection: proj:v12
    - projection_policy: policy:primary-category-folders-v1
  explanation: >
    Projection plan_hash was computed using policy_hash A,
    but active policy hash is now B.
  consumer_impact:
    projection: block_mutation
    publishing: use_last_stable
    search_index: no_impact
  resolution_options:
    - rerun_projection
    - rollback_projection
```

---

## Example D — accepted placement using stale evidence

```yaml
SemanticConflict:
  conflict_id: conflict:stale-evidence-001
  conflict_type: accepted_placement_uses_stale_evidence
  severity: degraded
  status: open
  scope:
    scope_type: file
    scope_id: file:graph-rag-note
  affected_entities:
    - placement: place:old-rag
    - evidence: ev:old-heading-terms
    - file:graph-rag-note
  explanation: >
    The accepted placement depends on evidence extracted from an older
    content hash. The file has since changed substantially.
  consumer_impact:
    publishing: include_with_warning
    projection: use_last_stable
    search_index: include_with_warning
  resolution_options:
    - refresh_evidence
    - create_hypothesis
    - request_review
```

---

# 11. Validation versus semantic conflict

Not every validation failure needs to become a persisted conflict.

Use this distinction:

```text
Validation failure:
  local, immediate, operation-scoped problem.

Semantic conflict:
  durable contradiction or unsafe semantic state that affects interpretation,
  consumers, or future processing.
```

Examples:

| Situation                                    | Validation failure? |                         Semantic conflict? |
| -------------------------------------------- | ------------------: | -----------------------------------------: |
| Projection path collision in one dry-run     |                 Yes | Maybe, if unresolved and affects consumers |
| Duplicate accepted primary placements        |                 Yes |                                        Yes |
| Missing kg_id in new file                    |                 Yes |                Usually no; scanner can fix |
| Same category mapped to two targets          |                 Yes |                                        Yes |
| Projection policy hash changed after dry-run |                 Yes |                 Yes if apply was requested |
| Evidence payload JSON malformed              |                 Yes |                          No, reject intake |
| Accepted placement relies on stale evidence  |                 Yes |                                        Yes |
| Manual move differs from projection          |                 Yes |                     Yes, if not reconciled |

---

# 12. JSON Schema for conflicts

Because consumers will rely on conflict objects, validate them with JSON Schema. JSON Schema is a declarative language for validating JSON document structure, constraints, and data types, which fits conflict payloads and consumer-impact objects well. ([JSON Schema][3])

Minimal schema shape:

```json
{
  "$id": "https://example.local/kg/schemas/semantic-conflict.schema.json",
  "type": "object",
  "required": [
    "conflict_id",
    "conflict_type",
    "severity",
    "status",
    "scope",
    "affected_entities",
    "consumer_impact",
    "resolution_options"
  ],
  "properties": {
    "conflict_id": { "type": "string" },
    "conflict_type": { "type": "string" },
    "severity": {
      "enum": ["blocking", "degraded", "warning", "info"]
    },
    "status": {
      "enum": [
        "open",
        "acknowledged",
        "resolving",
        "resolved",
        "dismissed",
        "suppressed",
        "superseded"
      ]
    },
    "scope": {
      "type": "object",
      "required": ["scope_type", "scope_id"],
      "properties": {
        "scope_type": { "type": "string" },
        "scope_id": { "type": "string" }
      }
    },
    "affected_entities": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["entity_type", "entity_id", "role"],
        "properties": {
          "entity_type": { "type": "string" },
          "entity_id": { "type": "string" },
          "role": { "type": "string" }
        }
      }
    },
    "consumer_impact": {
      "type": "object"
    },
    "resolution_options": {
      "type": "array"
    }
  }
}
```

---

# 13. Update the processing topology

The topology should now include a conflict branch:

```text
Raw input
  ↓
Intake validation
  ↓
Semantic merge
  ├── canonical event
  ├── semantic conflict
  ├── placement hypothesis
  ├── review task
  └── rejected proposal
        ↓
Conflict projector
  updates conflict graph / conflict table
        ↓
Consumer-impact router
  publishing / search / resolver / projection / JSON export
```

For dangerous mutations:

```text
ProjectionApplyRequested
  ↓
semantic merge checks conflicts
  ↓
if blocking conflict exists:
  create or reuse SemanticConflict
  do not enqueue mutation
else:
  enqueue mutation/apply job
```

---

# 14. New requirements to add

Add this section to the docs.

```text
Semantic Conflict Model

- Semantic merge must produce typed SemanticConflict objects when proposed
  events or current state violate semantic invariants.

- Each conflict must include type, severity, status, affected entities,
  causal events, consumer impact, and resolution options.

- Conflicts must be deduplicated by fingerprint.

- Blocking conflicts prevent mutation/apply operations unless explicitly
  overridden by a permitted resolution.

- Consumer behavior must be read from conflict impact records, not inferred
  independently.

- Resolutions are recorded as events and may create placements, hypotheses,
  category mappings, review tasks, or projection reruns.

- Conflict payloads must be schema-validated.

- Conflict graph is a first-class read model alongside accepted, hypothesis,
  evidence, and review/change graphs.
```

---

# 15. Final verdict

The feedback is correct. The queue model still needed a durable `SemanticConflict` structure.

The design should now include:

```text
SemanticConflict
SemanticConflictEntity
SemanticConflictEvent
SemanticConflictConsumerImpact
SemanticConflictResolutionOption
SemanticConflictResolution
```

And the semantic merge processor should produce conflicts as first-class outputs.

The most important implementation rule is:

```text
When semantic merge detects unsafe state, it must not merely fail or log.
It must emit a typed conflict object that tells every downstream consumer
what happened, what is affected, how severe it is, how to behave, and how
the conflict can be resolved.
```

That closes the ambiguity around how queues, projectors, consumers, and mutation/apply operations should behave when the adaptive taxonomy is in an inconsistent or unresolved state.

[1]: https://www.rfc-editor.org/rfc/rfc9457.html?utm_source=chatgpt.com "RFC 9457: Problem Details for HTTP APIs"
[2]: https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md?utm_source=chatgpt.com "spec/cloudevents/spec.md at main"
[3]: https://json-schema.org/docs?utm_source=chatgpt.com "Docs"
