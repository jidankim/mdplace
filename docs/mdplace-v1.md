# Adaptive Markdown Semantic Taxonomy Ñ implementation-ready design

The refined system should be treated as a **semantic control plane for Markdown files**. The physical folder tree is only a materialized read model.

```text
Semantic ledger       = truth, evidence, history, taxonomy evolution
Category scheme       = versioned navigational ontology
Markdown folder tree  = generated projection
Frontmatter           = stable bridge between file and ledger
APIs / manifests      = compatibility-preserving views
```

The key invariant remains:

```text
A file is not Òin a folderÓ because the folder exists.
A file is in that folder because an accepted PlacementAssertion says so,
under a specific category scheme, with evidence, and under a projection policy.
```

This design borrows from several grounded practices: **SKOS-like concept schemes** for taxonomy management, **PROV-O-like provenance** for evidence and lineage, **event sourcing** for durable history, **CQRS/materialized views** for the ledger/projection split, and **SHACL/JSON-Schema-like validation** for preflight checks. SKOS is explicitly designed for knowledge organization systems such as taxonomies, thesauri, classification schemes, and subject headings; PROV-O gives a standard provenance model for representing and exchanging provenance across systems; and SHACL defines shape-based validation for RDF graphs. ([W3C][1])

---

## 1. Core architecture

```text
repo/
  notes/                         # generated folder projection
    Research/
    Projects/
    Reference/
    ...

  .mdplace/
    ledger.sqlite                # semantic ledger
    categories/
      scheme-v1.yaml
      scheme-v2.yaml
      scheme-v3.yaml
    rules/
      placement-rules.yaml
      projection-policies.yaml
    migrations/
      scheme-v2-to-v3.yaml
    projections/
      proj-v001.json
      proj-v002.json
    validation/
      validation-v001.json
    api/
      files-current.json
      categories-current.json
      path-aliases.json
```

The folder tree under `notes/` is analogous to a **materialized view**: it is persisted for convenience, but it is rebuildable from authoritative semantic state. PostgreSQL describes materialized views as views whose results are stored in table-like form, while event sourcing stores every application-state change as an event that can be queried or replayed to reconstruct state. ([PostgreSQL][2])

The design also follows **CQRS**: the command/write model is the semantic ledger, while the read models are generated folder trees, manifests, APIs, category pages, and search indexes. FowlerÕs CQRS description frames this as separating the update model from the display/query model. ([martinfowler.com][3])

---

## 2. Necessary durable primitives

These are the primitives that must exist from the beginning.

```text
FileEntity
FileVersion
CategoryScheme
Category
CategoryAlias / CategoryMapping
PlacementAssertion
Evidence
Event
CategoryChange
CategoryChangeItem
MigrationRule
ProjectionPolicy
ProjectionRun
ProjectionManifest
ProjectedPath
ValidationRun
PathAlias
ConsumerContract
```

You can implement these in SQLite first, with optional RDF/SKOS/PROV export later. SQLite is a practical MVP ledger because it supports relational integrity such as foreign keys, while JSON Schema can validate structured JSON/YAML artifacts such as category schemes, projection policies, and migration files. ([SQLite][4])

---

# 3. Primitive definitions

## 3.1 `FileEntity`

A `FileEntity` is the stable semantic identity of a Markdown file.

```yaml
FileEntity:
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  current_path: notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
  title: Adaptive Semantic Taxonomy
  content_hash: sha256:...
  frontmatter_hash: sha256:...
  status: active
  created_at: 2026-04-25T10:15:00+09:00
  last_seen_at: 2026-04-25T11:30:00+09:00
```

The path is not identity. It is the current projection. Git already stores project history as interrelated snapshots called commits, but the semantic ledger explains **why** a file moved, which Git does not know by itself. ([Git][5])

---

## 3.2 Frontmatter bridge

Frontmatter should contain only the stable bridge fields.

```yaml
---
mdplace_id: file:01JABC9Q4S0AH7E5Q2M3X6
title: Adaptive Semantic Taxonomy
primary_category: cat:knowledge-graphs
category_scheme: scheme:v3
placement_id: place:01JABD2F8MMZD5M3ZC5T
projection_id: proj:v12
status: active
tags:
  - adaptive-mdplace
  - markdown
  - taxonomy
---
```

YAML frontmatter is a standard Markdown metadata convention used by tools such as GitHub Docs, Jekyll, and Obsidian; GitHub Docs describes it as key-value metadata at the top of Markdown files, Jekyll requires the block at the start of the file for processing, and Obsidian stores properties in YAML at the top of a note. ([GitHub Docs][6])

Do **not** put the whole semantic history in frontmatter.

Frontmatter should answer:

```text
Which mdplace file entity am I?
Which category currently places me?
Which category scheme was used?
Which placement assertion explains this?
Which projection produced this path?
```

The ledger should answer everything else.

---

## 3.3 `CategoryScheme`

A `CategoryScheme` is the versioned navigational ontology.

```yaml
CategoryScheme:
  scheme_id: scheme:v3
  label: Main Markdown Taxonomy
  version: 3
  status: active
  previous_scheme: scheme:v2
  created_at: 2026-04-25T10:00:00+09:00
```

For this system, a SKOS-like model is usually more appropriate than a strict OWL class hierarchy. Markdown folders are primarily **navigation concepts**, not formal logical classes. SKOS was created specifically for concept schemes such as taxonomies, thesauri, subject heading systems, and classification schemes. ([W3C][1])

---

## 3.4 `Category`

A `Category` is a node in a versioned category scheme.

```yaml
Category:
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  label: Knowledge Graphs
  slug: knowledge-graphs
  kind: navigational_category
  parent_category_id: cat:semantic-systems
  definition: Notes primarily about graph-based semantic representation.
  status: active
  aliases:
    - mdplace
    - Semantic Graphs
```

Use `kind` to prevent every useful label from becoming a folder.

```text
navigational_category   ? may become a folder
topic_tag               ? metadata/tag
project_context         ? project-oriented view
workflow_status         ? status field, not folder
collection              ? curated set
candidate_category      ? proposed but not accepted
deprecated_category     ? compatibility only
```

This is important because categories like `To Review`, `Draft`, `Archived`, `Important`, and `Project X` are usually not the same kind of thing as `Knowledge Graphs` or `Ontology Engineering`.

---

## 3.5 `CategoryAlias` / `CategoryMapping`

This is one of the hardening additions. Old categories must resolve just like old paths.

```yaml
CategoryAlias:
  old_category_id: cat:semantic-graphs
  new_category_id: cat:knowledge-graphs
  from_scheme: scheme:v2
  to_scheme: scheme:v3
  alias_type: merged_into
  change_id: change:merge-semantic-graphs-mdplace
  created_at: 2026-04-25T12:00:00+09:00
```

This allows old APIs, old frontmatter, old category pages, and old scripts to keep working.

Examples:

```text
cat:semantic-graphs ? cat:knowledge-graphs
cat:to-review       ? status:to-review
cat:ai-knowledge    ? split into cat:knowledge-graphs, cat:rag-systems, cat:ontology-engineering
```

mdplaceCL is a useful reference point here because it is a data model for describing high-level changes to ontologies or ontology-like artifacts; it supports communicating and processing edits such as renaming, obsoleting, moving, and synonym operations. ([IncaTools][7])

---

## 3.6 `PlacementAssertion`

This is the semantic core.

```yaml
PlacementAssertion:
  placement_id: place:01JABD2F8MMZD5M3ZC5T
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  confidence: 0.91
  status: accepted
  evidence:
    - ev:title-terms
    - ev:heading-terms
    - ev:backlink-neighborhood
    - ev:manual-review
  generated_by: rule:placement-v2
  accepted_by: system:auto
  valid_from: 2026-04-25T10:20:00+09:00
  valid_to: null
  transaction_time: 2026-04-25T10:20:00+09:00
  supersedes: place:01JAB5OLD
```

A placement assertion says:

```text
File F belongs under Category C,
under CategoryScheme S,
because Evidence E supports that judgment,
according to Rule/Actor R,
at Time T,
with Confidence X.
```

Use both valid time and transaction time when practical. Bitemporal modeling is useful because it distinguishes Òwhen the placement was valid in the modeled worldÓ from Òwhen the system recorded or learned that placement.Ó ([martinfowler.com][8])

Enforcement rule:

```text
An accepted PlacementAssertion must have at least one Evidence record.
```

---

## 3.7 `Evidence`

Evidence explains why the placement was made.

```yaml
Evidence:
  evidence_id: ev:backlink-neighborhood
  placement_id: place:01JABD2F8MMZD5M3ZC5T
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  evidence_type: backlink_similarity
  supports_category_id: cat:knowledge-graphs
  score: 0.84
  payload:
    linked_files:
      - file:ontology-modularity
      - file:mdplace-refinement
      - file:semantic-control-plane
```

Evidence types:

```text
title_terms
heading_terms
frontmatter_tags
manual_user_decision
folder_history_prior
outgoing_links
backlinks
neighbor_category_distribution
embedding_similarity
rule_match
negative_evidence
category_profile_match
```

PROV-O is the relevant theory/practice anchor: it gives a standard model for provenance information across systems and contexts, including the ideas of entities, activities, agents, and derivation. ([W3C][9])

---

## 3.8 `Event`

The event log is append-only.

```yaml
Event:
  event_id: evt:01JABF...
  event_type: PlacementSuperseded
  aggregate_type: file
  aggregate_id: file:01JABC9Q4S0AH7E5Q2M3X6
  actor: system:placement-audit-v2
  occurred_at: 2026-04-25T11:12:00+09:00
  payload:
    old_placement: place:old
    new_placement: place:new
    from_category: cat:rag-systems
    to_category: cat:knowledge-graphs
    reason: Backlink and content profile shifted toward Knowledge Graphs.
```

Essential event types:

```text
FileDiscovered
FileIdentityMinted
FileContentChanged
FrontmatterParsed
FrontmatterUpdated
PlacementProposed
PlacementAccepted
PlacementRejected
PlacementSuperseded
CategoryCreated
CategoryRenamed
CategoryMoved
CategorySplit
CategoryMerged
CategoryDeprecated
CategoryConvertedToTag
CategoryConvertedToStatus
ProjectionDryRunCreated
ValidationPassed
ValidationFailed
ProjectionApplied
ProjectionRolledBack
PathAliasCreated
CategoryAliasCreated
ManualOverrideRecorded
```

