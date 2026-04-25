Yes. This finding **does change the design and requirements**. It is not just a naming cleanup. It reveals a missing semantic layer: the system needs to represent **abstention** Ñ ÒI cannot safely categorize this right nowÓ Ñ as a first-class decision state.

The earlier design was close, but it risked conflating:

```text
semantic category
```

with:

```text
review / uncertainty / workflow state
```

That is a real hole.

# Main update

The system should no longer be described only as:

```text
PlacementAssertion ledger
```

It should be:

```text
Accepted PlacementAssertion ledger
+ PlacementHypothesis ledger
+ Evidence ledger
+ Review/change ledger
```

So the corrected split is:

```text
Accepted graph
  Only accepted semantic placements.

Hypothesis graph
  Candidate placements, scores, ambiguity, insufficient evidence.

Evidence graph
  Signals, extracted facts, provenance, source version, confidence.

Review/change graph
  Review tasks, decisions, category changes, migrations, aliases.
```

This is now a core architectural requirement.

---

# Updated requirements

The old feature list should be expanded from 10 to 14.

## Previous required features

```text
1. Stable kg_id in every Markdown file.
2. Versioned category scheme.
3. PlacementAssertion ledger.
4. Evidence records for every placement.
5. Append-only event history.
6. Projection engine that moves files.
7. Projection manifest for every generated folder tree.
8. Frontmatter updater.
9. Validation preflight before any move.
10. Compatibility map for old paths and old categories.
```

## Add these

```text
11. PlacementHypothesis ledger for candidate, ambiguous, and insufficient-evidence placements.

12. MissingEvidence records explaining why no accepted placement exists yet.

13. ReviewTask / ReviewDecision ledger for unresolved, ambiguous, or disputed placements.

14. Explicit invariant that Òunable to categorizeÓ is never represented as an accepted semantic category.
```

So the updated feature set is:

```text
Stable kg_id
Versioned category scheme
Accepted PlacementAssertion ledger
PlacementHypothesis ledger
Evidence records
MissingEvidence records
ReviewTask / ReviewDecision records
Append-only event history
Projection engine
Projection manifest
Frontmatter updater
Validation preflight
Path/category compatibility maps
No pseudo-category for ÒunknownÓ
```

---

# Updated invariants

The original invariants still hold, but one now branches.

## Existing invariant

```text
Why is this Markdown file in this folder?
```

Now it has two valid answer types.

### Case A Ñ normal category folder

```text
This file is here because accepted PlacementAssertion place:123
assigned file:abc to cat:knowledge-graphs under scheme:v3,
and projection proj:v12 materialized that category path.
```

### Case B Ñ review folder

```text
This file is here because active PlacementHypothesis hyp:456
has status insufficient_evidence. The system could not safely accept
any candidate category yet. Projection proj:v13 materialized this review
state into _Review/Insufficient Evidence/.
```

That means the folder tree is now a projection of both:

```text
accepted semantic placements
+
review / uncertainty states
```

But the accepted graph remains clean.

---

# New hard invariant

Add this:

```text
No accepted PlacementAssertion may point to pseudo-categories such as:
Unknown, Uncategorized, To Review, Needs Review, Insufficient Evidence,
Ambiguous, or Conflicting Evidence.
```

Those may appear as:

```text
review states
workflow statuses
projection folders
review queues
```

but not as accepted semantic categories.

---

# Frontmatter update

For an accepted file:

```yaml
---
kg_id: file:01JABC
title: Adaptive Semantic Taxonomy
primary_category: cat:knowledge-graphs
category_scheme: scheme:v3
placement_id: place:accepted-001
placement_state: accepted
projection_id: proj:v12
---
```

For an unresolved file:

```yaml
---
kg_id: file:01JDEF
title: Untitled Semantic Note
primary_category:
category_scheme: scheme:v3
placement_state: insufficient_evidence
hypothesis_id: hyp:001
review_task_id: review:001
projection_id: proj:v13
---
```

For an accepted file under audit:

```yaml
---
kg_id: file:01JGHI
title: GraphRAG and Knowledge Graphs
primary_category: cat:rag-systems
category_scheme: scheme:v3
placement_id: place:accepted-044
placement_state: accepted_but_under_review
hypothesis_id: hyp:089
review_task_id: review:089
projection_id: proj:v14
---
```

So frontmatter now needs a `placement_state`.

---

# Projection update

The projection policy must support review-state materialization.

Before, projection was roughly:

```text
accepted category ? folder path
```

