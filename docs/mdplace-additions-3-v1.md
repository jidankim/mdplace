Yes. The remaining ambiguous parts are mostly **implementation semantics**, not high-level architecture. The design is solid, but before coding you should freeze several decisions so the system does not behave inconsistently later.

The biggest theme is this:

```text
You need to distinguish:
semantic truth
vs hypothesis
vs review state
vs physical projection
vs compatibility alias
vs user-authored metadata
```

The system is safe only if those boundaries remain explicit.

# 1. Does every file need exactly one accepted category?

This is one of the most important unresolved choices.

You have two plausible models:

```text
A. Exactly one primary accepted category.
B. Zero or one primary accepted category, plus many secondary tags/collections.
```

For this system, the better default is:

```text
A file may have zero or one accepted primary category.
A file may have many tags, collections, project contexts, or statuses.
```

So:

```yaml
primary_category: cat:knowledge-graphs
tags:
  - ontology
  - markdown
project_context: project:adaptive-taxonomy
status: draft
```

This avoids the folder tree trying to encode too many dimensions.

Implementation decision:

```text
placement_assertions should probably enforce at most one active accepted
primary placement per file per category scheme.
```

But allow multiple non-primary relationships:

```text
tags
collections
related categories
project contexts
workflow statuses
```

Add a field:

```sql
placement_role TEXT CHECK (
  placement_role IN ('primary', 'secondary', 'suggested')
)
```

Recommended invariant:

```text
At most one accepted primary PlacementAssertion per file per active scheme.
```

---

# 2. Are categories stable across versions, or does each version get new category IDs?

This is subtle.

You can model category identity two ways.

## Option A: stable category IDs across schemes

```text
cat:knowledge-graphs exists across scheme:v1, scheme:v2, scheme:v3
```

Pros:

```text
easy references
simpler frontmatter
less migration noise
```

Cons:

```text
harder to represent changed meaning
```

## Option B: version-specific category IDs

```text
scheme:v2/cat:knowledge-graphs
scheme:v3/cat:knowledge-graphs
```

Pros:

```text
clean historical semantics
clear version boundaries
```

Cons:

```text
more mappings required
more verbose
```

Recommended compromise:

```text
Use stable logical category IDs,
but version the category definitions and scheme membership.
```

So:

```text
cat:knowledge-graphs
```

is stable, but its definition, parent, aliases, or projection path may differ by scheme version.

Add:

```sql
category_versions (
  category_id,
  scheme_id,
  label,
  slug,
  parent_category_id,
  definition,
  status
)
```

Instead of putting all version-specific fields directly in `categories`.

This prevents ambiguity like:

```text
What did cat:knowledge-graphs mean under scheme:v2?
```

---

# 3. Is the folder tree a destructive move or a generated copy?

The current design assumes the projection engine **moves actual Markdown files**.

That is powerful, but it has risk.

Alternative:

```text
Keep canonical files in a stable content store.
Generate folder tree as symlinks, hardlinks, or copies.
```

Options:

```text
A. Move actual files.
B. Generate symlink tree.
C. Generate copied read-only projection.
D. Keep files stable and generate index pages only.
```

For a first implementation, I would choose:

```text
Move actual files, but only after dry-run + validation + manifest.
```

However, make this a projection policy setting:

```yaml
projection_mode: move_files
```

Future alternatives:

```yaml
projection_mode: symlink_tree
projection_mode: copy_tree
projection_mode: index_only
```

That avoids locking the system into one filesystem strategy.

---

# 4. Who owns frontmatter: user or system?

This must be explicit.

Frontmatter has two kinds of fields:

```text
user-authored fields
system-managed fields
```

Recommended split:

```yaml
---
kg_id: file:01JABC                         # system-managed
title: Adaptive Semantic Taxonomy          # user or system-assisted
primary_category: cat:knowledge-graphs     # system-managed
category_scheme: scheme:v3                 # system-managed
placement_id: place:01JABD                 # system-managed
placement_state: accepted                  # system-managed
projection_id: proj:v12                    # system-managed

tags:                                      # user-authored or mixed
  - adaptive-kg
  - markdown

summary: "..."                             # user-authored
---
```

Add a projection policy field:

```yaml
managed_frontmatter_keys:
  - kg_id
  - primary_category
  - category_scheme
  - placement_id
  - placement_state
  - hypothesis_id
  - review_task_id
  - projection_id
```

Invariant:

```text
The frontmatter updater may only modify managed keys.
Unknown keys must be preserved exactly where practical.
```

This prevents the system from damaging user-authored metadata.

---

# 5. What exactly counts as “evidence”?

You already require accepted placements to have evidence, but evidence can be weak.

For example:

```text
existing_folder_prior
```

is evidence, but it might just preserve an old mistake.