Event sourcing is directly relevant because it records state changes as a sequence of events and supports reconstruction of past states or retroactive corrections. ([martinfowler.com][10])

---

## 3.9 `CategoryChange` and `CategoryChangeItem`

`CategoryChange` records the category evolution event. `CategoryChangeItem` makes it queryable.

```yaml
CategoryChange:
  change_id: change:split-ai-knowledge-systems
  operation: split_category
  from_scheme: scheme:v2
  to_scheme: scheme:v3
  rationale: Category became too broad after 142 notes accumulated.
  status: applied
  migration_id: migration:scheme-v2-to-v3
  created_at: 2026-04-25T12:00:00+09:00
  applied_at: 2026-04-25T12:30:00+09:00

CategoryChangeItem:
  change_id: change:split-ai-knowledge-systems
  category_id: cat:ai-knowledge-systems
  role: split_from

CategoryChangeItem:
  change_id: change:split-ai-knowledge-systems
  category_id: cat:knowledge-graphs
  role: split_into
```

Supported operations:

```text
create_category
rename_category
move_category
split_category
merge_categories
deprecate_category
convert_category_to_tag
convert_category_to_status
convert_category_to_project_context
change_projection_policy
```

This is the Markdown-scale analogue of ontology change management. OntoRipple is a relevant larger-scale analogue because it propagates ontology changes into mappings and validation shapes so that mdplace construction and validation remain consistent as the ontology evolves. ([ScienceDirect][11])

---

## 3.10 `MigrationRule`

Every category change needs a migration rule.

```yaml
MigrationRule:
  migration_id: migration:scheme-v2-to-v3
  from_scheme: scheme:v2
  to_scheme: scheme:v3
  rules:
    - when:
        old_category: cat:ai-knowledge-systems
        file_profile: knowledge_graphs
      assign_category: cat:knowledge-graphs

    - when:
        old_category: cat:ai-knowledge-systems
        file_profile: rag
      assign_category: cat:rag-systems

    - when:
        old_category: cat:ai-knowledge-systems
        confidence_below: 0.65
      assign_category: cat:needs-review
```

Category theory is optional here, but useful later. Functorial data migration models schemas and schema mappings formally, and CQL is an applied category-theoretic data migration/integration language where schemas and mappings induce data transformations. For this Markdown system, the practical takeaway is: every taxonomy migration should state what is preserved, what is rewritten, what becomes an alias, and where review is required. ([arXiv][12])

---

## 3.11 `ProjectionPolicy`

This is another hardening addition. A projection must be reproducible.

```yaml
ProjectionPolicy:
  policy_id: policy:primary-category-folders-v1
  root: notes/
  path_template: "{category_path}/{file_slug}.md"
  category_source: primary_category
  collision_strategy: append-short-file-id
  update_frontmatter: true
  create_path_aliases: true
  dry_run_required: true
```

Without persisted projection policies, you cannot confidently answer:

```text
What would happen if we rebuild the folder tree today?
```

---

## 3.12 `ProjectionRun` and `ProjectionManifest`

```yaml
ProjectionRun:
  projection_id: proj:v12
  scheme_id: scheme:v3
  policy_id: policy:primary-category-folders-v1
  status: applied
  generated_at: 2026-04-25T11:00:00+09:00
  applied_at: 2026-04-25T11:05:00+09:00
  manifest_path: .mdplace/projections/proj-v12.json
```

Projection manifest:

```json
{
  "projection_id": "proj:v12",
  "scheme_id": "scheme:v3",
  "policy_id": "policy:primary-category-folders-v1",
  "moves": [
    {
      "file_id": "file:01JABC9Q4S0AH7E5Q2M3X6",
      "from": "notes/Research/RAG Systems/adaptive-taxonomy.md",
      "to": "notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md",
      "placement_id": "place:01JABD2F8MMZD5M3ZC5T",
      "action": "move"
    }
  ],
  "frontmatter_updates": [
    {
      "file_id": "file:01JABC9Q4S0AH7E5Q2M3X6",
      "fields": ["primary_category", "category_scheme", "placement_id", "projection_id"]
    }
  ]
}
```

---

## 3.13 `ValidationRun`

A projection cannot be applied unless validation passes.

```yaml
ValidationRun:
  validation_id: validation:proj-v12
  projection_id: proj:v12
  status: passed
  report_path: .mdplace/validation/validation-proj-v12.json
  created_at: 2026-04-25T11:03:00+09:00
```

Required validation checks:

```text
Every Markdown file has exactly one mdplace_id.
No two files share the same mdplace_id.
Every accepted placement has evidence.
Every accepted placement references an active category.
Every category belongs to the referenced category scheme.
Every target path is unique.
No projection overwrites an untracked file.
Every deprecated category has a replacement, alias, or conversion rule.
Every projection run has a persisted projection policy.
Every projection run has a manifest.
Every applied projection has a passing ValidationRun.
```

SHACL is the RDF-native version of this idea; JSON Schema and SQLite constraints are sufficient for the first implementation. ([W3C][13])

---

## 3.14 `PathAlias`

```yaml
PathAlias:
  old_path: notes/Research/RAG Systems/adaptive-taxonomy.md
  new_path: notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  projection_id: proj:v12
  created_at: 2026-04-25T11:05:00+09:00
```

This enables:

```text
resolve old path ? stable file_id ? current path
```

---

## 3.15 `ConsumerContract`

Downstream systems should declare what they depend on.

```yaml
ConsumerContract:
  consumer_id: consumer:search-index
  depends_on:
    categories:
      - cat:knowledge-graphs
    views:
      - files-current
      - path-aliases
  accepted_scheme_versions:
    - scheme:v3
  breaking_change_policy: requires_review
  compatibility_window_days: 180
```

This is how the taxonomy can evolve without silently breaking downstream APIs, scripts, indexes, dashboards, or publishing workflows.

---

# 4. Minimal SQLite schema

This is enough to implement the MVP plus the hardening changes.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  current_path TEXT NOT NULL UNIQUE,
  title TEXT,
  content_hash TEXT,
  frontmatter_hash TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'missing', 'deleted', 'archived')
  ),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE file_versions (
  version_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  frontmatter_hash TEXT,
  git_commit TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE category_schemes (
  scheme_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'deprecated', 'archived')
  ),
  previous_scheme_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  parent_category_id TEXT REFERENCES categories(category_id),
  label TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'navigational_category',
      'topic_tag',
      'project_context',
      'workflow_status',
      'collection',
      'candidate_category',
      'deprecated_category'
    )
  ),
  definition TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('candidate', 'active', 'deprecated', 'obsolete')
  ),
  UNIQUE (scheme_id, slug)
);

CREATE TABLE category_aliases (
  old_category_id TEXT PRIMARY KEY,
  new_category_id TEXT,
  from_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  to_scheme_id TEXT REFERENCES category_schemes(scheme_id),
  change_id TEXT,
  alias_type TEXT NOT NULL CHECK (
    alias_type IN (
      'renamed_to',
      'merged_into',
      'deprecated_replacement',
      'legacy_alias',
      'converted_to_tag',
      'converted_to_status',
      'split_into_review_required'
    )
  ),
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE placement_assertions (
  placement_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL CHECK (
    status IN ('candidate', 'accepted', 'rejected', 'superseded')
  ),
  generated_by TEXT,
  accepted_by TEXT,
  valid_from TEXT,
  valid_to TEXT,
  transaction_time TEXT NOT NULL,
  supersedes TEXT REFERENCES placement_assertions(placement_id)
);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  placement_id TEXT REFERENCES placement_assertions(placement_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),
  evidence_type TEXT NOT NULL,
  supports_category_id TEXT REFERENCES categories(category_id),
  contradicts_category_id TEXT REFERENCES categories(category_id),
  score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE category_changes (
  change_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (
    operation IN (
      'create_category',
      'rename_category',
      'move_category',
      'split_category',
      'merge_categories',
      'deprecate_category',
      'convert_category_to_tag',
      'convert_category_to_status',
      'convert_category_to_project_context',
      'change_projection_policy'
    )
  ),
  from_scheme_id TEXT REFERENCES category_schemes(scheme_id),
  to_scheme_id TEXT REFERENCES category_schemes(scheme_id),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'proposed', 'approved', 'applied', 'rejected', 'rolled_back')
  ),
  rationale TEXT,
  migration_id TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE category_change_items (
  change_id TEXT NOT NULL REFERENCES category_changes(change_id),
  category_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN (
      'old_category',
      'new_category',
      'renamed_from',
      'renamed_to',
      'merged_from',
      'merged_into',
      'split_from',
      'split_into',
      'deprecated',
      'replacement',
      'converted_from',
      'converted_to'
    )
  ),
  PRIMARY KEY (change_id, category_id, role)
);

CREATE TABLE migration_rules (
  migration_id TEXT PRIMARY KEY,
  from_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  to_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  rule_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'deprecated')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE projection_policies (
  policy_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'deprecated')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE projection_runs (
  projection_id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  policy_id TEXT NOT NULL REFERENCES projection_policies(policy_id),
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'dry_run', 'validated', 'applied', 'rolled_back', 'failed')
  ),
  manifest_path TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE projected_paths (
  projection_id TEXT NOT NULL REFERENCES projection_runs(projection_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),
  from_path TEXT,
  to_path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('move', 'create', 'update_frontmatter', 'unchanged', 'delete_projection')
  ),
  placement_id TEXT REFERENCES placement_assertions(placement_id),
  PRIMARY KEY (projection_id, file_id, action)
);

