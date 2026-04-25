Yes. **Option A can dual-support Option B**, but only if the design is explicit about one rule:

```text
The canonical unit is the semantic event, not SQLite and not the service database.
```

Then both self-hosted and managed modes can use the same event model.

The safe architecture is:

```text
Repo-native mode:
  Git-tracked events are canonical.
  SQLite is generated cache.

Managed-service mode:
  Service stores, validates, indexes, and syncs the same canonical events.
  The service database is an operational event store/cache, not a different semantic model.
```

That lets you support both:

```text
git clone repo
mdplace rebuild-cache
mdplace explain file:...
```

and:

```text
mdplace login
mdplace sync
mdplace explain file:...
```

without designing two incompatible products.

# The key distinction

You can dual-support Option A and Option B only if the **event format and semantic replay rules are storage-independent**.

In other words:

```text
Canonical semantic model:
  CategoryScheme
  PlacementHypothesis
  PlacementAssertion
  Evidence
  ReviewTask
  CategoryChange
  ProjectionApplied
  PathAlias
  CategoryMapping

Storage backends:
  Git-tracked JSONL/NDJSON events
  SQLite cache
  hosted event store
  self-hosted server database
```

The service should not invent a separate model. It should consume and emit the same event types as the repo-native implementation.

This is consistent with event sourcing: event sourcing stores changes as events and can reconstruct state by replaying them. CQRS then separates the write model from query/read models, which fits your design where events are semantic truth and SQLite/API/folder trees are projections. ([martinfowler.com][1])

---

# Recommended architecture: Option A as the portable core, Option B as a sync/index layer

The cleanest product architecture is:

```text
                 ┌────────────────────────────┐
                 │ Canonical event contract    │
                 │ event schema + replay rules │
                 └──────────────┬─────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          │                                           │
┌─────────▼──────────┐                      ┌─────────▼──────────┐
│ Repo-native mode   │                      │ Managed service     │
│                    │                      │                    │
│ .mdplace/events/   │                      │ hosted event store  │
│ YAML schemes       │                      │ hosted validation   │
│ JSONL events       │                      │ hosted indexes      │
│ generated SQLite   │                      │ collaboration UI    │
└─────────┬──────────┘                      └─────────┬──────────┘
          │                                           │
          └─────────────────────┬─────────────────────┘
                                │
                      ┌─────────▼─────────┐
                      │ Same CLI / API     │
                      │ mdplace explain    │
                      │ mdplace project    │
                      │ mdplace validate   │
                      └───────────────────┘
```

So Option B should be:

```text
managed replica / authority over the same event stream
```

not:

```text
a separate service-only semantic database
```

---

# Three operating modes

You can support three modes cleanly.

## Mode 1: Local-first / repo-canonical

```text
Canonical:
  .mdplace/events/*.jsonl
  .mdplace/schemes/*.yaml
  .mdplace/policies/*.yaml
  .mdplace/migrations/*.yaml
  applied projection manifests

Generated:
  .mdplace/cache/ledger.sqlite
  search index
  embeddings
  dry-run reports
```

Use case:

```bash
git clone repo
mdplace rebuild-cache
mdplace explain file:...
mdplace project --dry-run
```

This is the pure Option A model.

It is best for:

```text
single-user local-first workflows
open-source/public note repositories
auditable PR-based taxonomy changes
offline operation
CI validation
```

Git’s distributed workflows already support multiple clones, branches, and integration workflows, so this mode fits naturally with Git-based collaboration. ([Git][2])

---

## Mode 2: Managed mirror / hosted cache

```text
Canonical:
  repo-tracked events

Service:
  indexes events
  validates pull requests
  provides search
  provides web UI
  provides dashboards
  proposes placements/category changes
```

In this mode, the service does **not** own semantic truth. It is a convenience layer.

Workflow:

```text
local repo event → pushed to Git → service ingests → service builds hosted views
```

or:

```text
service proposal → creates PR with event files → repo merge makes it canonical
```

This is excellent for a managed product that still preserves local-first trust.

---

## Mode 3: Managed authority with repo export

```text
Canonical:
  hosted service event store

Repo:
  periodically receives/export events
  can rebuild partial or full local cache from exported events
```

This is closer to Option B.

It is valid if you need:

```text
multi-user concurrency
permissions
team workflows
central audit
real-time collaboration
hosted UI
```

