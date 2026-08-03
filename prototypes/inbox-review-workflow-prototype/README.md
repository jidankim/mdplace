# PROTOTYPE: Inbox review and correction workflow

This is throwaway decision-support code for
[Design Inbox review and correction without an Obsidian plugin](https://github.com/jidankim/mdplace/issues/13).
It is not an mdplace implementation. It keeps semantic state in memory and
writes only a disposable `PROTOTYPE-VAULT` containing generated Markdown read
models and one sample note.

## Question

Does a generated, read-only Markdown Review Sheet plus version-bound CLI
commands make placement and taxonomy review safe and understandable without a
custom Obsidian plugin?

The prototype tests four boundaries:

1. Evidence, scores, diagnostics, accepted semantic state, and projected paths
   stay visibly separate in ordinary Markdown.
2. Editing a Review Sheet never acts as a command; regeneration overwrites the
   edit, while only an explicit CLI-shaped command appends a Review Decision or
   accepted semantic event.
3. Placement commands bind the exact note, taxonomy, and current Placement
   Outcome so stale reviewers cannot overwrite one another. User Deferred can
   be left only by an explicit resume command.
4. A high-impact taxonomy change requires current validation, staged approval,
   and a separate version-bound final confirmation. Folder Projection remains
   a later operation.

## Candidate answer

- Generate disposable Review Sheets under `_mdplace/Reviews/` and make the
  directory visible in the vault. Each sheet links to its subject and carries a
  conspicuous `GENERATED READ MODEL — EDITS ARE IGNORED` warning.
- Show evidence and candidates as non-authoritative, then show accepted
  semantic state and projection previews in separate sections.
- Offer only commands valid for the sheet's current state. Every mutating
  placement command binds a review identity and current Placement Outcome
  token; evidence-dependent commands additionally bind the exact Observed Note
  Version and Taxonomy Revision.
- Require an explicit human rationale for accept, override, defer, no-fit,
  retract, approval, and rejection actions. User Deferred exposes only resume;
  it cannot be bypassed by acceptance or automatic input changes.
- Keep blocked commands and view navigation in command feedback rather than the
  accepted-history and review-record ledger.
- For high-impact taxonomy changes, expose the full semantic diff, impact,
  projection preview, and intended inverse. Validation enables staged approval;
  staged approval emits a revision-bound challenge; only a separate confirm
  command consumes it and appends the Taxonomy Change Set.
- Review decisions can request Folder Projection but never move a file. The
  accepted semantic revision remains authoritative while projection is pending.

This answer remains a candidate until a human has driven the walkthroughs and
confirmed that the workflow is understandable.

## Run

```sh
bash prototypes/inbox-review-workflow-prototype/prototype.sh
```

Open the printed `PROTOTYPE-VAULT` directory as an Obsidian vault or inspect it
in any Markdown editor. The two generated surfaces are:

- `_mdplace/Reviews/placement-review-42.md`
- `_mdplace/Reviews/taxonomy-reparent-17.md`

Copy one currently offered labeled command block from either sheet and paste it
into the waiting prototype terminal. Each action has its own copyable block; the
terminal accepts its multiline shell continuations as one command. The state and
both sheets regenerate after every command. Enter `q` to quit. Starting the
prototype again resets semantic state; the generated vault remains available
for inspection.

## Suggested walkthroughs

### 1. Prove the sheet is a read model

Edit either generated sheet in the editor, then paste `mdplace review show
placement` or another offered command into the terminal. The edit disappears
on regeneration and no semantic record is appended merely because the file was
edited or shown.

### 2. Defer, drift, and explicitly resume

From the placement sheet, paste the offered defer command, then run:

```console
mdplace prototype note-drift
```

User Deferred remains current and the regenerated sheet offers only resume.
Paste resume, then evaluate, then accept. A manually crafted accept command
while deferred is blocked, and blocked attempts do not enter accepted history.

### 3. Accept and safely correct placement

Paste accept, then use the regenerated sheet to override to the displayed
alternative. The override binds the current `outcome-vN` token. Reusing the old
command after another decision is blocked, preventing a lost update. Retraction
returns the note to Awaiting Evaluation and requests an Inbox projection without
moving the sample file.

### 4. Confirm no fitting category

On a fresh run, paste the offered no-fit command. The note remains in the Inbox
with No Fitting Category. The reviewed evidence becomes available to a later
Taxonomy Evolution Cycle, but no category is created.

### 5. Approve a high-impact taxonomy change

From the taxonomy sheet, paste validate and then staged approval. Before using
the generated final-confirmation challenge, run:

```console
mdplace prototype taxonomy-drift
```

The proposal and challenge become stale. Re-evaluate, validate, approve, and
finally confirm using only commands from each regenerated sheet. Acceptance
increments the Taxonomy Revision and requests, but does not apply, Folder
Projection.

## What this prototype does not decide

- Exact production event, schema, identifier, command, or directory names.
- Folder Projection planning, application, rollback, or recovery mechanics;
  those belong to
  [Specify Folder Projection and taxonomy-change materialization](https://github.com/jidankim/mdplace/issues/7).
- Numeric Placement Policy thresholds or the final validation corpus.
- Editor launch integration, shell completion, or a future graphical client.
- Production persistence and multi-process concurrency. The prototype makes the
  compare-and-append tokens visible and exercises stale transitions in one
  process.
