Yes — that is a **valid design question**, and the questioner is **not confused**.

They are identifying a real boundary:

```text
Conflict schema answers:
  What kinds of conflicts can exist?
  How are they represented?
  What is the global impact?

Per-consumer contract answers:
  What does this specific consumer need?
  What does this consumer do when a conflict occurs?
  What output shape, freshness, and failure behavior are guaranteed?
```

So `consumer_impact` is useful, but it is not sufficient by itself. It tells you that a consumer may be affected. It does not fully define that consumer’s expectations or allowed behavior.

# What is missing?

The design already has a general `ConsumerContract` idea, but the question points out that it needs to become more concrete.

You should add a **per-consumer contract/spec layer**.

Current design says:

```text
downstream consumers should not break
```

The improved design says:

```text
each downstream consumer declares what it reads, what it expects,
what conflicts it can tolerate, what failures mean, and whether it may mutate state
```

That is a stronger and more implementation-ready requirement.

# Why `consumer_impact` is not enough

Suppose a category split happens:

```text
cat:ai-knowledge-systems
→ cat:knowledge-graphs
→ cat:rag-systems
→ cat:ontology-engineering
```

The same conflict affects different consumers differently.

| Consumer                   | Conflict meaning                                          |
| -------------------------- | --------------------------------------------------------- |
| **CLI human**              | Show warning and ask for decision.                        |
| **JSON/API export**        | Must preserve stable schema and expose aliases.           |
| **Search index**           | Can accept temporary staleness, then rebuild.             |
| **Publishing workflow**    | Broken path or unresolved category may be a hard failure. |
| **Obsidian/link resolver** | Needs old-path resolution and backlink preservation.      |
| **Automation scripts**     | Need predictable exit codes and machine-readable errors.  |

A single `consumer_impact` field cannot encode all of that well.

It can say:

```json
{
  "consumer": "publishing-workflow",
  "impact": "breaking"
}
```

But the consumer contract must say:

```text
What counts as breaking?
Should the pipeline fail?
What exit code?
Can aliases be used?
How fresh must the projection be?
Which output schema version is expected?
Can this consumer write frontmatter or only read it?
```

# New requirement to add

Add this requirement:

```text
Every supported consumer must have a versioned ConsumerContract that declares
its required read queries, accepted conflict actions, severity behavior,
freshness expectations, output schema, mutation permissions, and failure behavior.
```

And add this invariant:

```text
A projection, category change, or conflict resolution may not be applied
unless all active ConsumerContracts are either satisfied or an approved
breaking-change exception exists.
```

# Updated architecture layer

Add a dedicated layer:

```text
Consumer contract layer
  - CLI contract
  - API/export contract
  - Search index contract
  - Publishing workflow contract
  - Obsidian/link resolver contract
  - Automation script contract
```

This sits next to the compatibility layer:

```text
Semantic ledger
  ↓
Projection / aliases / category mappings
  ↓
Consumer contracts
  ↓
Consumer-specific read models and behavior
```

# What each consumer contract should define

A practical contract should include:

```yaml
ConsumerContract:
  consumer_id: consumer:publishing-workflow
  consumer_type: publishing_workflow
  contract_version: 1

  required_read_queries:
    - resolve_current_path(file_id)
    - resolve_old_path(old_path)
    - list_files_by_category(category_id)
    - detect_unresolved_review_files()

  accepted_conflict_actions:
    category_renamed: use_alias
    category_merged: use_alias
    category_split: fail_if_unresolved
    path_changed: use_path_alias
    insufficient_evidence: exclude_or_fail
    conflicting_evidence: fail

  severity_behavior:
    info: continue
    warning: continue_with_report
    error: fail
    blocking: fail

  freshness:
    max_projection_age_seconds: 0
    require_latest_projection: true
    require_validation_passed: true

  output_schema:
    schema_id: schema:publishing-export-v1
    stable_fields:
      - file_id
      - current_path
      - title
      - primary_category
      - placement_state
      - path_aliases

  mutation_permissions:
    can_move_files: false
    can_update_frontmatter: false
    can_create_review_tasks: false

  failure_behavior:
    exit_code_on_warning: 0
    exit_code_on_error: 2
    exit_code_on_blocking: 3
    report_format: json
```