You need evidence classes:

```text
strong evidence
weak evidence
negative evidence
human evidence
derived evidence
stale evidence
```

Recommended fields:

```sql
evidence_strength TEXT CHECK (
  evidence_strength IN ('weak', 'medium', 'strong')
);

evidence_polarity TEXT CHECK (
  evidence_polarity IN ('supports', 'contradicts', 'neutral')
);

source_type TEXT CHECK (
  source_type IN ('manual', 'rule', 'embedding', 'link_analysis', 'frontmatter', 'folder_prior')
);
```

Add invariant:

```text
Accepted placement must have at least one positive evidence record,
and no unresolved blocking negative evidence.
```

Without this, the system could accept a placement based only on weak folder-history evidence.

---

# 6. When is evidence stale?

Evidence should be tied to the file version or content hash that produced it.

Otherwise, this can happen:

```text
File was about RAG yesterday.
Evidence supported RAG yesterday.
File was rewritten today about KG.
Old evidence still supports RAG.
```

Recommended:

```sql
evidence.file_version_id
evidence.content_hash
evidence.extractor_version
evidence.created_at
```

Validation rule:

```text
If file content_hash changed after evidence was created,
evidence becomes stale unless marked reusable.
```

Possible statuses:

```text
active
stale
superseded
invalidated
```

This is important for adaptive behavior.

---

# 7. What is the difference between insufficient, ambiguous, and conflicting evidence?

These should not be vague labels. Define them precisely.

Recommended semantics:

```text
insufficient_evidence
  The system lacks enough signal to accept any candidate.

ambiguous
  Multiple candidates are plausible and close in score.

conflicting_evidence
  Some evidence strongly supports one category while other evidence strongly
  supports another, or contradicts the current accepted placement.

accepted_but_under_review
  There is an accepted placement, but new evidence suggests it may be wrong.

manual_override_needed
  Automated policy cannot resolve this; human review required.
```

Example:

```text
insufficient_evidence:
  best score = 0.42

ambiguous:
  KG score = 0.76
  Ontology score = 0.74

conflicting_evidence:
  frontmatter says RAG
  backlinks and headings strongly indicate Knowledge Graphs
```

Add threshold policy:

```yaml
accept_threshold: 0.90
review_threshold: 0.65
ambiguity_margin: 0.07
conflict_negative_evidence_threshold: 0.80
```

These should live in a persisted placement policy, not hardcoded.

---

# 8. What happens to a file with no accepted category?

Now that you have `PlacementHypothesis`, this is clearer, but you still need a projection rule.

Possible states:

```text
no accepted placement + insufficient evidence
  ? _Review/Insufficient Evidence/

no accepted placement + ambiguous
  ? _Review/Ambiguous/

no accepted placement + new unscanned file
  ? Inbox/

no accepted placement + deleted/archived
  ? not projected, or Archive/
```

Recommended:

```text
Inbox is a physical ingestion state.
_Review is a review-state projection.
Neither is a semantic category.
```

So:

```text
notes/Inbox/
```

means:

```text
file discovered but not yet processed
```

Whereas:

```text
notes/_Review/Insufficient Evidence/
```

means:

```text
processed, but no safe accepted placement yet
```

This distinction matters.

---

# 9. Are review folders part of the projection manifest?

They should be.

The manifest should distinguish:

```text
semantic projection
review-state projection
inbox projection
archive projection
```

Example:

```json
{
  "file_id": "file:01JDEF",
  "to": "notes/_Review/Insufficient Evidence/foo.md",
  "projection_reason": "review_state",
  "hypothesis_id": "hyp:001",
  "review_task_id": "review:001",
  "accepted_placement_id": null
}
```

This prevents downstream systems from misreading `_Review` as a category path.

---

# 10. How are category aliases resolved when chains form?

Suppose:

```text
cat:a ? cat:b
cat:b ? cat:c
```

Do you allow alias chains?

Recommended:

```text
Allow chains historically, but resolution must return canonical target.
```

Add fields:

```sql
canonical_target_kind
canonical_target_id
```

or compute canonical resolution with cycle detection.

Validation rules:

```text
No category alias cycles.
No path alias cycles.
No alias chain longer than configured max unless explicitly allowed.
```

For splits:

```text
cat:a ? split_requires_review
```

Do not resolve to a fake single category.

---

# 11. How should category splits affect already accepted placements?

There are two cases.

## Case A: deterministic migration

Old category:

```text
AI Knowledge Systems
```

File evidence clearly maps to:

```text
Knowledge Graphs
```

Then create:

```text
new accepted PlacementAssertion
old placement superseded
```

## Case B: ambiguous migration

Old category split, but file does not clearly map.

Then create:

```text
PlacementHypothesis(status='ambiguous' or 'insufficient_evidence')
ReviewTask
projection into _Review/
```

