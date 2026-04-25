Yes — this is a **valid and important question about the current design**. The questioner is not confused. They found a real unresolved design decision:

```text
Where does canonical semantic truth live?
```

The previous design said “semantic ledger,” but did not fully decide whether that ledger is:

```text
repo-native and reproducible from Git,
local SQLite state,
or a remote/service-backed authority.
```

That choice affects portability, auditability, branching, CI, recovery, and whether `mdplace explain file:...` can work after a fresh clone.

# The key update

The design needs a new top-level requirement:

```text
Canonical semantic state must be explicitly declared.
```

Without this, the system can have all the right tables and still be ambiguous.

The real product question is exactly the one stated:

```text
Should a Git clone contain enough canonical semantic data to rebuild mdplace state?
```

For a Markdown-native, local-first tool, I would answer:

```text
Yes.
```

That means **Option A is the best default**:

```text
Repo-native canonical events + YAML definitions.
SQLite is an ignored/generated cache.
```

---

# Why this matters

The current design promises answers like:

```text
Why is this file in this folder?
Which category scheme placed it there?
What evidence supported it?
Was it ever somewhere else?
What would happen if we rebuild the folder tree today?
```

Those answers require durable semantic history.

If that history only lives in an untracked local SQLite database, then a fresh clone cannot answer those questions unless it also has that SQLite file or a remote service.

So the design must choose between:

```text
repo is self-contained
```

and:

```text
repo depends on an external/local operational ledger
```

Both are valid product models, but they are different systems.

---

# Evaluation of the three options

## Option A — repo-native canonical events

```text
Tracked:
  YAML category schemes
  YAML/JSON projection policies
  migration files
  JSONL/NDJSON/event files
  applied projection manifests, if needed

Ignored/generated:
  SQLite cache
  indexes
  embeddings cache
  validation temp files
```

This is the best model if `mdplace` should be local-first and portable.

A fresh clone should be able to run:

```bash
mdplace rebuild-cache
mdplace validate
mdplace explain file:...
mdplace project --dry-run
```

and recover the semantic state.

This aligns best with the design goal:

```text
Adaptive KG = semantic truth and history
Markdown folder tree = generated projection
Frontmatter = stable bridge
```

But under Option A, adjust the wording:

```text
Adaptive KG canonical state = repo-tracked semantic events + definitions
SQLite = materialized cache/index
```

That is cleaner than saying SQLite is the ledger.

### Pros

```text
branch-friendly
auditable in pull requests
offline/local-first
semantic history travels with the repo
CI can rebuild and validate state
SQLite corruption is recoverable
```

### Cons

```text
requires event schema versioning
requires deterministic replay
requires semantic conflict detection on branch merges
requires event immutability rules
requires cache rebuild logic
```

For this project, those cons are acceptable because they directly support the design goals.

---

## Option B — remote service canonical

```text
Tracked:
  Markdown files
  maybe YAML category definitions

Canonical:
  hosted service ledger / database

Ignored/generated:
  local SQLite cache
```

This is valid if `mdplace` becomes a hosted or team service.

### Pros

```text
central authority
easier concurrency
easier multi-user workflow
no Git event-log merge complexity
```

### Cons

```text
repo clone is not self-contained
offline audit is weaker
CI depends on service access
branch semantics need service modeling
local filesystem and remote ledger can drift
```

This is not wrong, but it changes the product. It becomes less like a portable Markdown-native tool and more like a service with a Markdown client.

---

## Option C — SQLite canonical but not tracked

```text
Tracked:
  Markdown files
  maybe category YAML

Not tracked:
  authoritative SQLite ledger
```

This is risky.

It can be acceptable for a quick single-user prototype, but it does not satisfy the stronger portability/auditability goals.

### Pros

```text
simplest to build
fast queries
fewest moving parts
```

### Cons

```text
semantic history does not travel with repo
fresh clone cannot explain history
CI cannot reproduce trust state
hard to review semantic changes
hard to recover from DB loss
branch behavior unclear
```

For the current design vision, Option C should not be the final architecture.

---

# Recommended decision

For `mdplace`, choose:

```text
Option A:
Repo-native canonical semantic events.
SQLite is generated cache.
```

Then the canonical sources become:

```text
1. Markdown files
   content + frontmatter bridge

2. YAML/JSON definitions
   category schemes
   projection policies
   validation policies
   migration rules

3. Event files
   placement accepted/rejected/superseded
   hypotheses
   evidence records
   review decisions
   category changes
   projection applied
   aliases created

4. Applied projection manifests
   optional but useful as canonical audit artifacts
```

Generated/ignored:

```text
SQLite cache
search indexes
embedding indexes
derived accepted graph
derived hypothesis graph
derived API JSON
temporary validation reports
```

---

# How this updates the existing design

The design should now say:

```text
The semantic ledger is not necessarily SQLite.
The canonical semantic ledger is the repo-tracked event stream.
SQLite is a materialized index/cache over that event stream.
```

So replace:

```text
.kg/ledger.sqlite = semantic ledger
```

with:

```text
.kg/events/       = canonical semantic ledger
.kg/ledger.sqlite = generated query cache
```

A better layout:

```text
repo/
  notes/

  .mdplace/
    schemes/
      scheme-v1.yaml
      scheme-v2.yaml

    policies/
      projection-primary-v1.yaml
      placement-policy-v1.yaml

    migrations/
      scheme-v1-to-v2.yaml

    events/
      2026/
        04/
          evt_01JABC_file_discovered.json
          evt_01JABD_placement_accepted.json
          evt_01JABE_projection_applied.json

    projections/
      applied/
        proj-v012.json

    cache/
      ledger.sqlite        # ignored
      embeddings/          # ignored
      indexes/             # ignored
```

Using one giant JSONL file is possible, but event-per-file or date-chunked NDJSON is more Git-merge-friendly.

---

# Important implementation consequence: avoid canonical global sequence numbers

The previous SQLite schema had something like:

```sql
event_seq INTEGER UNIQUE
```

That is fine for a generated SQLite cache, but it is bad as canonical repo state.

Why?

Two Git branches can both create event sequence `101`.

Better canonical event identity:

```json
{
  "event_id": "evt_01JABD2F8MMZD5M3ZC5T",
  "schema_version": 1,
  "event_type": "PlacementAccepted",
  "aggregate_type": "file",
  "aggregate_id": "file:01JABC9Q4S0AH7E5Q2M3X6",
  "occurred_at": "2026-04-25T10:20:00+09:00",
  "actor": "user:local",
  "payload": {
    "placement_id": "place:01JABD",
    "file_id": "file:01JABC",
    "category_id": "cat:knowledge-graphs",
    "scheme_id": "scheme:v3",
    "evidence_ids": ["ev:heading-terms", "ev:backlink-neighborhood"]
  }
}
```

During replay, SQLite can assign local sequence numbers.

Canonical ordering should be deterministic but not branch-fragile. For example:

```text
sort by occurred_at, then event_id
```

or:

```text
sort by event file path, then event_id
```

For conflicting branch events, deterministic ordering is not enough. The system should detect semantic conflicts and create review tasks.

---

# New or updated requirements

Add these requirements.

## 1. Canonical-state requirement

```text
The design must declare whether canonical semantic state is repo-native,
service-backed, or local-only.
```

For `mdplace`:

```text
Canonical semantic state is repo-native.
```

## 2. Rebuildability requirement

```text
A fresh Git clone must be able to rebuild the SQLite cache and explain
semantic state from tracked repository artifacts.
```

Command:

```bash
mdplace rebuild-cache
```

should reconstruct:

```text
files
categories
placements
hypotheses
evidence
review tasks
category changes
aliases
projection history
```

## 3. Cache disposability requirement

```text
SQLite cache must be disposable.
Deleting it must not lose semantic truth.
```

## 4. Event schema/versioning requirement

```text
Every canonical event must carry schema_version.
Replay must support migrations or reject incompatible versions with a clear error.
```

## 5. Event immutability requirement

In SQLite, triggers can prevent updates. In Git, you need a different rule:

```text
Committed event files are immutable.
New semantic changes add new event files.
They do not edit old event files.
```

CI can enforce:

```text
no modification/deletion of existing event files on protected branches
```

except through a special repair process.

## 6. Branch conflict requirement

```text
Git text merge success does not imply semantic merge success.
```

After merge:

```bash
mdplace rebuild-cache
mdplace validate
```

must detect conflicts such as:

```text
two accepted primary placements for the same file under same scheme
category renamed on one branch and deleted on another
same old category mapped to different targets
projection applied from stale scheme
manual move conflicts with projection
```

## 7. Definitions source-of-truth requirement

Decide:

```text
YAML definitions are canonical.
SQLite imports them.
```

This means category scheme files and projection policies should be tracked and hashed.

SQLite should store:

```text
source_path
source_hash
loaded_at
```

so it can detect drift.

---

# How the four graph model changes under Option A

The four logical graphs still exist, but they are derived from repo-tracked events.

```text
Accepted graph
  derived from PlacementAccepted / PlacementSuperseded events

Hypothesis graph
  derived from PlacementHypothesisCreated / HypothesisResolved events

Evidence graph
  derived from EvidenceRecorded events or tracked evidence records

Review/change graph
  derived from ReviewTaskCreated, ReviewDecisionRecorded,
  CategoryChangeApplied, MigrationApplied events
```

SQLite materializes these for fast queries.

So:

```text
events = canonical history
SQLite = current indexed state
folder tree = physical projection
frontmatter = bridge
```

---

# What about projection manifests?

Projection manifests are tricky.

A projection manifest records a physical materialization:

```text
which files moved
from where
to where
under which scheme
under which projection policy
because of which placement/review state
```

For repo-native auditability, applied projection manifests should be tracked or represented as event payloads.

I recommend:

```text
Tracked:
  .mdplace/projections/applied/proj-v012.json

Ignored:
  dry-run projection manifests
  temporary validation reports
```

An applied projection is part of semantic history because it answers:

```text
Why did this file move?
What old path should resolve to it?
What projection policy created this folder tree?
```

So applied manifests should not be treated as disposable cache.

---

# What about validation reports?

Similar distinction:

```text
Dry-run validation report
  generated, can be ignored

Applied projection validation proof
  should be tracked or summarized in ProjectionApplied event
```

A `ProjectionApplied` event should include:

```json
{
  "projection_id": "proj:v12",
  "scheme_id": "scheme:v3",
  "policy_id": "policy:primary-category-folders-v1",
  "plan_hash": "sha256:...",
  "validation_id": "validation:v12",
  "validation_status": "passed",
  "manifest_path": ".mdplace/projections/applied/proj-v012.json"
}
```

---

# How this affects the previous SQLite triggers

If SQLite is only cache, then database triggers are still useful locally, but they are no longer the primary guarantee.

Earlier:

```text
events table append-only by SQLite trigger
```

Updated:

```text
canonical events are repo files
SQLite events table is a replayed cache
append-only semantics are enforced by event-file policy and CI
```

You can still keep SQLite triggers to protect the cache during command execution, but the real integrity model is:

```text
tracked event files are immutable
cache can be rebuilt
```

---

# Option A implementation model

A command like:

```bash
mdplace accept-placement place:123
```

should:

```text
1. Read current cache.
2. Validate command preconditions.
3. Write a new canonical event file.
4. Optionally update the SQLite cache immediately.
5. Update frontmatter if needed.
6. Maybe create/update projection dry-run.
```

A command like:

```bash
mdplace rebuild-cache
```

should:

```text
1. Load YAML schemes/policies/migrations.
2. Read all canonical event files.
3. Replay events deterministically.
4. Rebuild SQLite tables.
5. Validate resulting state.
```

A command like:

```bash
mdplace explain file:...
```

should work from cache, but if the cache is missing:

```text
rebuild cache first
```

or:

```text
read events directly in slower mode
```

---

# Final verdict

This is not confusion. It is the correct next design question.

The current design should be updated to say:

```text
The semantic truth of mdplace lives in repo-tracked definitions and events,
not in the generated SQLite cache.
```

For a local-first Markdown taxonomy tool, the best architecture is:

```text
Tracked canonical:
  Markdown files
  frontmatter bridge
  category schemes
  projection policies
  migrations
  semantic events
  applied projection manifests

Generated/ignored:
  SQLite cache
  search indexes
  embedding indexes
  dry-run artifacts
```

So the slogan becomes:

```text
Git clone contains the semantic truth.
SQLite makes it fast.
Folder tree makes it visible.
Frontmatter bridges files to truth.
```

That is the cleanest resolution for the current design.