# Consumer-specific examples

## 1. CLI human

The CLI can tolerate ambiguity because a human is present.

```yaml
consumer_id: consumer:cli-human
accepted_conflict_actions:
  insufficient_evidence: prompt_user
  ambiguous_category: prompt_user
  category_split: show_candidates
  path_changed: show_alias
severity_behavior:
  warning: show
  error: show_and_require_confirmation
mutation_permissions:
  can_accept_placement: true
  can_reject_placement: true
  can_create_review_decision: true
```

The CLI contract is interactive.

It should answer:

```text
What happened?
Why?
What are my options?
What happens if I accept/reject?
```

## 2. JSON/API export

The API needs stable schemas and predictable compatibility.

```yaml
consumer_id: consumer:json-api-export
required_read_queries:
  - get_file(file_id)
  - resolve_path(old_path)
  - resolve_category(old_category_id)
  - list_files_by_category(category_id)
accepted_conflict_actions:
  category_renamed: expose_alias
  category_merged: expose_alias
  category_split: expose_split_requires_review
  insufficient_evidence: expose_null_primary_category
output_schema:
  schema_id: schema:file-view-v1
  required_fields:
    - file_id
    - current_path
    - placement_state
    - primary_category
    - category_scheme
failure_behavior:
  malformed_output: fail
```

The API should not hide uncertainty. It should expose it.

For example:

```json
{
  "file_id": "file:01JDEF",
  "current_path": "notes/_Review/Insufficient Evidence/foo.md",
  "path_reason": "review_state",
  "placement_state": "insufficient_evidence",
  "primary_category": null,
  "hypothesis_id": "hyp:001"
}
```

## 3. Search index

The search index can often tolerate temporary staleness, but needs rebuild rules.

```yaml
consumer_id: consumer:search-index
freshness:
  max_projection_age_seconds: 3600
  allow_stale_aliases: true
accepted_conflict_actions:
  path_changed: update_index
  category_renamed: reindex_category_label
  category_split: reindex_affected_files
  insufficient_evidence: index_with_review_state
failure_behavior:
  stale_projection: warn
  missing_file: skip_and_report
mutation_permissions:
  can_mutate_ledger: false
```

The search index should usually read from stable APIs, not raw filesystem assumptions.

## 4. Publishing workflow

Publishing is usually stricter.

```yaml
consumer_id: consumer:publishing-workflow
freshness:
  require_latest_projection: true
  require_validation_passed: true
accepted_conflict_actions:
  path_changed: use_alias
  category_renamed: use_alias
  category_split: fail_if_unresolved
  insufficient_evidence: exclude_or_fail
  conflicting_evidence: fail
severity_behavior:
  warning: continue_with_report
  error: fail
  blocking: fail
failure_behavior:
  exit_code_on_error: 2
  report_format: json
```

Publishing should not silently publish files with unresolved category state unless explicitly configured.

## 5. Obsidian/link resolver

Obsidian-style workflows care about links and paths.

```yaml
consumer_id: consumer:obsidian-link-resolver
required_read_queries:
  - resolve_old_path(old_path)
  - resolve_file_id_from_path(path)
  - get_current_path(file_id)
accepted_conflict_actions:
  path_changed: use_path_alias
  file_moved: update_links_or_resolve_alias
  category_folder_changed: preserve_backlinks
freshness:
  max_projection_age_seconds: 0
mutation_permissions:
  can_update_markdown_links: optional
```

This consumer must distinguish:

```text
semantic folder path changed
```

from:

```text
file identity changed
```

Most moves should preserve `file_id`.

## 6. Automation scripts

Automation needs deterministic machine behavior.