But there is a catch:

```text
If the service is canonical, a Git clone is not fully authoritative unless
the service exports/pushes canonical events back into the repo.
```

So the design must say which guarantee you want:

```text
Strong repo portability:
  service must write/push canonical events into repo

Service authority:
  repo may be incomplete without service sync
```

Both are okay. They are different product contracts.

---

# Avoid the dangerous version: dual canonical truth

Do **not** do this:

```text
Repo events are canonical locally.
Service DB is canonical remotely.
Both can accept changes independently.
No formal sync/conflict rules exist.
```

That creates split-brain semantics.

You would eventually get contradictions like:

```text
repo says file:abc accepted category = cat:knowledge-graphs
service says file:abc accepted category = cat:rag-systems

repo says cat:to-review converted_to_status
service says cat:to-review still navigational_category

repo says category split requires review
service auto-migrated files
```

So the rule should be:

```text
There may be multiple replicas.
There must be one canonical event contract.
Every accepted state must be derivable from accepted events.
```

---

# The event contract is the product core

To dual-support self-hosted and managed modes, define an event envelope that works in both Git and service contexts.

A good event format can borrow ideas from CloudEvents, whose purpose is to describe event data in a common way across services, platforms, and systems. ([CloudEvents][3])

Example:

```json
{
  "id": "evt_01JABD2F8MMZD5M3ZC5T",
  "specversion": "1.0",
  "type": "mdplace.placement.accepted",
  "source": "repo:my-notes",
  "subject": "file:01JABC9Q4S0AH7E5Q2M3X6",
  "time": "2026-04-25T10:20:00+09:00",
  "datacontenttype": "application/json",
  "mdplace_schema_version": 1,
  "actor": "user:alice",
  "workspace_id": "ws:my-notes",
  "branch_id": "main",
  "base_state_hash": "sha256:...",
  "data": {
    "placement_id": "place:01JABD2F8MMZD5M3ZC5T",
    "file_id": "file:01JABC9Q4S0AH7E5Q2M3X6",
    "category_id": "cat:knowledge-graphs",
    "scheme_id": "scheme:v3",
    "evidence_ids": [
      "ev:heading-terms",
      "ev:backlink-neighborhood"
    ],
    "confidence": 0.91
  }
}
```

Important fields:

```text
event id
event type
schema version
workspace/repo id
subject entity
actor
time
base_state_hash
payload
```

For managed service mode, add:

```text
server_received_at
server_sequence
tenant_id
signature/verification fields
```

But do not require those for repo-native replay.

---

# Storage model by deployment mode

## Repo-native

```text
.mdplace/events/
  2026/04/evt_01JABD_placement_accepted.json
  2026/04/evt_01JABE_projection_applied.json

.mdplace/schemes/
  scheme-v3.yaml

.mdplace/policies/
  projection-primary-v1.yaml

.mdplace/cache/
  ledger.sqlite   # ignored/generated
```

SQLite is disposable.

```bash
rm .mdplace/cache/ledger.sqlite
mdplace rebuild-cache
```

should restore state.

---

## Self-hosted service

```text
Canonical:
  event store table
  optionally backed by repo event files

Operational:
  PostgreSQL/SQLite
  search index
  embeddings
  API cache
```

The self-hosted service can run in two submodes:

```text
repo-backed:
  service reads/writes event files in Git

service-backed:
  service owns event store and can export events
```

---

## Managed cloud service

```text
Canonical:
  hosted event store, unless repo-backed mode is enabled

Client repo:
  synced event export/import
  optional PR-based event writeback

Generated local:
  SQLite cache
```

The managed service should still support:

```bash
mdplace export-events
mdplace import-events
mdplace rebuild-cache
```

Otherwise, it becomes a closed service and loses the self-hosted/local-first benefits.

---

# What does “dual support” require?

## 1. One semantic event schema

Every meaningful change must be represented as an event:

```text
FileIdentityMinted
PlacementHypothesisCreated
EvidenceRecorded
PlacementAccepted
PlacementSuperseded
ReviewTaskCreated
ReviewDecisionRecorded
CategoryChangeApplied
CategoryMappingCreated
ProjectionApplied
PathAliasCreated
```

The CLI and service both emit the same event types.

---

## 2. Deterministic replay

Given:

```text
events
+ category schemes
+ projection policies
+ migrations
```

