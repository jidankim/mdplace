Yes Ñ this is a **missed requirement/invariant**, or at least an under-specified one.

The previous design had `candidate`, `accepted`, `rejected`, and `superseded` placements, plus a possible `Needs Review` or `To Review` category. But it did **not** clearly distinguish:

```text
Òthis file belongs to category To ReviewÓ
```

from:

```text
Òthe system cannot yet safely assign this file to an accepted semantic categoryÓ
```

That distinction should be made explicit.

# The correction

`To Review`, `Uncategorized`, `Unknown`, `Needs Review`, and `Insufficient Evidence` should **not** be ordinary navigational/domain categories.

They should be **decision states** or **review states**.

For Markdown:

Bad pattern:

```yaml
primary_category: cat:to-review
```

Better pattern:

```yaml
primary_category: null
placement_state: insufficient_evidence
review_task_id: review:01JXYZ
```

Or, if a previous accepted category exists but is now suspicious:

```yaml
primary_category: cat:knowledge-graphs
placement_state: accepted_but_under_review
review_task_id: review:01JXYZ
```

Then the folder tree may still physically materialize the file under:

```text
notes/_Review/Insufficient Evidence/my-note.md
```

but that folder is generated from **review state**, not from the category scheme.

So yes: add a requirement.

```text
11. First-class abstention / insufficient-evidence state.
```

And add an invariant:

```text
The system must never represent Òunable to categorizeÓ as an accepted semantic category.
```

---

# 1. Updated conceptual model

The system should now have four logical graphs or views:

```text
1. Accepted graph
   Only accepted semantic placements.

2. Hypothesis graph
   Candidate placements, scores, reasons, missing evidence, uncertainty.

3. Evidence graph
   Source facts, extracted signals, provenance, timestamps, extraction method.

4. Review/change graph
   Review tasks, decisions, category-change proposals, migrations, aliases.
```

These do not have to be RDF named graphs in the MVP. They can be SQLite tables or materialized views. But the separation is conceptually important. If you later use RDF, RDF datasets and named graphs are a natural fit because RDF datasets are collections of graphs, and named graphs can keep graph contents separate while still participating in one dataset. ([W3C][1])

---

# 2. Why this matters

Without this distinction, the system lies.

If you encode uncertainty as a category:

```text
file ? category: Unknown
file ? category: To Review
file ? category: Uncategorized
```

then downstream systems may treat that as semantic truth:

```text
This file is about ÒTo Review.Ó
This entity is an ÒUnknownCategory.Ó
```

But that is not what you mean. What you mean is:

```text
The system currently lacks enough evidence to safely assert a semantic category.
```

That is a decision-state claim, not a category claim.

For Markdown, the equivalent is:

```text
The file is physically in notes/_Review/
because the projection policy materialized an unresolved review state,
not because _Review is its semantic topic.
```

---

# 3. Updated feature list

The original ten features remain valid, but add three more.

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

11. PlacementHypothesis ledger for candidate/uncertain classifications.
12. ReviewState / ReviewTask ledger for insufficient-evidence decisions.
13. Projection policy support for review-state materialization.
```

The key addition is that Òunable to categorizeÓ becomes a **first-class state** with evidence and missing-evidence records.

---

# 4. Updated invariants

Add these invariants.

```text
No accepted PlacementAssertion may point to pseudo-categories such as
Unknown, Uncategorized, To Review, Needs Review, or Insufficient Evidence.

A file may have zero accepted placements if it has an active
insufficient-evidence PlacementHypothesis or ReviewTask.

A file may be physically projected into a review folder only by projection
policy, not by accepted category membership.

Every insufficient-evidence decision must record candidate categories,
evidence considered, missing evidence, and next review action.

The accepted graph must not contain candidate, rejected, insufficient-evidence,
or under-review assertions.

The hypothesis graph must preserve candidate categories and why they were not
accepted.
```

This gives the system an explicit ÒabstainÓ capability.

---

# 5. How the four graphs map to the Markdown system

## 5.1 Accepted graph

Contains only currently accepted semantic placement assertions.

Example:

```yaml
PlacementAssertion:
  placement_id: place:accepted-001
  file_id: file:adaptive-taxonomy
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  status: accepted
  confidence: 0.91
  evidence:
    - ev:title-terms
    - ev:backlink-neighborhood
```

This graph answers:

```text
What is the current accepted semantic category of this file?
```

It should **not** include:

```text
candidate placements
insufficient-evidence states
review tasks
To Review pseudo-categories
```

For taxonomy concepts themselves, SKOS remains a good reference model because it is designed for concept schemes such as taxonomies, classification schemes, thesauri, and subject headings. ([W3C][2])

---

## 5.2 Hypothesis graph

Contains candidate placements and unresolved decisions.

Example:

```yaml
PlacementHypothesis:
  hypothesis_id: hyp:001
  file_id: file:adaptive-taxonomy
  scheme_id: scheme:v3
  status: insufficient_evidence
  candidates:
    - category_id: cat:knowledge-graphs
      score: 0.61
    - category_id: cat:ontology-engineering
      score: 0.58
    - category_id: cat:rag-systems
      score: 0.54
  missing_evidence:
    - stronger backlink neighborhood
    - clearer frontmatter tags
    - manual confirmation
  generated_by: rule:placement-v2