```yaml
consumer_id: consumer:automation-scripts
required_read_queries:
  - resolve_path
  - get_projection_status
  - validate_before_run
accepted_conflict_actions:
  insufficient_evidence: fail
  ambiguous_category: fail
  path_changed: resolve_alias
severity_behavior:
  warning: continue
  error: fail
  blocking: fail
failure_behavior:
  exit_codes:
    warning: 0
    validation_error: 2
    unresolved_conflict: 3
    stale_projection: 4
  report_format: json
```

Automation should never depend on vague human-readable text.

# Schema addition

Your current `consumer_contracts` table can be made more concrete.

```sql
CREATE TABLE consumer_contracts (
  consumer_id TEXT PRIMARY KEY,
  consumer_type TEXT NOT NULL CHECK (
    consumer_type IN (
      'cli_human',
      'json_api_export',
      'search_index',
      'publishing_workflow',
      'obsidian_link_resolver',
      'automation_script'
    )
  ),
  contract_version INTEGER NOT NULL,
  contract_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'deprecated')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
```

Add validation results per consumer:

```sql
CREATE TABLE consumer_validation_results (
  validation_id TEXT NOT NULL REFERENCES validation_runs(validation_id),
  consumer_id TEXT NOT NULL REFERENCES consumer_contracts(consumer_id),
  status TEXT NOT NULL CHECK (
    status IN ('passed', 'warning', 'failed', 'not_applicable')
  ),
  report_json TEXT NOT NULL,
  PRIMARY KEY (validation_id, consumer_id)
);
```

Now projection validation can say:

```text
General validation passed.
CLI contract passed.
API export contract passed.
Search index contract warning.
Publishing workflow failed.
Automation script contract passed.
```

That is much more useful than a single global pass/fail.

# How this changes validation

Previously:

```text
ValidationRun.status = passed | failed
```

Now you probably want:

```text
ValidationRun
  global_status

ConsumerValidationResult
  per-consumer status
```

Then the projection apply rule can be:

```text
Projection may apply only if:
  global validation passed
  and all blocking active consumer contracts passed
  unless approved exception exists
```

Add an exception table if needed:

```sql
CREATE TABLE consumer_contract_exceptions (
  exception_id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumer_contracts(consumer_id),
  validation_id TEXT REFERENCES validation_runs(validation_id),
  projection_id TEXT REFERENCES projection_runs(projection_id),
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
```

# New invariant

Add this to the design:

```text
Every consumer-facing artifact must be produced through a declared ConsumerContract,
or explicitly marked experimental/non-contractual.
```

And:

```text
No category change or projection should be considered safe merely because
the global conflict schema is valid; it must also satisfy the active
ConsumerContracts that depend on it.
```

# Is the questioner confused?

No. They are seeing a real gap.

They are basically saying:

```text
You modeled conflict representation,
but not consumer-specific conflict behavior.
```

That is exactly right.

The conflict schema answers:

```text
What happened?
What is affected?
What severity is it?
```

The consumer contract answers:

```text
What should this specific consumer do about it?
```

Both are needed.

# Updated requirement

Add this requirement:

```text
15. Per-consumer contracts must define required read queries,
accepted conflict actions, severity behavior, freshness expectations,
stable output schemas, mutation permissions, and failure behavior.
```

And add this invariant:

```text
For every active consumer, the system must be able to determine whether a
projection/category change is compatible, warning-only, or blocking according
to that consumer’s contract.
```

# Bottom line

This is a valid and important design question.

It identifies the next missing layer:

```text
Conflict schema = shared language of problems.
ConsumerContract = consumer-specific policy for handling those problems.
```

Without per-consumer contracts, `consumer_impact` is only a warning label. With per-consumer contracts, the system can actually decide:

```text
Can this projection apply?
Should this API response include aliases?
Should publishing fail?
Should search reindex?
Should the CLI ask the user?
Should automation exit with code 3?
```

So yes: add per-consumer specs. They are necessary for keeping downstream systems from breaking as the adaptive taxonomy evolves.