CREATE TABLE validation_runs (
  validation_id TEXT PRIMARY KEY,
  projection_id TEXT NOT NULL REFERENCES projection_runs(projection_id),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE path_aliases (
  old_path TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  new_path TEXT NOT NULL,
  projection_id TEXT REFERENCES projection_runs(projection_id),
  created_at TEXT NOT NULL
);

CREATE TABLE consumer_contracts (
  consumer_id TEXT PRIMARY KEY,
  contract_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'deprecated')
  ),
  created_at TEXT NOT NULL
);
```

Implementation rule: do not rely only on database constraints for append-only behavior. Treat `events` as write-once in the application layer, and optionally add triggers that reject updates/deletes.

---

# 5. Main workflows

## 5.1 Initialize

```bash
mdplace init
```

Creates:

```text
.mdplace/ledger.sqlite
.mdplace/categories/scheme-v1.yaml
.mdplace/rules/placement-rules.yaml
.mdplace/rules/projection-policies.yaml
.mdplace/projections/
.mdplace/migrations/
.mdplace/validation/
```

Seeds initial category kinds:

```text
navigational_category
topic_tag
project_context
workflow_status
collection
candidate_category
deprecated_category
```

---

## 5.2 Scan Markdown files

```bash
mdplace scan
```

Steps:

```text
1. Find all .md files.
2. Parse frontmatter.
3. Mint mdplace_id if missing.
4. Compute content hash.
5. Extract title, headings, tags, links, backlinks.
6. Register FileEntity and FileVersion.
7. Emit FileDiscovered / FileIdentityMinted / FileContentChanged events.
```

ObsidianÕs graph view is a practical real-world example of using notes as nodes and internal links as edges, while Dendron is a real-world example of local-first hierarchical Markdown note organization. ([Obsidian][14])

---

## 5.3 Propose placements

```bash
mdplace propose-placements
```

Feature extraction:

```text
title terms
headings
frontmatter tags
outgoing links
backlinks
current folder prior
neighbor category distribution
optional embedding similarity
manual history
```

Candidate scoring:

```text
score(file, category)
  = title_heading_match
  + tag_match
  + link_neighborhood_match
  + embedding_similarity
  + folder_history_prior
  + manual_preference_prior
```

Output:

```yaml
CandidatePlacement:
  file_id: file:01JABC
  candidates:
    - category: cat:knowledge-graphs
      score: 0.91
      evidence:
        - title contains "semantic taxonomy"
        - headings mention "adaptive mdplace"
        - backlinks mostly from mdplace notes
    - category: cat:ontology-engineering
      score: 0.74
    - category: cat:rag-systems
      score: 0.43
```

Creates candidate `PlacementAssertion` records.

---

## 5.4 Accept or reject placements

```bash
mdplace review
mdplace accept-placement place:01JABD
mdplace reject-placement place:01JABE --reason "Actually about RAG"
```

Acceptance policy:

```text
confidence ³ 0.90 and no conflict     ? auto-accept
0.65 ² confidence < 0.90              ? review
confidence < 0.65                     ? needs-review category or no placement
manual correction                     ? accepted with human evidence
```

Every accepted placement must produce:

```text
PlacementAccepted event
Evidence records
frontmatter update plan
projection candidate
```

---

## 5.5 Dry-run projection

```bash
mdplace project --dry-run
```

Computes:

```text
accepted placements
+ active category scheme
+ active projection policy
+ current file registry
? planned folder layout
```

Produces:

```text
ProjectionRun(status=dry_run)
ProjectedPath records
projection manifest
ValidationRun
```

Example report:

```json
{
  "projection_id": "proj:v12",
  "scheme_id": "scheme:v3",
  "policy_id": "policy:primary-category-folders-v1",
  "moves": 12,
  "frontmatter_updates": 8,
  "collisions": 0,
  "orphan_files": 0,
  "invalid_categories": 0,
  "validation": "passed"
}
```

---

## 5.6 Apply projection

```bash
mdplace project --apply proj:v12
```

Allowed only if:

```text
projection status is dry_run or validated
validation status is passed
manifest exists
no file-system drift since dry run
```

Applies:

```text
move files
update frontmatter
create path aliases
write manifest
emit ProjectionApplied and FileMovedByProjection events
```

---

## 5.7 Explain placement

```bash
mdplace explain file:01JABC
```

Answer:

```text
File:
  Adaptive Semantic Taxonomy

Current path:
  notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md

Why here:
  Accepted placement place:01JABD assigned the file to cat:knowledge-graphs
  under scheme:v3, with confidence 0.91.

Evidence:
  - title contains "semantic taxonomy"
  - headings mention "adaptive mdplace"
  - backlinks mostly from mdplace architecture notes
  - manual review accepted the placement

Projection:
  proj:v12 materialized the current path using policy:primary-category-folders-v1.

Previous paths:
  - notes/Research/RAG Systems/adaptive-taxonomy.md
  - notes/Inbox/adaptive-taxonomy.md
```

This command is the trust anchor for the whole system.

---

# 6. Detecting wrong categories

Wrong-category detection should run as an audit job.

```bash
mdplace audit-placements
```

Signals:

```text
current category score dropped
another category wins by a large margin
file content changed substantially
backlink neighborhood changed
manual corrections repeatedly contradict current category
category profile changed
taxonomy scheme changed
```

Example:

```text
Current category:
  RAG Systems, score 0.52

Best current category:
  Knowledge Graphs, score 0.91

Action:
  create new PlacementAssertion
  mark old placement as superseded after review or auto-policy
```

This is the Markdown-scale version of mdplace refinement: detecting missing or incorrect assignments and proposing repairs.

---

# 7. Category evolution

## 7.1 Split category

Trigger:

```text
one category becomes too large
files inside it form stable subclusters
high internal semantic variance
many manual corrections out of that category
```

Example:

```text
AI Knowledge Systems
  ? Knowledge Graphs
  ? RAG Systems
  ? Ontology Engineering
  ? Vector Search
```

Workflow:

```bash
mdplace split-category cat:ai-knowledge-systems \
  --into cat:knowledge-graphs cat:rag-systems cat:ontology-engineering cat:vector-search \
  --dry-run
```

Creates:

```text
CategoryChange(operation=split_category)
CategoryChangeItems
MigrationRule
CategoryAliases for legacy references
Candidate PlacementAssertions for affected files
Projection dry-run
ValidationRun
```

Formal Concept Analysis is useful here because it derives concept lattices from objects and attributes; in this system, the objects are files and the attributes are terms, tags, links, headings, and usage signals. FCA helps propose candidate category splits, but those splits should become reviewable `CategoryChange` proposals rather than automatic truth. ([Wikipedia][15])

---

## 7.2 Merge categories

Trigger:

```text
two categories have highly similar profiles
files bounce between them
one category mostly acts as a synonym
manual corrections often map one to the other
```

Example:

```text
Semantic Graphs + Knowledge Graphs ? Knowledge Graphs
```

Workflow:

```bash
mdplace merge-categories cat:semantic-graphs cat:knowledge-graphs \
  --into cat:knowledge-graphs \
  --dry-run
```

Creates:

```text
CategoryChange(operation=merge_categories)
CategoryAlias(old=cat:semantic-graphs, new=cat:knowledge-graphs)
PathAlias records after projection
MigrationRule
Compatibility API update
```

---

## 7.3 Convert category to status/tag/project

Trigger:

```text
category is not topical
membership changes often
category names are workflow-like: Draft, Review, Archive, Important
category conflicts with primary topic organization
```

Example:

```text
notes/To Review/adaptive-taxonomy.md
```

becomes:

```text
notes/Research/Knowledge Graphs/adaptive-taxonomy.md
```

with frontmatter:

```yaml
status: to-review
```

Workflow:

```bash
mdplace convert-category cat:to-review --to workflow_status --field status --value to-review
```

Creates:

```text
CategoryChange(operation=convert_category_to_status)
CategoryAlias(alias_type=converted_to_status)
MigrationRule
Placement updates
Projection dry-run
ValidationRun
```

This is the Markdown version of converting an overloaded class into a role/status. It prevents the folder tree from mixing topics, workflow state, projects, and priorities.

---

# 8. Category profiles and adaptive behavior

Maintain a `CategoryProfile` as a derived artifact, not necessarily a core table.

```yaml
CategoryProfile:
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  time_window: 2026-Q2
  common_terms:
    - graph
    - ontology
    - RDF
    - semantic
    - taxonomy
  common_links:
    - file:ontology-modularity
    - file:mdplace-refinement
  representative_files:
    - file:adaptive-taxonomy
    - file:ontology-design-patterns
  outlier_files:
    - file:vector-db-benchmark
  internal_variance: 0.22
  drift_score: 0.08