```

This graph answers:

```text
What might this file be?
Why canÕt we safely assert one category yet?
What evidence is missing?
```

This is where your AcmeCorp example belongs:

```text
TypeHypothesis:
  subject = AcmeCorp
  candidateType = Organization
  status = insufficient_evidence
  missingEvidence = {legal registration, VAT number, source confirmation}
```

For Markdown:

```text
PlacementHypothesis:
  file = adaptive-taxonomy.md
  candidateCategory = Knowledge Graphs
  status = insufficient_evidence
  missingEvidence = {manual review, stronger category-profile match}
```

---

## 5.3 Evidence graph

Contains source facts, extracted features, provenance, timestamps, and confidence.

Example:

```yaml
Evidence:
  evidence_id: ev:heading-terms-001
  file_id: file:adaptive-taxonomy
  file_version: fv:2026-04-25-001
  evidence_type: heading_terms
  supports_category_id: cat:knowledge-graphs
  score: 0.74
  extracted_by: extractor:heading-v1
  extracted_at: 2026-04-25T12:00:00+09:00
```

Evidence can support an accepted placement or a hypothesis.

PROV-O is the relevant standard reference here because it provides classes and properties for representing provenance generated in different systems and under different contexts. ([W3C][3])

---

## 5.4 Review/change graph

Contains review tasks, category-change proposals, human decisions, migrations, aliases, and projection decisions.

Example:

```yaml
ReviewTask:
  review_task_id: review:001
  file_id: file:adaptive-taxonomy
  hypothesis_id: hyp:001
  review_state: open
  reason: insufficient_evidence
  recommended_action: ask_user_or_wait_for_more_links
  created_at: 2026-04-25T12:00:00+09:00
```

This graph answers:

```text
What needs review?
Who reviewed it?
What changed?
Was the category split, merged, renamed, or deprecated?
What migration applied?
```

This graph also contains:

```text
CategoryChange
CategoryChangeItem
CategoryMapping
CategoryAlias
MigrationRule
ProjectionRun
ValidationRun
PathAlias
```

---

# 6. Updated frontmatter

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
tags:
  - adaptive-kg
  - taxonomy
---
```

For an unresolved file:

```yaml
---
kg_id: file:01JDEF
title: Untitled Semantic Notes
primary_category:
category_scheme: scheme:v3
placement_state: insufficient_evidence
hypothesis_id: hyp:001
review_task_id: review:001
projection_id: proj:v13
tags: []
---
```

For a file with an accepted category but a new audit warning:

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

This preserves the current accepted category while acknowledging that the system is reconsidering it.

---

# 7. Folder materialization with review states

A physical folder called `To Review` can still exist.

But it should be generated by projection policy from review state:

```yaml
ProjectionPolicy:
  policy_id: policy:primary-category-with-review-v2
  rules:
    - if: placement_state == accepted
      path_template: "{category_path}/{file_slug}.md"

    - if: placement_state == insufficient_evidence
      path_template: "_Review/Insufficient Evidence/{file_slug}.md"

    - if: placement_state == accepted_but_under_review
      path_template: "_Review/Audit Warnings/{file_slug}.md"
```

This is good:

```text
notes/_Review/Insufficient Evidence/untitled-semantic-notes.md
```

as long as the ledger says:

```text
placement_state = insufficient_evidence
primary_category = null
```

not:

```text
primary_category = cat:to-review
```

So `To Review` is allowed as a **projection folder**, but not as an **accepted semantic category**.

---

# 8. Schema additions

Add a placement hypothesis table.

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

Add candidate categories for each hypothesis.

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

Add missing evidence.

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

Add review tasks.

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

Add review decisions.

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

# 9. Validation additions

Add validation rules:

```text
No active category may have slug unknown, uncategorized, to-review,
needs-review, or insufficient-evidence unless its kind is workflow_status
or deprecated_category.

No accepted PlacementAssertion may point to a category whose kind is
workflow_status, candidate_category, or deprecated_category.

A file with no accepted PlacementAssertion must have either:
  active PlacementHypothesis, or
  open ReviewTask, or
  explicit archived/deleted status.

A file physically projected into _Review/ must have placement_state of
insufficient_evidence, ambiguous, conflicting_evidence, or accepted_but_under_review.

A file physically projected into a normal category folder must have an accepted
PlacementAssertion.

Every insufficient_evidence hypothesis must record at least one candidate
category or an explicit reason that no candidate category is currently available.

Every insufficient_evidence hypothesis must record at least one
missing_evidence requirement.
```

SHACL is the RDF-native way to express graph validation constraints if this later becomes RDF; for the SQLite MVP, implement the same constraints with SQL checks, triggers, and validation queries. SHACL is explicitly defined as a language for validating RDF graphs against conditions expressed as shapes. ([W3C][4])

