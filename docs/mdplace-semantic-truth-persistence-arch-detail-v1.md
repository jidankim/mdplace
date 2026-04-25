Yes — **it changes the design in a clarifying way**.

If the managed service is **opt-in**, then the default architecture should be:

```text
Repo-native canonical truth first.
Managed service second.
SQLite cache third.
Folder projection fourth.
```

So the design becomes simpler and safer:

```text
Git-tracked semantic events + YAML definitions = canonical truth
Managed service = optional mirror / assistant / index / collaboration layer
SQLite = local generated cache
Folder tree = generated projection
```

The managed service should not be a hidden dependency for core behavior.

# Updated principle

```text
A fresh Git clone must be enough to rebuild mdplace state unless the user
explicitly opts into a service-canonical mode.
```

So by default:

```bash
git clone repo
mdplace rebuild-cache
mdplace explain file:...
mdplace project --dry-run
```

must work without logging into any service.

That means the managed service can enhance the product, but it must not be required for semantic truth.

---

# What changes?

## 1. Option A becomes the default architecture

The default should be:

```text
Tracked / canonical:
  .mdplace/events/
  .mdplace/schemes/
  .mdplace/policies/
  .mdplace/migrations/
  .mdplace/projections/applied/

Ignored / generated:
  .mdplace/cache/ledger.sqlite
  .mdplace/cache/indexes/
  .mdplace/cache/embeddings/
```

The service is optional.

So instead of:

```text
Option A vs Option B
```

the product model becomes:

```text
Option A by default
+
optional managed service layered on top
```

---

## 2. The service should not own truth by default

In opt-in managed mode, the service can do things like:

```text
index notes
run placement suggestions
run validation
show a web review UI
sync events
open PRs
host dashboards
generate search/RAG indexes
```

But the service should not silently become the canonical semantic ledger.

The canonical state should still be:

```text
repo-tracked events + definitions
```

unless the user explicitly chooses a different authority mode.

---

# Recommended authority modes

Add this to config:

```yaml
mdplace:
  authority_mode: repo_canonical

managed_service:
  enabled: false
  mode: none
```

Supported modes:

```text
repo_canonical
  Default. Repo events are truth. Service is optional.

managed_mirror
  Service reads/indexes repo events but does not author canonical truth.

managed_assistant
  Service proposes changes, but canonical changes land as repo events,
  usually through local acceptance or PR/writeback.

service_canonical
  Advanced/enterprise mode. Service event store is truth.
  This should be explicit, not default.
```

For your stated product direction, the default should be:

```yaml
authority_mode: repo_canonical
managed_service:
  enabled: false
```

If enabled:

```yaml
authority_mode: repo_canonical
managed_service:
  enabled: true
  mode: managed_assistant
```

---

# The managed service becomes a producer of proposals, not hidden truth

In repo-canonical mode, the managed service can produce:

```text
Placement suggestions
Category split suggestions
Merge suggestions
Review tasks
Validation reports
Projection dry-runs
```

But these should become canonical only when represented as repo-tracked artifacts.

For example, the service may suggest:

```json
{
  "type": "mdplace.placement.suggested",
  "file_id": "file:01JABC",
  "candidate_category": "cat:knowledge-graphs",
  "confidence": 0.91
}
```

But canonical acceptance requires a real event in the repo:

```json
{
  "type": "mdplace.placement.accepted",
  "file_id": "file:01JABC",
  "category_id": "cat:knowledge-graphs",
  "scheme_id": "scheme:v3",
  "evidence_ids": ["ev:heading-terms", "ev:backlink-neighborhood"]
}
```

So the service can say:

```text
I recommend this.
```

The repo event says:

```text
This was accepted.
```

---

# Service writeback options

If the managed service is opt-in, it can write changes in a few safe ways.

## Option 1: PR-based writeback

Best for auditability.

```text
Service proposes changes
→ service creates event files
→ opens pull request
→ user reviews
→ merge makes events canonical
```

Good for:

```text
teams
public repositories
auditable changes
CI validation
```

## Option 2: local approval

Best for local-first workflows.

```text
Service suggests changes
→ CLI pulls suggestions
→ user runs mdplace accept
→ local repo writes canonical events
```

Good for:

```text
single-user local-first use
offline-friendly workflows
```

## Option 3: service-authorized event append

Best for managed teams, but more complex.

```text
User accepts in web UI
→ service writes canonical event
→ service pushes event to repo or syncs to client
```

This is still repo-canonical only if the event lands in the repo.

If the event stays only in the service, then the mode has effectively become `service_canonical`.

---

# What should not happen

Avoid this:

```text
The service accepts a placement,
but the repo has no event representing that acceptance.
```

Because then:

```bash
git clone repo
mdplace explain file:...
```

cannot reproduce the service’s truth.

That breaks the local-first contract.

---

# Updated requirement

Add this requirement:

```text
Managed service is optional. Core semantic state must remain reproducible
from repo-tracked artifacts in repo_canonical mode.
```

And this invariant:

```text
In repo_canonical mode, any accepted semantic fact must be represented by
a tracked event or tracked definition in the repository.
```

So accepted truth cannot live only in:

```text
SQLite
service database
temporary API response
embedding index
projection folder
frontmatter alone
```

---

# Does this change the database design?

Slightly.

SQLite remains useful, but it becomes clearly a **cache/index**, not the canonical ledger.

So this:

```text
.kg/ledger.sqlite
```

should probably become:

```text
.mdplace/cache/ledger.sqlite
```

And canonical state should live in:

```text
.mdplace/events/
.mdplace/schemes/
.mdplace/policies/
.mdplace/migrations/
.mdplace/projections/applied/
```

The SQLite tables still exist:

```text
files
placements
hypotheses
evidence
review_tasks
category_changes
aliases
projection_runs
```

But they are rebuilt from tracked artifacts.

---

# New sync metadata

If managed service is opt-in, add sync metadata, but do not mix it with semantic truth.

Example generated/cache table:

```sql
CREATE TABLE sync_remotes (
  remote_id TEXT PRIMARY KEY,
  remote_url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (
    mode IN ('mirror', 'assistant', 'service_canonical')
  ),
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

```sql
CREATE TABLE event_sync_state (
  event_id TEXT PRIMARY KEY,
  remote_id TEXT NOT NULL REFERENCES sync_remotes(remote_id),
  sync_status TEXT NOT NULL CHECK (
    sync_status IN ('not_synced', 'pushed', 'pulled', 'acked', 'conflict')
  ),
  remote_event_id TEXT,
  last_synced_at TEXT
);
```

This is operational metadata. It should not define semantic truth.

---

# New event fields

To support both local and managed modes, canonical events should include enough metadata to track origin.

Example:

```json
{
  "event_id": "evt_01JABD2F8MMZD5M3ZC5T",
  "schema_version": 1,
  "event_type": "PlacementAccepted",
  "workspace_id": "ws:my-notes",
  "aggregate_type": "file",
  "aggregate_id": "file:01JABC",
  "actor": "user:alice",
  "origin": {
    "kind": "local_cli",
    "id": "device:alice-laptop"
  },
  "occurred_at": "2026-04-25T10:20:00+09:00",
  "payload": {
    "placement_id": "place:01JABD",
    "category_id": "cat:knowledge-graphs",
    "scheme_id": "scheme:v3"
  }
}
```

If service-generated:

```json
"origin": {
  "kind": "managed_service",
  "id": "service:mdplace-cloud"
}
```

But again: in repo-canonical mode, it is canonical only once the event exists in the repo.

---

# Privacy and opt-in implications

Because the service is opt-in, the design must specify what gets uploaded.

Possible service scopes:

```yaml
managed_service:
  enabled: true
  upload:
    event_metadata: true
    category_schemes: true
    projection_manifests: true
    file_frontmatter: true
    file_content: false
    embeddings: false
```

Modes:

```text
metadata-only
  Upload events, category schemes, hashes, titles, tags.

content-enabled
  Upload Markdown content for managed search/classification.

private/self-hosted
  Same features, but service runs under user control.
```

This matters because Markdown notes may be personal or sensitive.

So opt-in service design should include:

```text
explicit data-sharing settings
event redaction policy
content upload policy
local-only fallback
```

---

# What remains unchanged?

The core semantic design does not change:

```text
Accepted graph
Hypothesis graph
Evidence graph
Review/change graph
Projection engine
Validation gate
Category mappings
Path aliases
Placement hypotheses
Missing evidence
Review tasks
```

Those are still required.

The only architectural clarification is:

```text
Where canonical state lives by default.
```

Now the answer is:

```text
In the repo.
```

The service is optional.

---

# Best final architecture

For your product, I would define it this way:

```text
mdplace is repo-native by default.

The canonical semantic state is stored as tracked definitions and events
inside the repository.

SQLite is a generated local cache.

The managed service is opt-in and may mirror, index, validate, and propose
changes, but in repo_canonical mode it does not become the source of truth.

Any service-originated accepted change must be written back as a canonical
repo event.
```

That gives you:

```text
local-first operation
self-hosting
managed-service option
auditable PR workflows
offline rebuildability
portable semantic history
```

# Final answer

Yes, opt-in managed service changes the framing.

It means you should not treat Option B as an equal default authority. You should make **Option A the canonical base architecture**, then layer the managed service on top as an optional mirror/assistant/sync service.

The key invariant becomes:

```text
In repo-canonical mode, the repo contains enough semantic data to rebuild
mdplace state without the service.
```

And the service rule becomes:

```text
The service may propose, validate, index, and sync.
It may only create accepted semantic truth by producing canonical events
that land in the repo, unless the user explicitly enables service_canonical mode.
```