```

Use profiles for:

```text
new placement proposals
wrong-category detection
split-category detection
merge-category detection
category drift detection
```

Later, DL-Learner-style methods can help learn human-readable category definitions from positive and negative examples. DL-Learner is specifically described as software for learning Description Logic concepts, or OWL classes, from selected examples. ([DL Learner][16])

---

# 9. Downstream compatibility

Expose stable APIs/views instead of forcing consumers to depend on folder paths.

```text
GET /files/{file_id}
GET /files/{file_id}/path
GET /paths/resolve?old_path=...
GET /categories/{category_id}
GET /categories/{category_id}/files
GET /schemes/{scheme_id}
GET /placements/{file_id}/history
GET /projections/{projection_id}/manifest
```

Example path resolution:

```json
{
  "old_path": "notes/Research/RAG Systems/adaptive-taxonomy.md",
  "file_id": "file:01JABC",
  "current_path": "notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md",
  "resolved_by": "path_alias",
  "projection_id": "proj:v12"
}
```

Example category resolution:

```json
{
  "old_category": "cat:semantic-graphs",
  "current_category": "cat:knowledge-graphs",
  "alias_type": "merged_into",
  "change_id": "change:merge-semantic-graphs-mdplace"
}
```

This is where the system keeps downstream search indexes, publishing scripts, dashboards, and APIs from breaking.

---

# 10. Validation gates

Before applying any projection:

```text
1. Every file has one mdplace_id.
2. No duplicate mdplace_id exists.
3. Every accepted PlacementAssertion has evidence.
4. Every accepted PlacementAssertion uses an active category.
5. Every active category belongs to the active scheme.
6. Every deprecated category has a category alias or migration rule.
7. Every category split has migration rules for affected files.
8. Every category merge has category aliases.
9. Every generated target path is unique.
10. No untracked file will be overwritten.
11. Every frontmatter update is valid YAML.
12. Every projection references a persisted ProjectionPolicy.
13. Every applied projection has a passing ValidationRun.
14. Every moved file creates a PathAlias.
15. Every change emits append-only events.
```

RDF users can implement this with SHACL; a SQLite/YAML MVP can implement it with database constraints, JSON Schema, and custom preflight checks. RDF datasets and named graphs become useful later if you want to preserve source graphs, projection graphs, taxonomy versions, and snapshots as separate graph contexts. ([W3C][13])

---

# 11. Real-world analogues

This design is not identical to existing note tools, but it combines patterns that exist in separate systems.

| Existing practice                    | What it contributes                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Obsidian**                         | Markdown files with YAML properties and graph view where notes are nodes and internal links are edges. ([Obsidian][17])                                                                            |
| **Dendron**                          | Local-first, Markdown-based, hierarchical note organization; its docs explicitly emphasize hierarchy while still allowing backlinks, tags, and keywords as secondary associations. ([Dendron][18]) |
| **SKOS / Library-style taxonomies**  | Concept schemes, broader/narrower concepts, labels, aliases, mappings; Library of Congress subject headings are a real linked-data example. ([W3C][1])                                             |
| **Event sourcing**                   | Durable sequence of changes and reconstructable history. ([martinfowler.com][10])                                                                                                                  |
| **Materialized views**               | Persisted projections of authoritative data. ([PostgreSQL][2])                                                                                                                                     |
| **mdplaceCL / ontology change workflows** | High-level category-change records such as rename, obsolete, move, synonym, and diff-like changes. ([OUP Academic][19])                                                                            |
| **OntoRipple-like propagation**      | The principle that ontology/taxonomy changes must propagate into mappings and validation artifacts. ([ScienceDirect][11])                                                                          |

The practical difference from Obsidian/Dendron is that this system treats physical hierarchy as **generated**, not authoritative.

---

# 12. CLI surface

A useful first CLI:

```bash
mdplace init

mdplace scan
mdplace validate

mdplace propose-placements
mdplace review
mdplace accept-placement <placement_id>
mdplace reject-placement <placement_id>

mdplace project --dry-run
mdplace project --apply <projection_id>
mdplace project --rollback <projection_id>

mdplace explain <file_id>
mdplace history <file_id>
mdplace resolve-path "notes/old/path.md"

mdplace split-category <category_id>
mdplace merge-categories <category_id> <category_id>
mdplace rename-category <category_id> --label "New Label"
mdplace deprecate-category <category_id> --replacement <category_id>
mdplace convert-category <category_id> --to status --field status --value to-review

mdplace rebuild --dry-run
mdplace export-api
mdplace export-skos
mdplace export-prov
```

Most important early commands:

```bash
mdplace explain
mdplace validate
mdplace project --dry-run
mdplace resolve-path
```

These create trust.

---

# 13. MVP implementation phases

## Phase 1 Ñ Identity and ledger

Implement:

```text
FileEntity
FileVersion
frontmatter parser/updater
mdplace_id minting
events
```

Outcome:

```text
Every Markdown file has stable identity independent of path.
```

---

## Phase 2 Ñ Category scheme and placements

Implement:

```text
CategoryScheme
Category
PlacementAssertion
Evidence
manual accept/reject
```

Outcome:

```text
Every file can have an evidence-backed placement.
```

---

## Phase 3 Ñ Projection engine

Implement:

```text
ProjectionPolicy
ProjectionRun
ProjectedPath
ProjectionManifest
ValidationRun
PathAlias
frontmatter update
file move
```

Outcome:

```text
The folder tree can be rebuilt from the ledger.
```

---

## Phase 4 Ñ Recategorization audit

Implement:

```text
file feature extraction
category profiles
candidate scoring
wrong-category detection
placement supersession
review queue
```

Outcome:

```text
The system can detect and repair wrong placements.
```

---

## Phase 5 Ñ Taxonomy evolution

Implement:

```text
CategoryChange
CategoryChangeItem
CategoryAlias
MigrationRule
split / merge / rename / deprecate / convert-to-status
```

Outcome:

```text
The category scheme can evolve without losing history or breaking consumers.
```

---

## Phase 6 Ñ Advanced methods

Add only after the MVP is stable:

```text
embeddings
Formal Concept Analysis
DL-Learner-style category definitions
RDF/SKOS export
PROV-O export
SHACL validation
category-theoretic migration notation
GraphRAG-style retrieval over notes
```

GraphRAG can help retrieve and summarize evidence from large Markdown corpora, but it should remain an assistant to the semantic ledger rather than the source of truth.

---

# 14. End-to-end example

Initial file:

```text
notes/Inbox/adaptive-taxonomy.md
```

Initial frontmatter:

```yaml
---
mdplace_id: file:01JABC
title: Adaptive Semantic Taxonomy
status: draft
---
```

The scanner extracts:

```text
title terms:
  adaptive, semantic, taxonomy

heading terms:
  knowledge graph, projection, category evolution

links:
  ontology-modularity
  mdplace-refinement
  semantic-ledger
```

The system proposes:

```yaml
PlacementAssertion:
  placement_id: place:01JABD
  file_id: file:01JABC
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  confidence: 0.91
  status: accepted
  evidence:
    - ev:title-terms
    - ev:heading-terms
    - ev:backlink-neighborhood
```

Projection policy computes:

```text
from: notes/Inbox/adaptive-taxonomy.md
to:   notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
```

Frontmatter becomes:

```yaml
---
mdplace_id: file:01JABC
title: Adaptive Semantic Taxonomy
primary_category: cat:knowledge-graphs
category_scheme: scheme:v3
placement_id: place:01JABD
projection_id: proj:v12
status: draft
tags:
  - adaptive-mdplace
  - markdown
  - taxonomy
---
```

Path alias is created:

```yaml
old_path: notes/Inbox/adaptive-taxonomy.md
new_path: notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
file_id: file:01JABC
projection_id: proj:v12
```

Later, `Knowledge Graphs` splits into:

```text
Ontology Engineering
mdplace Systems
mdplace Refinement
```

The file receives a new placement assertion, the old one becomes superseded, the split is represented as a `CategoryChange`, and the next projection moves the file again while preserving old paths and category aliases.

---

# 15. Invariant coverage

This design can answer all target questions.

| Question                                                           | Answered by                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Why is this Markdown file in this folder?**                      | `ProjectedPath ? PlacementAssertion ? Evidence ? Event`                                                     |
| **Which category scheme placed it there?**                         | `PlacementAssertion.scheme_id` and `ProjectionRun.scheme_id`                                                |
| **What evidence supported that placement?**                        | `Evidence` linked to `PlacementAssertion`                                                                   |
| **Was it ever somewhere else?**                                    | `FileVersion`, `ProjectedPath`, `PathAlias`, `events`                                                       |
| **Was the category itself renamed, split, merged, or deprecated?** | `CategoryChange`, `CategoryChangeItem`, `CategoryAlias`                                                     |
| **What old paths still point to it?**                              | `PathAlias`                                                                                                 |
| **What would happen if we rebuild the folder tree today?**         | `mdplace project --dry-run` using active `CategoryScheme`, accepted placements, and persisted `ProjectionPolicy` |

---

# 16. Final implementation principle

Build the system so the current folder tree is always disposable.

```text
Delete notes/ folder projection.
Replay ledger + accepted placements + active category scheme + projection policy.
Regenerate the same folder tree.
Resolve old paths through aliases.
Explain every move through placement evidence.
```

That is the test for correctness.

The final architecture is:

```text
Git-backed Markdown repository
+ small SQLite semantic ledger
+ versioned SKOS-like category schemes
+ evidence-backed PlacementAssertions
+ append-only event history
+ validated ProjectionRuns
+ projection manifests
+ path/category aliases
+ compatibility APIs
```

This is enough to categorize new files, detect wrong categories, split and merge categories, preserve history, and keep downstream systems working as the category scheme evolves.

[1]: https://www.w3.org/TR/skos-reference/?utm_source=chatgpt.com "SKOS Simple Knowledge Organization System Reference"
[2]: https://www.postgresql.org/docs/current/rules-materializedviews.html?utm_source=chatgpt.com "Documentation: 18: 39.3. Materialized Views"
[3]: https://martinfowler.com/bliki/CQRS.html?utm_source=chatgpt.com "CQRS"
[4]: https://sqlite.org/foreignkeys.html?utm_source=chatgpt.com "SQLite Foreign Key Support"
[5]: https://git-scm.com/docs/user-manual?utm_source=chatgpt.com "Git - user-manual Documentation"
[6]: https://docs.github.com/en/contributing/writing-for-github-docs/using-yaml-frontmatter?utm_source=chatgpt.com "Using YAML frontmatter"
[7]: https://incatools.github.io/mdplacecl-rdflib/?utm_source=chatgpt.com "Knowledge Graph Change Language"
[8]: https://martinfowler.com/articles/bitemporal-history.html?utm_source=chatgpt.com "Bitemporal History"
[9]: https://www.w3.org/TR/prov-o/?utm_source=chatgpt.com "PROV-O: The PROV Ontology"
[10]: https://martinfowler.com/eaaDev/EventSourcing.html?utm_source=chatgpt.com "Event Sourcing"
[11]: https://www.sciencedirect.com/science/article/pii/S2352711026000361?utm_source=chatgpt.com "OntoRipple: Making waves in the knowledge graph lifecycle"
[12]: https://arxiv.org/abs/1009.1166?utm_source=chatgpt.com "Functorial Data Migration"
[13]: https://www.w3.org/TR/shacl/?utm_source=chatgpt.com "Shapes Constraint Language (SHACL)"
[14]: https://obsidian.md/help/plugins/graph?utm_source=chatgpt.com "Graph view - Obsidian Help"
[15]: https://en.wikipedia.org/wiki/Formal_concept_analysis?utm_source=chatgpt.com "Formal concept analysis"
[16]: https://dl-learner.org/one-page-introduction/?utm_source=chatgpt.com "One page introduction | - DL-Learner"
[17]: https://obsidian.md/help/properties?utm_source=chatgpt.com "Properties - Obsidian Help"
[18]: https://wiki.dendron.so/?utm_source=chatgpt.com "Dendron"
[19]: https://academic.oup.com/database/article/doi/10.1093/database/baae133/7972659?utm_source=chatgpt.com "change language for ontologies and knowledge graphs"


Below is the hardened design, incorporating all six changes. IÕll treat this as an implementation blueprint for a first real system, not just an architecture sketch.

# 0. Core stance

The system should have one non-negotiable invariant:

```text
The folder path is not semantic truth.
The folder path is a generated projection of versioned placement assertions.
```

So the architecture becomes:

```text
Markdown files
  physical content