---

# 10. Updated projection behavior

The projection engine now needs two categories of projections:

```text
Semantic category projection:
  accepted placements ? category folders

Review-state projection:
  unresolved hypotheses / review tasks ? review folders
```

Example projection rules:

```yaml
rules:
  - name: accepted-placement
    condition:
      placement_state: accepted
    path_template: "{category_path}/{file_slug}.md"

  - name: insufficient-evidence
    condition:
      placement_state: insufficient_evidence
    path_template: "_Review/Insufficient Evidence/{file_slug}.md"

  - name: ambiguous
    condition:
      placement_state: ambiguous
    path_template: "_Review/Ambiguous/{file_slug}.md"

  - name: conflicting-evidence
    condition:
      placement_state: conflicting_evidence
    path_template: "_Review/Conflicting Evidence/{file_slug}.md"

  - name: audit-warning
    condition:
      placement_state: accepted_but_under_review
    path_template: "_Review/Audit Warnings/{file_slug}.md"
```

This means the folder tree is now a projection of both:

```text
accepted semantic placements
+
review states
```

But the accepted graph remains clean.

---

# 11. Updated answer to the original invariant set

The previous invariant:

```text
Why is this Markdown file in this folder?
```

now has two possible answer types.

## If accepted

```text
It is in this folder because accepted placement place:123 assigned it to
cat:knowledge-graphs under scheme:v3, and projection proj:v12 materialized
that category path.
```

## If unresolved

```text
It is in _Review/Insufficient Evidence because hypothesis hyp:001 found
candidate categories but none exceeded acceptance criteria. Missing evidence:
manual confirmation and stronger backlink signal. Projection proj:v13
materialized the review state according to policy review-v2.
```

So the invariant should be expanded:

```text
Why is this Markdown file in this folder?
  If category folder: accepted PlacementAssertion.
  If review folder: active PlacementHypothesis or ReviewTask.
```

---

# 12. Does this affect the earlier ÒTo ReviewÓ category?

Yes. It changes how `To Review` should be represented.

Do not define:

```yaml
Category:
  category_id: cat:to-review
  kind: navigational_category
```

Instead define either:

```yaml
ReviewState:
  value: insufficient_evidence
```

or, if you want UI taxonomy for review queues:

```yaml
Category:
  category_id: status:to-review
  kind: workflow_status
```

Then validation prevents it from being used as an accepted placement category.

So a file may be physically under:

```text
notes/_Review/To Review/file.md
```

but semantically:

```text
placement_state = insufficient_evidence
primary_category = null
```

or:

```text
placement_state = accepted_but_under_review
primary_category = cat:knowledge-graphs
```

---

# 13. Updated requirements checklist

The updated system should now implement:

```text
1. Stable kg_id in every Markdown file.
2. Versioned category scheme.
3. PlacementAssertion ledger for accepted placements.
4. PlacementHypothesis ledger for candidate/uncertain placements.
5. Evidence records for accepted placements and hypotheses.
6. MissingEvidence records for insufficient-evidence decisions.
7. ReviewTask and ReviewDecision records.
8. Append-only event history.
9. Projection engine that can materialize accepted categories and review states.
10. Projection manifest for every generated folder tree.
11. Frontmatter updater.
12. Validation preflight before any move.
13. Compatibility map for old paths and old categories.
14. Rule that Òunable to categorizeÓ is never an accepted semantic category.
```

This is the right corrected requirement set.

---

# 14. Final verdict

Yes Ñ the Òunable to categorize right nowÓ state was a missed or under-specified requirement.

The corrected design is:

```text
Accepted graph:
  accepted placements only

Hypothesis graph:
  candidates, scores, uncertainty, missing evidence

Evidence graph:
  extracted signals, provenance, source facts

Review/change graph:
  review tasks, decisions, taxonomy changes, migrations
```

And the key invariant is:

```text
Physical review folders are allowed.
Semantic UnknownCategory is not.
```

In Markdown terms:

```text
notes/_Review/Insufficient Evidence/foo.md
```

is valid as a generated projection.

But this is invalid as semantic truth:

```yaml
primary_category: cat:unknown
```

The ledger should instead say:

```yaml
placement_state: insufficient_evidence
hypothesis_id: hyp:001
review_task_id: review:001
missing_evidence:
  - manual confirmation
  - stronger backlink signal
```

That keeps the accepted taxonomy clean while still giving the adaptive system a safe, explicit way to abstain.

[1]: https://www.w3.org/TR/rdf12-concepts/ "RDF 1.2 Concepts and Abstract Data Model"
[2]: https://www.w3.org/TR/skos-reference/ "SKOS Simple Knowledge Organization System Reference"
[3]: https://www.w3.org/TR/prov-o/ "PROV-O: The PROV Ontology"
[4]: https://www.w3.org/TR/shacl/ "Shapes Constraint Language (SHACL)"