Now it is:

```text
accepted category ? semantic folder path
review state       ? review folder path
```

Example:

```yaml
ProjectionPolicy:
  rules:
    - if: placement_state == accepted
      path_template: "{category_path}/{file_slug}.md"

    - if: placement_state == insufficient_evidence
      path_template: "_Review/Insufficient Evidence/{file_slug}.md"

    - if: placement_state == ambiguous
      path_template: "_Review/Ambiguous/{file_slug}.md"

    - if: placement_state == conflicting_evidence
      path_template: "_Review/Conflicting Evidence/{file_slug}.md"

    - if: placement_state == accepted_but_under_review
      path_template: "_Review/Audit Warnings/{file_slug}.md"
```

This allows physical folders like:

```text
notes/_Review/Insufficient Evidence/foo.md
```

without polluting the category scheme with:

```text
cat:unknown
cat:to-review
cat:uncategorized
```

---

# Schema changes

Yes, the schema needs new tables.

## Add `placement_hypotheses`

```sql
CREATE TABLE placement_hypotheses (
  hypothesis_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),

  status TEXT NOT NULL CHECK (
    status IN (
      'candidate',
      'insufficient_evidence',
      'ambiguous',
      'conflicting_evidence',
      'rejected',
      'promoted_to_placement',
      'superseded'
    )
  ),

  generated_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_placement_id TEXT REFERENCES placement_assertions(placement_id),
  supersedes TEXT REFERENCES placement_hypotheses(hypothesis_id)
);
```

## Add candidate categories

```sql
CREATE TABLE placement_hypothesis_candidates (
  hypothesis_id TEXT NOT NULL REFERENCES placement_hypotheses(hypothesis_id),
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  score REAL CHECK (score >= 0.0 AND score <= 1.0),
  rank INTEGER,
  rationale TEXT,
  PRIMARY KEY (hypothesis_id, category_id)
);
```

## Add missing evidence

```sql
CREATE TABLE missing_evidence_requirements (
  missing_evidence_id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES placement_hypotheses(hypothesis_id),

  requirement_type TEXT NOT NULL CHECK (
    requirement_type IN (
      'manual_confirmation',
      'stronger_title_signal',
      'stronger_heading_signal',
      'frontmatter_tag',
      'backlink_signal',
      'outgoing_link_signal',
      'category_profile_match',
      'source_confirmation',
      'content_disambiguation',
      'category_scheme_update'
    )
  ),

  description TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('missing', 'satisfied', 'waived')
  ),
  created_at TEXT NOT NULL,
  satisfied_at TEXT
);
```

## Add review tasks

```sql
CREATE TABLE review_tasks (
  review_task_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  hypothesis_id TEXT REFERENCES placement_hypotheses(hypothesis_id),

  review_type TEXT NOT NULL CHECK (
    review_type IN (
      'insufficient_evidence',
      'ambiguous_category',
      'conflicting_evidence',
      'category_drift_warning',
      'manual_override_needed',
      'category_change_needed'
    )
  ),

  status TEXT NOT NULL CHECK (
    status IN ('open', 'in_progress', 'resolved', 'dismissed')
  ),

  recommended_action TEXT,
  assigned_to TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

## Add review decisions

```sql
CREATE TABLE review_decisions (
  decision_id TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL REFERENCES review_tasks(review_task_id),

  decision_type TEXT NOT NULL CHECK (
    decision_type IN (
      'accept_candidate',
      'reject_candidate',
      'request_more_evidence',
      'create_new_category',
      'split_category',
      'merge_category',
      'convert_category_to_status',
      'leave_uncategorized'
    )
  ),

  actor TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL,
  resulting_placement_id TEXT REFERENCES placement_assertions(placement_id),
  resulting_category_change_id TEXT REFERENCES category_changes(change_id)
);
```

---

# Validation updates

Add these validation rules.

```text
1. No accepted PlacementAssertion may point to workflow_status,
   candidate_category, deprecated_category, or pseudo-review categories.

2. No active category may have slug unknown, uncategorized, to-review,
   needs-review, insufficient-evidence, ambiguous, or conflicting-evidence
   unless its kind is workflow_status or deprecated_category.

3. A file with no accepted PlacementAssertion must have one of:
   active PlacementHypothesis,
   open ReviewTask,
   archived/deleted/missing file status.

4. A file projected into _Review/ must have a review-state cause:
   insufficient_evidence, ambiguous, conflicting_evidence,
   accepted_but_under_review, or manual_override_needed.