Do not leave the file accepted under the old deprecated category.

Add migration outcome types:

```text
auto_migrated
review_required
left_compatible_only
failed_validation
```

---

# 12. What is the canonical source for category definitions?

You proposed YAML files plus SQLite. That can create dual-source ambiguity.

Choose one of these:

```text
A. YAML in Git is source of truth; SQLite imports it.
B. SQLite is source of truth; YAML is export.
C. Both are sources, reconciled by version hash.
```

Recommended for MVP:

```text
YAML in Git is source of truth for category schemes and projection policies.
SQLite is source of truth for runtime ledger: files, placements, evidence, events.
```

But persist imported scheme hash in SQLite:

```sql
category_schemes.source_path
category_schemes.source_hash
```

Validation:

```text
active scheme in SQLite must match YAML hash.
```

This prevents drift between `.kg/categories/scheme-v3.yaml` and `ledger.sqlite`.

---

# 13. What happens if users manually move files?

This will happen.

On scan, the system might see:

```text
ledger current_path = notes/Research/KG/foo.md
actual path = notes/Projects/foo.md
```

Possible interpretations:

```text
manual projection override
accidental move
Git branch merge
semantic correction
```

Recommended behavior:

```text
Detect as filesystem drift.
Create FilePathDriftDetected event.
Do not silently update accepted placement.
Create review task unless move matches a valid projection.
```

Command:

```bash
kg reconcile
```

Options:

```text
accept manual move as new placement evidence
restore projected path
treat as non-semantic manual relocation
create category-change proposal
```

This is critical for trust.

---

# 14. How do Git branches interact with the ledger?

If users work on Git branches, `.kg/ledger.sqlite` can be hard to merge.

Options:

```text
A. Store ledger SQLite in Git.
B. Store event log as JSONL files in Git and build SQLite index.
C. Store both: JSONL canonical, SQLite local cache.
```

For multi-branch workflows, I would prefer:

```text
Append-only event log as JSONL or NDJSON in .kg/events/
SQLite as derived local index/cache.
```

For a single-user local-first MVP, SQLite in Git is acceptable but may cause merge pain.

This is a major implementation ambiguity.

Recommended compromise:

```text
MVP: SQLite ledger + periodic JSON export.
Future: event log canonical, SQLite materialized index.
```

---

# 15. How are rollback and undo defined?

There are several rollback types:

```text
filesystem rollback
projection rollback
placement rollback
category scheme rollback
event-log rollback
```

Because events are append-only, you do not delete events. You add compensating events.

Example:

```text
ProjectionApplied
ProjectionRolledBack
```

Rollback should:

```text
use projection manifest
move files back
restore previous frontmatter values
create new path aliases if needed
emit rollback events
```

But accepted placements may or may not revert. Decide:

```text
Does projection rollback only undo physical files?
Or does it also supersede placement assertions?
```

Recommended:

```text
Projection rollback only reverts physical projection.
Semantic rollback requires separate placement/category change reversal.
```

Keep these separate.

---

# 16. How do downstream APIs distinguish semantic category from projection folder?

This matters because `_Review/` and `Inbox/` can be folders.

API should expose:

```json
{
  "file_id": "file:01JDEF",
  "current_path": "notes/_Review/Insufficient Evidence/foo.md",
  "path_reason": "review_state",
  "primary_category": null,
  "placement_state": "insufficient_evidence",
  "hypothesis_id": "hyp:001"
}
```

Not just:

```json
{
  "category_path": "_Review/Insufficient Evidence"
}
```

Add API invariant:

```text
Every path response must include path_reason.
```

Possible `path_reason` values:

```text
accepted_category
review_state
inbox_state
archive_state
manual_override
compatibility_alias
```

---

# 17. Are path aliases permanent?

Old paths can accumulate forever.

Options:

```text
A. Keep all path aliases forever.
B. Keep aliases for a retention window.
C. Keep aliases while referenced by known consumers.
```

Recommended:

```text
Keep all aliases by default for local knowledge systems.
Allow compaction only after explicit archive/export.
```

Add fields:

```sql
path_aliases.status
path_aliases.expires_at
path_aliases.hit_count
path_aliases.last_resolved_at
```

This enables cleanup later.

---

# 18. What should happen when a file is deleted?

Deletion is not just absence.

Possible meanings:

```text
file removed accidentally
file archived
file intentionally deleted
file moved outside managed root
file replaced by another file
```

Recommended states:

```text
active
missing
archived
deleted
replaced
```

Do not delete ledger records. Mark file status:

```sql
files.status = 'missing' | 'deleted' | 'archived'
```

Add events:

```text
FileMissingDetected
FileDeletedConfirmed
FileArchived
FileRestored
```