Frontmatter
  stable bridge from file ? semantic ledger

Semantic ledger
  durable source of truth:
  file identity, category schemes, placements, evidence, events,
  category changes, validation runs, projection policies, aliases

Folder tree
  materialized projection:
  generated from current accepted placements + active category scheme + projection policy

Downstream APIs
  compatibility-preserving views:
  resolve stable file IDs, old paths, old categories, current paths
```

This is essentially a small **event-sourced semantic control plane** with a **materialized folder projection**. Event sourcing is relevant because it stores state changes as an ordered event history that can reconstruct past states, and CQRS is relevant because it separates the write model from read/display models. A folder tree here behaves like a materialized view: a persisted result of a projection that can be refreshed from the authoritative data. ([martinfowler.com][1])

---

# 1. Layered design

## Layer 1 Ñ Markdown repository

Purpose:

```text
Store human-readable notes.
Allow normal editing.
Allow Git-based file history.
```

The Markdown repository is not the semantic source of truth, but it remains the user-facing workspace. Git is useful because it stores project history as commits/snapshots, but Git alone does not explain why a file was semantically recategorized. ([Git][2])

Recommended layout:

```text
repo/
  notes/
    Inbox/
    Research/
    Projects/
    Reference/

  .mdplace/
    ledger.sqlite
    categories/
      scheme-v1.yaml
      scheme-v2.yaml
    rules/
      placement-rules.yaml
      projection-policies.yaml
    projections/
      proj-v001.json
      proj-v002.json
    migrations/
      scheme-v1-to-v2.yaml
    validation/
      validation-v001.json
```

---

## Layer 2 Ñ Frontmatter bridge

Frontmatter should be a **minimal bridge**, not the ledger. YAML frontmatter is already a common Markdown metadata convention; GitHub Docs describes it as a key-value metadata block at the top of Markdown files. ([GitHub Docs][3])

Recommended frontmatter:

```yaml
---
mdplace_id: file:01JABC9Q4S0AH7E5Q2M3X6
title: Adaptive Semantic Taxonomy
primary_category: cat:knowledge-graphs
category_scheme: scheme:v3
placement_id: place:01JABD2F8MMZD5M3ZC5T
projection_id: proj:v12
status: active
tags:
  - adaptive-mdplace
  - taxonomy
  - markdown
---
```

Frontmatter should store:

```text
mdplace_id
title
current primary_category
category_scheme
placement_id
projection_id
status
human-facing tags
```

It should not store:

```text
full placement history
all evidence
all rejected categories
all classifier scores
all old paths
category migration history
```

Those belong in the semantic ledger.

---

## Layer 3 Ñ Versioned category scheme

For this Markdown system, use a **SKOS-like taxonomy**, not a heavy OWL ontology at first. SKOS was designed for knowledge organization systems such as taxonomies, thesauri, classification schemes, and subject heading systems, which fits a navigational Markdown taxonomy well. ([W3C][4])

Core objects:

```text
CategoryScheme
Category
CategoryMapping
CategoryAlias
CategoryChange
CategoryChangeItem
```

A category should have a kind:

```text
navigational_category
topic_tag
project_context
workflow_status
collection
candidate_category
deprecated_category
```

This prevents bad folder taxonomies. For example:

```text
Knowledge Graphs       ? navigational_category ? can be a folder
To Review              ? workflow_status       ? should be frontmatter/status
Important              ? topic_tag             ? should be metadata
Client-A               ? project_context       ? maybe a project view
Archived               ? workflow_status       ? not primary content folder
```

That distinction is essential for Òconvert classes into statuses/tags/projectsÓ in your Markdown-specific system.

---

## Layer 4 Ñ Placement assertion ledger

This is the heart of the design.

A placement is not:

```text
file is in folder X
```

A placement is:

```text
file F belongs to category C
under category scheme S
because of evidence E
according to rule/model/human decision R
with status candidate/accepted/rejected/superseded
during time interval T
```

Example:

```yaml
PlacementAssertion:
  placement_id: place:01JABD2F8MMZD5M3ZC5T
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  confidence: 0.91
  status: accepted
  evidence:
    - ev:title-terms
    - ev:heading-terms
    - ev:backlink-neighborhood
    - ev:manual-confirmation
  generated_by: rule:placement-v2
  accepted_by: user:me
  valid_from: 2026-04-25T10:20:00+09:00
  transaction_time: 2026-04-25T10:20:00+09:00
  supersedes: place:old
```

Use bitemporal fields when possible:

```text
valid_from / valid_to
  when this placement is considered semantically valid

transaction_time
  when the system recorded or learned the placement
```

Bitemporal modeling matters when the system later learns that an earlier placement was wrong or only valid under an older taxonomy. ([martinfowler.com][5])

---

## Layer 5 Ñ Evidence and provenance

Every accepted placement must have evidence.

Evidence examples:

```text
title_terms
heading_terms
frontmatter_tags
manual_user_decision
existing_folder_prior
outgoing_links
backlinks
neighbor_category_distribution
embedding_similarity
rule_match
category_profile_match
negative_evidence
```

PROV-O is a good conceptual model here because it represents provenance across systems and contexts using entities, activities, agents, and derivations. ([W3C][6])

Example:

```yaml
Evidence:
  evidence_id: ev:backlink-neighborhood
  placement_id: place:01JABD2F8MMZD5M3ZC5T
  file_id: file:01JABC9Q4S0AH7E5Q2M3X6
  evidence_type: backlink_similarity
  supports_category: cat:knowledge-graphs
  score: 0.84
  payload:
    linked_files:
      - file:ontology-modules
      - file:mdplace-refinement
      - file:semantic-control-plane
```

This is how the system answers:

```text
Why is this Markdown file in this folder?
```

---

## Layer 6 Ñ Append-only event history

Events record everything that matters:

```text
FileDiscovered
FileIdentityMinted
FileContentChanged
FrontmatterParsed
FrontmatterUpdated
PlacementProposed
PlacementAccepted
PlacementRejected
PlacementSuperseded
CategoryCreated
CategoryRenamed
CategoryMoved
CategorySplit
CategoryMerged
CategoryDeprecated
CategoryConvertedToTag
CategoryConvertedToStatus
ProjectionDryRunCreated
ProjectionValidationPassed
ProjectionValidationFailed
ProjectionApplied
ProjectionRolledBack
PathAliasCreated
CategoryAliasCreated
ManualOverrideRecorded
```

The event log should be append-only. SQLite triggers can enforce this in the MVP because SQLite supports triggers that fire automatically on database events. ([SQLite][7])

Example event:

```json
{
  "event_id": "evt:01JABF...",
  "event_type": "PlacementSuperseded",
  "aggregate_type": "file",
  "aggregate_id": "file:01JABC9Q4S0AH7E5Q2M3X6",
  "actor": "system:placement-audit-v2",
  "occurred_at": "2026-04-25T11:12:00+09:00",
  "payload": {
    "old_placement": "place:old",
    "new_placement": "place:new",
    "from_category": "cat:rag-systems",
    "to_category": "cat:knowledge-graphs",
    "reason": "Backlink and content profile shifted toward Knowledge Graphs."
  }
}
```

---

## Layer 7 Ñ Projection engine

The projection engine generates the physical folder tree.

Inputs:

```text
active category scheme
accepted placement assertions
projection policy
file registry
compatibility maps
```

Output:

```text
folder moves
frontmatter updates
projection manifest
path aliases
validation report
events
```

Projection policy example:

```yaml
policy_id: policy:primary-category-folders-v1
root: notes/
path_template: "{category_path}/{file_slug}.md"
category_source: primary_category
collision_strategy: append-short-file-id
update_frontmatter: true
create_path_aliases: true
dry_run_required: true
```

The projection engine should never apply moves directly. It must run:

```text
plan ? validate ? apply ? record manifest ? update aliases ? emit events
```

---

## Layer 8 Ñ Validation preflight

Validation must be a hard gate.

A projection may not apply unless a `validation_run` for that exact projection has status `passed`.

Minimum checks:

```text
Every Markdown file has exactly one mdplace_id.
No duplicate mdplace_id exists.
Every accepted placement has at least one evidence record.
Every accepted placement points to an active category.
Every category belongs to the referenced category scheme.
Every projected path is unique.
No projected move overwrites untracked content.
Every deprecated category has alias or replacement mapping.
Every category conversion has a target field/tag/status/project.
Every projection policy is persisted and hashed.
Every projection has a manifest.
Every old path alias points to a known file.
Every old category mapping points to a valid replacement or conversion.
```

JSON Schema is useful for validating YAML/JSON category schemes and projection policies because it is a declarative language for validating JSON document structure, constraints, and data types. SQLite foreign keys are useful for referential integrity in the ledger. SHACL becomes useful later if you move the ledger to RDF, since SHACL validates RDF graphs against shape constraints. ([JSON Schema][8])

---

## Layer 9 Ñ Compatibility layer

This layer prevents downstream breakage.

Compatibility maps:

```text
old path ? file_id ? current path
old category ? new category / tag / status / project context
old category slug ? current category slug
old scheme ? new scheme migration
```

This is needed because users, scripts, links, search indexes, APIs, and published references may still depend on old paths or old categories.

Example:

```yaml
PathAlias:
  old_path: notes/Research/RAG Systems/adaptive-taxonomy.md
  new_path: notes/Research/Knowledge Graphs/adaptive-taxonomy.md
  file_id: file:01JABC
  projection_id: proj:v12