5. A file projected into a normal semantic folder must have an accepted
   PlacementAssertion.

6. Every insufficient_evidence hypothesis must record candidate categories
   or an explicit reason that no candidate can currently be generated.

7. Every insufficient_evidence hypothesis must record at least one
   MissingEvidenceRequirement.

8. Projection manifests must distinguish semantic moves from review-state moves.
```

These close the hole.

---

# Compatibility update

Category mappings must support targets that are not categories.

Previously:

```text
old category ? new category
```

Now it must support:

```text
old category ? new category
old category ? tag
old category ? workflow status
old category ? project context
old category ? review-state resolver
old category ? split requiring review
```

So `category_mappings` needs:

```text
to_target_kind:
  category
  topic_tag
  workflow_status
  project_context
  collection
  none
  split_requires_review
```

Example:

```yaml
old_category: cat:to-review
to_target_kind: workflow_status
to_target_value: to-review
mapping_type: converted_to_status
```

Example split:

```yaml
old_category: cat:ai-knowledge-systems
to_target_kind: none
mapping_type: split_requires_review
possible_targets:
  - cat:knowledge-graphs
  - cat:rag-systems
  - cat:ontology-engineering
```

This avoids lying through oversimplified aliases.

---

# Holes found

Yes, several holes were found.

## 1. No explicit abstention state

Earlier design could categorize or recategorize, but did not clearly represent:

```text
The system should not categorize this yet.
```

Now fixed with:

```text
PlacementHypothesis.status = insufficient_evidence
```

---

## 2. Review folders were conflated with categories

Earlier design allowed `To Review` as a folder, but needed sharper semantics.

Now fixed:

```text
_Review/ is a projection folder, not a semantic category.
```

---

## 3. Accepted graph could be polluted

Without this correction, pseudo-categories like `Unknown` or `To Review` might enter the accepted graph.

Now fixed:

```text
Accepted graph only contains accepted semantic placements.
```

---

## 4. Missing evidence was not represented

Earlier evidence explained accepted placements, but did not explain why a placement was not accepted.

Now fixed:

```text
MissingEvidenceRequirement
```

---

## 5. No durable explanation for non-categorization

Before, an uncategorized file might just sit somewhere.

Now it can say:

```text
candidate categories considered
scores
evidence considered
missing evidence
review task
recommended action
```

---

## 6. Projection policy was incomplete

Projection previously materialized categories. It now must materialize:

```text
accepted categories
+
review states
```

This is a real update.

---

## 7. Downstream APIs could misinterpret review folders

A consumer might see:

```text
_Review/Insufficient Evidence/foo.md
```

and think it is a semantic category.

Now APIs should expose:

```json
{
  "placement_state": "insufficient_evidence",
  "primary_category": null,
  "review_task_id": "review:001"
}
```

---

## 8. Category aliases were too narrow

Simple aliases are not enough. Some old categories become statuses, tags, or split decisions.

Now fixed with richer `category_mappings`.

---

# Updated final architecture

The corrected architecture is:

```text
Markdown files
  content

Frontmatter
  kg_id + placement_state + current bridge fields

Accepted graph
  accepted PlacementAssertions only

Hypothesis graph
  candidate categories, uncertainty, insufficient evidence

Evidence graph
  source signals, provenance, scores, extraction metadata

Review/change graph
  ReviewTasks, ReviewDecisions, CategoryChanges, Migrations

Projection engine
  materializes accepted semantic folders and review-state folders

Compatibility layer
  old paths, old categories, category conversions, split guidance

Validation layer
  prevents pseudo-categories from entering accepted graph
```

---

# Final answer

Yes Ñ this finding updates the design and requirements.

The most important new requirement is:

```text
The system must be able to abstain from categorization without inventing
an ÒUnknownÓ or ÒTo ReviewÓ semantic category.
```

The most important new invariant is:

```text
Physical review folders are allowed.
Semantic UnknownCategory is not.
```

So this is valid:

```text
notes/_Review/Insufficient Evidence/foo.md
```

if the ledger says:

```yaml
placement_state: insufficient_evidence
hypothesis_id: hyp:001
review_task_id: review:001
primary_category: null
```

But this is invalid:

```yaml
primary_category: cat:unknown
```

The updated design is stronger because it can now distinguish:

```text
accepted knowledge
candidate knowledge
insufficient evidence
review workflow
category evolution
folder projection
```

That distinction is necessary for a truly adaptive semantic taxonomy.