the system must deterministically rebuild:

```text
accepted graph
hypothesis graph
evidence graph
review/change graph
path aliases
category mappings
projection history
```

This is what makes SQLite disposable.

---

## 3. Conflict detection, not just text merge

A Git merge can succeed while semantic state conflicts.

Examples:

```text
two accepted primary placements for same file/scheme
same category renamed differently on two branches
category deleted while another branch maps to it
two projection policies active for same scheme
two aliases for same old category with different targets
```

So after merge:

```bash
mdplace rebuild-cache
mdplace validate
```

must detect semantic conflicts and create review tasks.

---

## 4. Event sync protocol

For service mode, sync should be explicit:

```bash
mdplace sync pull
mdplace sync push
mdplace sync status
```

Push algorithm:

```text
1. Read local unsynced events.
2. Send events to service.
3. Service validates against current server state.
4. If accepted, service records events.
5. If rejected/conflicting, service returns conflict set.
6. Client creates ReviewTask or ConflictResolution event.
```

Pull algorithm:

```text
1. Fetch remote events since last sync token.
2. Append/import events locally.
3. Rebuild or incrementally update cache.
4. Validate semantic state.
```

---

## 5. Authority modes must be declared

Add a config field:

```yaml
mdplace:
  authority_mode: repo_canonical
```

Possible values:

```text
repo_canonical
service_canonical
hybrid_repo_with_service_mirror
```

Semantics:

```text
repo_canonical:
  tracked events are truth

service_canonical:
  service event store is truth

hybrid_repo_with_service_mirror:
  repo events are truth, service provides validation/indexing/UI
```

Do not leave this implicit.

---

# How managed service can write changes

A managed service can propose or apply changes in three ways.

## Pattern A: PR-based writeback

Best for local-first / auditability.

```text
service proposes placement
→ creates event files
→ opens Git PR
→ user reviews
→ merge makes events canonical
```

Pros:

```text
auditable
branch-friendly
repo remains canonical
CI can validate
```

Cons:

```text
slower
requires Git integration
not ideal for real-time collaboration
```

---

## Pattern B: service event append + repo sync

Best for managed authority.

```text
user accepts placement in web UI
→ service appends event
→ client pulls event
→ optional repo export writes event file
```

Pros:

```text
fast
centralized
good for teams
```

Cons:

```text
repo may lag
fresh clone may need service sync
offline audit depends on exports
```

---

## Pattern C: local event append + service mirror

Best for self-hosted/local-first.

```text
user accepts placement locally
→ event file written
→ git push
→ service ingests
```

Pros:

```text
simple
portable
offline-first
```

Cons:

```text
service does not prevent all conflicts before commit
conflicts detected after ingestion/merge
```

---

# Recommended default for your system

For `mdplace`, I would choose:

```text
Default: repo_canonical
Optional: managed mirror
Advanced: service_canonical
```

So the roadmap is:

## MVP

```text
repo-tracked YAML + events
SQLite cache generated
no service required
```

## Self-hosted

```text
local service indexes repo events
web UI
validation server
optional Git PR writeback
```

## Managed

```text
hosted service mirrors repo events
team review UI
sync API
optional service-canonical mode for organizations that want central authority
```

This gives you both self-hosted and managed options without compromising the local-first design.

---

# Updated architecture slogan

The slogan becomes:

```text
Events are the semantic truth.
Git stores them in local-first mode.
The service stores and syncs them in managed mode.
SQLite indexes them.
The folder tree projects them.
Frontmatter bridges files to them.
```

That is the clean dual-support model.

---

# Key warning

Option A can support Option B **only if Option B respects the same canonical event contract**.

If the managed service keeps its own undocumented state transitions, then the product splits into two systems:

```text
local mdplace
managed mdplace
```

and they will eventually disagree.

So the service should be built around:

```text
same event schema
same replay rules
same validation rules
same projection policies
same category mappings
same explanation model
```

Then self-hosted and managed are deployment modes, not different semantic systems.

[1]: https://martinfowler.com/eaaDev/EventSourcing.html?utm_source=chatgpt.com "Event Sourcing"
[2]: https://git-scm.com/book/en/v2/Distributed-Git-Distributed-Workflows?utm_source=chatgpt.com "Distributed Workflows"
[3]: https://cloudevents.io/?utm_source=chatgpt.com "CloudEvents specification"