```

Example category alias:

```yaml
CategoryAlias:
  old_category_id: cat:semantic-graphs
  new_target_kind: category
  new_target_id: cat:knowledge-graphs
  alias_type: merged_into
  from_scheme: scheme:v2
  to_scheme: scheme:v3
```

Example conversion alias:

```yaml
CategoryAlias:
  old_category_id: cat:to-review
  new_target_kind: workflow_status
  new_target_value: to-review
  alias_type: converted_to_status
  from_scheme: scheme:v2
  to_scheme: scheme:v3
```

---

# 2. Hardened schema

Below is an implementation-ready relational schema skeleton for SQLite. It is deliberately small enough for an MVP, but it includes the six requested hardening changes.

## 2.1 Core file tables

```sql
CREATE TABLE files (
  file_id TEXT PRIMARY KEY,
  current_path TEXT NOT NULL UNIQUE,
  title TEXT,
  content_hash TEXT,
  frontmatter_hash TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'missing', 'deleted', 'archived')
  ),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE file_versions (
  version_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  frontmatter_hash TEXT,
  git_commit TEXT,
  observed_at TEXT NOT NULL
);
```

---

## 2.2 Category scheme and categories

```sql
CREATE TABLE category_schemes (
  scheme_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'deprecated', 'archived')
  ),
  previous_scheme_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE categories (
  category_id TEXT PRIMARY KEY,
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  parent_category_id TEXT,
  label TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'navigational_category',
      'topic_tag',
      'project_context',
      'workflow_status',
      'collection',
      'candidate_category',
      'deprecated_category'
    )
  ),
  definition TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('candidate', 'active', 'deprecated', 'obsolete')
  ),
  UNIQUE (scheme_id, slug)
);
```

---

## 2.3 New hardening change 1: explicit `category_mappings`

`category_mappings` is the durable semantic mapping table between old and new category schemes.

```sql
CREATE TABLE category_mappings (
  mapping_id TEXT PRIMARY KEY,

  from_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  to_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),

  from_category_id TEXT NOT NULL,
  to_target_kind TEXT NOT NULL CHECK (
    to_target_kind IN (
      'category',
      'topic_tag',
      'project_context',
      'workflow_status',
      'collection',
      'none'
    )
  ),

  to_category_id TEXT,
  to_target_value TEXT,

  mapping_type TEXT NOT NULL CHECK (
    mapping_type IN (
      'renamed_to',
      'moved_to',
      'merged_into',
      'split_into',
      'deprecated_replacement',
      'converted_to_tag',
      'converted_to_status',
      'converted_to_project_context',
      'legacy_alias',
      'exact_match',
      'close_match',
      'broader_match',
      'narrower_match'
    )
  ),

  confidence REAL,
  change_id TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL
);
```

Why not only `category_aliases`? Because not every category change is a simple alias. A split, conversion, close match, broader match, or deprecation is a mapping, not merely an alias.

---

## 2.4 New hardening change 1: explicit `category_aliases`

`category_aliases` is the fast lookup table used by APIs and resolvers.

```sql
CREATE TABLE category_aliases (
  old_category_id TEXT PRIMARY KEY,
  old_slug TEXT,
  from_scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),

  target_kind TEXT NOT NULL CHECK (
    target_kind IN (
      'category',
      'topic_tag',
      'project_context',
      'workflow_status',
      'collection',
      'none'
    )
  ),

  target_category_id TEXT,
  target_value TEXT,

  to_scheme_id TEXT REFERENCES category_schemes(scheme_id),
  mapping_id TEXT REFERENCES category_mappings(mapping_id),

  alias_type TEXT NOT NULL CHECK (
    alias_type IN (
      'renamed_to',
      'merged_into',
      'deprecated_replacement',
      'legacy_alias',
      'converted_to_tag',
      'converted_to_status',
      'converted_to_project_context'
    )
  ),

  created_at TEXT NOT NULL
);
```

This lets downstream consumers ask:

```text
What happened to cat:semantic-graphs?
What happened to cat:to-review?
Can old category URLs still resolve?
```

---

## 2.5 Placement assertions and evidence

```sql
CREATE TABLE placement_assertions (
  placement_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  category_id TEXT NOT NULL REFERENCES categories(category_id),
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),

  confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),

  status TEXT NOT NULL CHECK (
    status IN ('candidate', 'accepted', 'rejected', 'superseded')
  ),

  generated_by TEXT,
  accepted_by TEXT,

  valid_from TEXT,
  valid_to TEXT,
  transaction_time TEXT NOT NULL,

  supersedes TEXT REFERENCES placement_assertions(placement_id)
);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  placement_id TEXT REFERENCES placement_assertions(placement_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),

  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN (
      'title_terms',
      'heading_terms',
      'frontmatter_tags',
      'manual_user_decision',
      'existing_folder_prior',
      'outgoing_links',
      'backlinks',
      'neighbor_category_distribution',
      'embedding_similarity',
      'rule_match',
      'category_profile_match',
      'negative_evidence'
    )
  ),

  supports_category_id TEXT REFERENCES categories(category_id),
  contradicts_category_id TEXT REFERENCES categories(category_id),

  score REAL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
```

---

## 2.6 New hardening change 5: accepted placements must have evidence

Use triggers to force the workflow:

```text
insert candidate placement
add evidence
update placement to accepted
```

```sql
CREATE TRIGGER placement_no_direct_accept
BEFORE INSERT ON placement_assertions
WHEN NEW.status = 'accepted'
BEGIN
  SELECT RAISE(
    ABORT,
    'Do not insert accepted placements directly. Insert candidate, add evidence, then accept.'
  );
END;

CREATE TRIGGER placement_accept_requires_evidence
BEFORE UPDATE OF status ON placement_assertions
WHEN NEW.status = 'accepted'
  AND NOT EXISTS (
    SELECT 1
    FROM evidence
    WHERE evidence.placement_id = NEW.placement_id
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Accepted placement must have at least one evidence record.'
  );