Projection policy should define whether archived files are materialized.

---

# 19. How do you prevent category tree cycles?

If categories have parents:

```text
A parent B
B parent C
C parent A
```

the projection engine can break.

Validation must check:

```text
no parent cycles
no duplicate slugs under same parent
no path collision after slug normalization
no reserved folder names used as semantic categories
```

Also check filesystem-specific issues:

```text
case-insensitive collisions
Windows-invalid characters
max path length
Unicode normalization
```

This is an easy place for bugs.

---

# 20. What are reserved folders and reserved slugs?

You need a reserved namespace.

Recommended reserved folders:

```text
.kg/
_Review/
_Inbox/
_Archive/
_System/
```

Validation:

```text
No navigational category may use reserved slug unless explicitly allowed.
```

So `cat:review` cannot accidentally project into `_Review`.

---

# 21. How are titles and slugs generated?

Slug generation affects paths.

Ambiguities:

```text
title from frontmatter or first heading?
what if two files have same title?
what if title changes?
does path change when title changes?
```

Recommended:

```text
file_slug is generated from title at projection time,
but stable unless title_slug_policy says otherwise.
```

Projection policy:

```yaml
slug_source: title
slug_update_policy: update_on_title_change
collision_strategy: append-short-file-id
```

Alternative:

```yaml
slug_update_policy: preserve_existing_slug
```

This is important because changing titles can cause path churn.

---

# 22. Does manual override become permanent evidence?

A human decision is strong evidence, but not infallible.

Represent it as:

```text
Evidence(type='manual_user_decision', strength='strong')
```

But allow it to be superseded.

Add:

```text
manual_override = true
manual_override_scope = file | category | project | scheme
```

Validation/audit should respect manual overrides:

```text
Do not auto-supersede manual placements.
Create review warning instead.
```

---

# 23. What is the difference between tag and secondary category?

This needs a clear rule.

Recommended:

```text
Primary category:
  Determines folder path.

Secondary category:
  A weaker semantic classification, not path-determining.

Tag:
  Lightweight label, possibly user-authored, not necessarily in category scheme.

Collection:
  Curated set with membership independent of taxonomy.

Project context:
  Work context, not necessarily topic.
```

Without this, users will ask why a file with tags `ontology` and `RAG` is in one folder but not another.

---

# 24. Should evidence and hypotheses be exposed in frontmatter?

Usually no.

Frontmatter should include IDs:

```yaml
hypothesis_id: hyp:001
review_task_id: review:001
```

Not the whole hypothesis.

Reason:

```text
hypotheses change often
evidence payloads can be large
frontmatter should remain human-readable
```

---

# 25. Is the accepted graph derived or stored?

You can store accepted placements and also derive an accepted graph view.

Recommended:

```text
placement_assertions table stores all placement states.
accepted_graph is a query/view:
  status = accepted
  valid_to IS NULL
  category kind = navigational_category
```

This avoids duplicating truth.

But for speed, materialized accepted views are fine if rebuildable.

---

# 26. Which ambiguities are most urgent?

Before implementation, decide these first:

```text
1. One primary category or multiple?
2. YAML vs SQLite source of truth for category schemes.
3. Move actual files vs generate symlink/copy projection.
4. Exact semantics of insufficient_evidence / ambiguous / conflicting_evidence.
5. Whether SQLite is canonical or event log is canonical.
6. Projection rollback semantics.
7. Frontmatter managed keys.
8. Alias resolution rules, especially split categories.
9. Manual move reconciliation.
10. Slug/path generation policy.
```

These decisions shape the schema and CLI behavior.

---

# Recommended final additions

I would add these to the requirements.

```text
15. The system must support zero accepted placements for a file,
    as long as an active hypothesis or review task explains why.

16. The projection manifest must record path_reason:
    accepted_category, review_state, inbox_state, archive_state,
    manual_override, or compatibility_alias.

17. Frontmatter must distinguish system-managed keys from user-managed keys.

18. Category schemes and projection policies must have source hashes.

19. Alias resolution must support non-category targets and split-requires-review.

20. The system must detect manual filesystem drift and require reconciliation.

21. Projection rollback must be defined separately from semantic rollback.

22. Reserved folder names must not be used as ordinary navigational categories.
```

These are not overengineering. They prevent the exact category/projection confusion that the `UnknownCategory` issue exposed.

# Bottom line

Yes, there are still ambiguous implementation parts. The most important remaining ambiguity is not database syntax; it is **semantic separation**:

```text
category
tag
status
project context
review state
hypothesis
accepted placement
folder path
```

Those must remain separate primitives.

The strongest implementation rule is:

```text
Every physical path must explain whether it came from an accepted semantic
category, a review state, an inbox/archive state, or a compatibility alias.
```

That one rule prevents most future confusion.