END;
```

This converts Òevidence-backed placementÓ from an architectural intention into a database-enforced rule.

---

## 2.7 Append-only event table

```sql
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
```

## New hardening change 6: append-only event triggers

```sql
CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events table is append-only; updates are not allowed');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events table is append-only; deletes are not allowed');
END;
```

The event log becomes the semantic memory of the system.

---

## 2.8 Category changes

```sql
CREATE TABLE category_changes (
  change_id TEXT PRIMARY KEY,

  operation TEXT NOT NULL CHECK (
    operation IN (
      'create_category',
      'rename_category',
      'move_category',
      'split_category',
      'merge_categories',
      'deprecate_category',
      'convert_category_to_tag',
      'convert_category_to_status',
      'convert_category_to_project_context',
      'change_projection_policy'
    )
  ),

  from_scheme_id TEXT REFERENCES category_schemes(scheme_id),
  to_scheme_id TEXT REFERENCES category_schemes(scheme_id),

  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'proposed',
      'approved',
      'applied',
      'rejected',
      'rolled_back'
    )
  ),

  rationale TEXT,
  evidence_json TEXT,
  migration_id TEXT,

  created_at TEXT NOT NULL,
  applied_at TEXT
);
```

mdplaceCL is a useful reference point for this layer because it defines a high-level data model and controlled natural language for describing ontology and mdplace changes, including changes that can function as Òapply patchÓ or ÒdiffÓ records. ([OUP Academic][9])

---

## 2.9 New hardening change 2: normalized `category_change_items`

This is what makes category evolution queryable.

```sql
CREATE TABLE category_change_items (
  change_id TEXT NOT NULL REFERENCES category_changes(change_id),

  item_kind TEXT NOT NULL CHECK (
    item_kind IN (
      'category',
      'topic_tag',
      'project_context',
      'workflow_status',
      'collection',
      'projection_policy'
    )
  ),

  item_id TEXT NOT NULL,

  role TEXT NOT NULL CHECK (
    role IN (
      'created',
      'old_category',
      'new_category',
      'renamed_from',
      'renamed_to',
      'moved_from',
      'moved_to',
      'merged_from',
      'merged_into',
      'split_from',
      'split_into',
      'deprecated',
      'replacement',
      'converted_from',
      'converted_to',
      'affected',
      'compatibility_alias'
    )
  ),

  PRIMARY KEY (change_id, item_kind, item_id, role)
);
```

Now the system can answer:

```text
Was this category renamed?
Was it split?
Was it merged?
Was it deprecated?
What replaced it?
Which categories were created by a split?
Which old categories were merged into this one?
```

---

## 2.10 New hardening change 3: persisted `projection_policies`

```sql
CREATE TABLE projection_policies (
  policy_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'active', 'deprecated')
  ),
  created_at TEXT NOT NULL
);
```

Example `policy_json`:

```json
{
  "root": "notes/",
  "path_template": "{category_path}/{file_slug}.md",
  "category_source": "primary_category",
  "collision_strategy": "append-short-file-id",
  "update_frontmatter": true,
  "create_path_aliases": true,
  "dry_run_required": true
}
```

Persisting the policy is essential because otherwise you cannot reproduce a projection. The system must know not just that `proj:v12` happened, but exactly how paths were calculated.

---

## 2.11 Projection runs and projected paths

```sql
CREATE TABLE projection_runs (
  projection_id TEXT PRIMARY KEY,

  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  policy_id TEXT NOT NULL REFERENCES projection_policies(policy_id),

  status TEXT NOT NULL CHECK (
    status IN ('planned', 'dry_run', 'validated', 'applied', 'rolled_back', 'failed')
  ),

  manifest_path TEXT NOT NULL,
  plan_hash TEXT NOT NULL,

  generated_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE projected_paths (
  projection_id TEXT NOT NULL REFERENCES projection_runs(projection_id),
  file_id TEXT NOT NULL REFERENCES files(file_id),

  from_path TEXT,
  to_path TEXT NOT NULL,

  action TEXT NOT NULL CHECK (
    action IN (
      'move',
      'create',
      'update_frontmatter',
      'unchanged',
      'delete_projection'
    )
  ),

  placement_id TEXT REFERENCES placement_assertions(placement_id),

  PRIMARY KEY (projection_id, file_id)
);
```

---

## 2.12 New hardening change 4: `validation_runs`

```sql
CREATE TABLE validation_runs (
  validation_id TEXT PRIMARY KEY,

  projection_id TEXT NOT NULL REFERENCES projection_runs(projection_id),
  scheme_id TEXT NOT NULL REFERENCES category_schemes(scheme_id),
  policy_id TEXT NOT NULL REFERENCES projection_policies(policy_id),

  plan_hash TEXT NOT NULL,

  status TEXT NOT NULL CHECK (
    status IN ('passed', 'failed')
  ),

  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## New hardening change 4: projection apply requires passed validation

```sql
CREATE TRIGGER projection_no_direct_apply
BEFORE INSERT ON projection_runs
WHEN NEW.status = 'applied'
BEGIN
  SELECT RAISE(
    ABORT,
    'Projection cannot be inserted as applied. Create dry-run, validate, then apply.'
  );
END;

CREATE TRIGGER projection_apply_requires_validation
BEFORE UPDATE OF status ON projection_runs
WHEN NEW.status = 'applied'
  AND NOT EXISTS (
    SELECT 1
    FROM validation_runs
    WHERE validation_runs.projection_id = NEW.projection_id
      AND validation_runs.plan_hash = NEW.plan_hash
      AND validation_runs.status = 'passed'
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'Projection cannot be applied without a passing validation run for the same plan.'
  );
END;
```

This ensures that validation is not a best-effort report. It becomes an enforced gate.

---

## 2.13 Path aliases

```sql
CREATE TABLE path_aliases (
  old_path TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(file_id),
  new_path TEXT NOT NULL,
  projection_id TEXT REFERENCES projection_runs(projection_id),
  created_at TEXT NOT NULL
);
```

This supports:

```text
resolve old path ? stable file_id ? current path
```

---

# 3. Main workflows

## Workflow A Ñ Initialize repository

```bash
mdplace init
```

Creates:

```text
.mdplace/ledger.sqlite
.mdplace/categories/scheme-v1.yaml
.mdplace/rules/placement-rules.yaml
.mdplace/projections/
.mdplace/validation/
```

Seeds:

```text
default category scheme
default projection policy
event log
validation rules
```

Initial categories might be minimal:

```text
Inbox
Research
Projects
Reference
Archive
Needs Review
```

But `Needs Review` should likely be a `workflow_status`, not a navigational folder, unless you explicitly want an inbox-style projection.

---

## Workflow B Ñ Scan Markdown files

```bash
mdplace scan
```

Actions:

```text
find .md files
parse frontmatter
mint mdplace_id if missing
compute content hash
extract title/headings/tags/links
record FileDiscovered or FileContentChanged events
update file registry
```

Physical location is recorded, but not treated as final category truth.

Real-world note tools already show the usefulness of both hierarchy and graph signals: Dendron emphasizes hierarchical Markdown organization while still supporting backlinks, tags, and keywords; ObsidianÕs graph view represents notes as nodes and internal links as edges. ([Dendron][10])

---

## Workflow C Ñ Propose placements

```bash
mdplace propose-placements
```

Candidate placement signals:

```text
title match
heading terms
frontmatter tags
links/backlinks
neighbor category distribution
existing folder prior
embedding similarity
manual corrections
```

Example output:

```yaml
file_id: file:01JABC
candidates:
  - category: cat:knowledge-graphs
    score: 0.91
    evidence:
      - title contains "semantic taxonomy"
      - headings mention "adaptive mdplace"
      - backlinks mostly from mdplace notes
  - category: cat:ontology-engineering
    score: 0.74
  - category: cat:rag-systems
    score: 0.43
```

Then:

```text
insert PlacementAssertion(status='candidate')
insert Evidence records
```

---

## Workflow D Ñ Accept placement

```bash
mdplace accept-placement place:01JABD
```

Actions:

```text
verify evidence exists
mark candidate placement as accepted
supersede previous accepted placement if needed
emit PlacementAccepted and PlacementSuperseded events
```

The trigger ensures no accepted placement can exist without evidence.

---

## Workflow E Ñ Dry-run projection

```bash
mdplace project --dry-run
```

Actions:

```text
load active category scheme
load active projection policy
load accepted placements
compute target paths
write projection_run(status='dry_run')
write projected_paths
write projection manifest
compute plan_hash
run validation
write validation_run
```

Example dry-run report:

```json
{
  "projection_id": "proj:v12",
  "scheme_id": "scheme:v3",
  "policy_id": "policy:primary-category-folders-v1",
  "plan_hash": "sha256:...",
  "moves": 37,
  "frontmatter_updates": 41,
  "path_aliases_to_create": 37,
  "collisions": 0,
  "invalid_categories": 0,
  "accepted_placements_without_evidence": 0,
  "status": "validation_passed"
}
```

---

## Workflow F Ñ Apply projection

```bash
mdplace project --apply proj:v12
```

Preconditions:

```text
projection exists
projection status is dry_run or validated
validation_run exists
validation_run.status = passed
validation plan_hash matches projection plan_hash
```

Actions:

```text
stage file moves
update frontmatter
create path aliases
update files.current_path
emit events
write projection manifest
optionally create Git commit
mark projection_run as applied
```

Because filesystem moves and database writes are not perfectly atomic together, use a rollback-safe sequence:

```text
1. Make dry-run manifest.
2. Validate.
3. Stage target folders.
4. Move files using collision-safe temporary paths if needed.
5. Update frontmatter.
6. Update DB state.
7. Emit ProjectionApplied event.
8. Optionally create Git commit.
9. On failure, use manifest to restore old paths.
```

---

## Workflow G Ñ Detect wrong categories

```bash
mdplace audit-placements
```

Triggers:

```text
file content changed
link neighborhood changed
category profile changed
manual correction happened
taxonomy changed
current category score dropped
another category wins by threshold
```

Example:

```text
Current placement:
  cat:rag-systems, score now 0.42

Best candidate:
  cat:knowledge-graphs, score 0.91

Action:
  create new candidate placement
  cite evidence
  optionally auto-accept if confidence and policy allow
```

Old placement is not deleted:

```text
old placement ? superseded
new placement ? accepted
```

This is a truth-maintenance pattern at small scale: the system preserves the old belief and the justification for replacing it.

---

## Workflow H Ñ Split category

```bash
mdplace split-category cat:ai-knowledge-systems
```

Use when a category becomes too broad or internally clustered.

Example:

```text
AI Knowledge Systems
  ? Knowledge Graphs
  ? RAG Systems
  ? Ontology Engineering
  ? Vector Search
```

Generated records:

```text
CategoryChange(operation='split_category')
CategoryChangeItems:
  cat:ai-knowledge-systems role='split_from'
  cat:knowledge-graphs role='split_into'
  cat:rag-systems role='split_into'
  cat:ontology-engineering role='split_into'
CategoryMappings:
  old ? new candidates
PlacementAssertions:
  affected files re-evaluated
CategoryAliases:
  old category resolves to compatibility page or split guidance
```

Formal Concept Analysis is useful here because it models objects and attributes and produces concept hierarchies/lattices; for Markdown, ÒobjectsÓ are files and ÒattributesÓ are terms, tags, links, headings, or extracted features. ([CompLogic Center][11])

---

## Workflow I Ñ Merge categories

```bash
mdplace merge-categories cat:semantic-graphs cat:knowledge-graphs
```

Use when categories are effectively duplicates or one is a legacy synonym.

Generated records:

```text
CategoryChange(operation='merge_categories')
CategoryChangeItems:
  cat:semantic-graphs role='merged_from'
  cat:knowledge-graphs role='merged_into'
CategoryMapping:
  cat:semantic-graphs ? cat:knowledge-graphs, mapping_type='merged_into'
CategoryAlias:
  old cat:semantic-graphs resolves to cat:knowledge-graphs
PathAlias:
  old paths resolve to current paths after projection
```

Do not delete the old category. Mark it deprecated or obsolete and keep the mapping.

---

## Workflow J Ñ Convert category to status/tag/project

```bash
mdplace convert-category-to-status cat:to-review
```

Use when a category is not a real content category.

Example:

```text
Before:
  notes/To Review/adaptive-taxonomy.md

After:
  notes/Research/Knowledge Graphs/adaptive-taxonomy.md
  frontmatter status: to-review
```

Generated records:

```text
CategoryChange(operation='convert_category_to_status')
CategoryChangeItem:
  cat:to-review role='converted_from'
  status:to-review role='converted_to'
CategoryMapping:
  cat:to-review ? workflow_status "to-review"
CategoryAlias:
  cat:to-review resolves to status filter
PlacementAssertions:
  affected files get new content categories
Frontmatter updates:
  status: to-review
```

This is the Markdown version of Òconvert class into role/status.Ó

---

# 4. Invariant queries

The system must answer each invariant through durable records.

## ÒWhy is this Markdown file in this folder?Ó

Path:

```text
current path
? files.file_id
? projected_paths
? projection_run
? placement_assertion
? evidence
? category
? rule / actor / event history
```

Answer example:

```text
This file is in notes/Research/Knowledge Graphs/
because placement place:01JABD assigned file:01JABC
to cat:knowledge-graphs under scheme:v3.
The placement was accepted with confidence 0.91 based on title terms,
heading terms, backlinks, and manual confirmation.
Projection proj:v12 materialized that placement using policy
primary-category-folders-v1.
```

---

## ÒWhich category scheme placed it there?Ó

Path:

```text
projected_paths.placement_id
? placement_assertions.scheme_id
? category_schemes
```

Also:

```text
projection_runs.scheme_id
```

---

## ÒWhat evidence supported that placement?Ó

Path:

```text
placement_assertions.placement_id
? evidence.placement_id
```

Because accepted placements require evidence, this cannot be empty.

---

## ÒWas it ever somewhere else?Ó

Path:

```text
file_versions
+ projected_paths
+ path_aliases
+ events
```

This answers both physical history and semantic history.

---

## ÒWas the category itself renamed, split, merged, or deprecated?Ó

Path:

```text
category_change_items
? category_changes
? category_mappings
? category_aliases
```

The normalized change table is what makes this reliable.

---

## ÒWhat old paths still point to it?Ó

Path:

```text
path_aliases.old_path
? file_id
? files.current_path
```

---

## ÒWhat would happen if we rebuild the folder tree today?Ó

Path:

```text
active scheme
+ active projection policy
+ current accepted placements
+ current file registry
? mdplace project --dry-run
? projection_run + validation_run
```

The dry-run produces planned moves without mutating the filesystem.

---

# 5. Theory and real-world grounding by layer

| Layer                  | Theory / precedent                    | How it applies                                                                                                                      |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Markdown + Git         | Git snapshot history                  | Git stores file-level history, while the ledger stores semantic reasons for moves. ([Git][2])                                       |
| Frontmatter            | GitHub Docs / Jekyll-style metadata   | Frontmatter provides a lightweight file-local bridge to the semantic ledger. ([GitHub Docs][3])                                     |
| Category scheme        | SKOS / knowledge organization systems | Treat Markdown categories as taxonomy concepts, not rigid logical classes. ([W3C][4])                                               |
| Evidence               | PROV-O                                | Evidence records mirror provenance: source, activity, agent, derivation. ([W3C][6])                                                 |
| Event history          | Event sourcing                        | All semantic changes are preserved as an append-only event stream. ([martinfowler.com][1])                                          |
| Folder projection      | CQRS + materialized views             | Ledger is write-side truth; folder tree/API/indexes are read-side projections. ([martinfowler.com][12])                             |
| Validation             | JSON Schema / SQLite FKs / SHACL      | Validate category files, ledger integrity, and optionally RDF graph constraints. ([JSON Schema][8])                                 |
| Category evolution     | mdplaceCL                                  | Represent category changes as first-class patch/diff-like records. ([OUP Academic][9])                                              |
| Change propagation     | OntoRipple analogy                    | The same idea applies: taxonomy changes must propagate to projections, shapes, aliases, and downstream views. ([ScienceDirect][13]) |
| Split detection        | Formal Concept Analysis               | Files are objects; terms/tags/links are attributes; lattices suggest category splits. ([CompLogic Center][11])                      |
| Learned definitions    | DL-Learner-style concept learning     | Later, positive/negative examples can suggest definitions for categories. ([DL Learner][14])                                        |
| RAG assistant          | GraphRAG                              | Optional: extract richer signals from note text and summarize category communities. ([Microsoft GitHub][15])                        |
| Future migration rigor | Functorial data migration             | For complex scheme migrations, old?new taxonomy transformations can be modeled formally. ([arXiv][16])                              |

---

# 6. Recommended CLI

A practical first CLI:

```bash
mdplace init

mdplace scan
mdplace validate

mdplace propose-placements
mdplace accept-placement place:...
mdplace reject-placement place:...
mdplace explain file:...

mdplace project --dry-run
mdplace project --apply proj:...
mdplace project --rollback proj:...

mdplace history file:...
mdplace resolve-path "notes/old/path.md"
mdplace resolve-category cat:old-category

mdplace split-category cat:...
mdplace merge-categories cat:a cat:b
mdplace rename-category cat:...
mdplace deprecate-category cat:...
mdplace convert-category-to-status cat:...
mdplace convert-category-to-tag cat:...

mdplace export-api
mdplace export-skos
mdplace export-prov
```

The most important early commands:

```bash
mdplace explain file:...
mdplace project --dry-run
mdplace validate
mdplace resolve-path ...
mdplace history file:...
```

Those create trust.

---

# 7. Implementation phases

## Phase 1 Ñ Identity and ledger

Deliver:

```text
mdplace_id in every Markdown file
files table
file_versions table
events table
append-only event triggers
```

Success criterion:

```text
Every file has stable identity independent of path.
```

---

## Phase 2 Ñ Category scheme and placements

Deliver:

```text
category_schemes
categories
placement_assertions
evidence
accepted-placement-requires-evidence trigger
```

Success criterion:

```text
Every accepted placement has a category, scheme, and evidence.
```

---

## Phase 3 Ñ Projection and validation

Deliver:

```text
projection_policies
projection_runs
projected_paths
validation_runs
validation gate trigger
projection manifests
frontmatter updater
path_aliases
```

Success criterion:

```text
No files move unless the projection has passed validation.
```

---

## Phase 4 Ñ Compatibility and category evolution

Deliver:

```text
category_changes
category_change_items
category_mappings
category_aliases
category split/merge/rename/deprecate/convert workflows
```

Success criterion:

```text
Old paths and old categories continue resolving after taxonomy evolution.
```

---

## Phase 5 Ñ Adaptive intelligence

Deliver:

```text
category profiles
wrong-category detection
split suggestions
merge suggestions
category-to-status/tag/project conversion suggestions
embedding support
FCA-based clustering
optional RAG summaries
```

Success criterion:

```text
The system can propose recategorizations and taxonomy changes with evidence.
```

---

# 8. Concrete example

## Starting state

File:

```text
notes/Inbox/adaptive-taxonomy.md
```

Frontmatter:

```yaml
---
mdplace_id: file:01JABC
title: Adaptive Semantic Taxonomy
status: draft
---
```

The scanner extracts:

```text
terms:
  adaptive, semantic, taxonomy, knowledge graph, projection

links:
  ontology-modularity
  mdplace-refinement
  semantic-ledger

tags:
  adaptive-mdplace
  markdown
```

The system proposes:

```yaml
PlacementAssertion:
  placement_id: place:01JABD
  file_id: file:01JABC
  category_id: cat:knowledge-graphs
  scheme_id: scheme:v3
  confidence: 0.91
  status: candidate
```

Evidence:

```yaml
Evidence:
  placement_id: place:01JABD
  evidence_type: heading_terms
  supports_category: cat:knowledge-graphs
  score: 0.88
```

The placement is accepted:

```text
status: accepted
```

Projection dry-run computes:

```text
from:
  notes/Inbox/adaptive-taxonomy.md

to:
  notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
```

Validation passes.

Projection applies.

Frontmatter becomes:

```yaml
---
mdplace_id: file:01JABC
title: Adaptive Semantic Taxonomy
primary_category: cat:knowledge-graphs
category_scheme: scheme:v3
placement_id: place:01JABD
projection_id: proj:v12
status: draft
tags:
  - adaptive-mdplace
  - markdown
---
```

Path alias is created:

```yaml
old_path: notes/Inbox/adaptive-taxonomy.md
new_path: notes/Research/Knowledge Graphs/adaptive-semantic-taxonomy.md
file_id: file:01JABC
```

Later, if `Knowledge Graphs` splits into `Ontology Engineering` and `mdplace Systems`, the system creates:

```text
CategoryChange(operation='split_category')
CategoryChangeItems
CategoryMappings
CategoryAliases
new PlacementAssertions
new ProjectionRun
new PathAliases
```

No old truth is erased. It is superseded, mapped, or aliased.

---

# 9. Final implementation invariant set

The hardened design now satisfies all required features:

```text
1. Stable mdplace_id in every Markdown file.
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

And it answers all required invariants:

```text
Why is this Markdown file in this folder?
  placement assertion + evidence + projection manifest

Which category scheme placed it there?
  placement.scheme_id + projection.scheme_id

What evidence supported that placement?
  evidence records linked to placement_id

Was it ever somewhere else?
  projected_paths + file_versions + path_aliases + events

Was the category itself renamed, split, merged, or deprecated?
  category_changes + category_change_items + category_mappings

What old paths still point to it?
  path_aliases

What would happen if we rebuild the folder tree today?
  projection dry-run under current scheme + current policy + current placements
```

The implementation-ready core is:

```text
Semantic ledger = source of truth
Category scheme = versioned navigational ontology
PlacementAssertion = evidence-backed judgment
ProjectionPolicy = reproducible folder-layout rule
ValidationRun = hard gate before file movement
ProjectionManifest = build record
PathAlias + CategoryAlias = compatibility layer
Append-only events = durable history
Frontmatter = file-local bridge
Folder tree = rebuildable projection
```

[1]: https://martinfowler.com/eaaDev/EventSourcing.html?utm_source=chatgpt.com "Event Sourcing"
[2]: https://git-scm.com/docs/user-manual?utm_source=chatgpt.com "Git - user-manual Documentation"
[3]: https://docs.github.com/en/contributing/writing-for-github-docs/using-yaml-frontmatter?utm_source=chatgpt.com "Using YAML frontmatter"
[4]: https://www.w3.org/TR/skos-reference/?utm_source=chatgpt.com "SKOS Simple Knowledge Organization System Reference"
[5]: https://martinfowler.com/articles/bitemporal-history.html?utm_source=chatgpt.com "Bitemporal History"
[6]: https://www.w3.org/TR/prov-o/?utm_source=chatgpt.com "PROV-O: The PROV Ontology"
[7]: https://www.sqlite.org/lang_createtrigger.html?utm_source=chatgpt.com "CREATE TRIGGER"
[8]: https://json-schema.org/docs?utm_source=chatgpt.com "Docs"
[9]: https://academic.oup.com/database/article/doi/10.1093/database/baae133/7972659?utm_source=chatgpt.com "change language for ontologies and knowledge graphs"
[10]: https://wiki.dendron.so/notes/f3a41725-c5e5-4851-a6ed-5f541054d409/?utm_source=chatgpt.com "Hierarchies"
[11]: https://iccl.inf.tu-dresden.de/web/Formal_Concept_Analysis/en?utm_source=chatgpt.com "Formal Concept Analysis"
[12]: https://martinfowler.com/bliki/CQRS.html?utm_source=chatgpt.com "CQRS"
[13]: https://www.sciencedirect.com/science/article/pii/S2352711026000361?utm_source=chatgpt.com "OntoRipple: Making waves in the knowledge graph lifecycle"
[14]: https://dl-learner.org/one-page-introduction/?utm_source=chatgpt.com "One page introduction | - DL-Learner"
[15]: https://microsoft.github.io/graphrag/?utm_source=chatgpt.com "Welcome - GraphRAG"
[16]: https://arxiv.org/abs/1009.1166?utm_source=chatgpt.com "Functorial Data Migration"
