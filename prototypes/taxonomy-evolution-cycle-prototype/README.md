# PROTOTYPE: Taxonomy bootstrap and evolution cycle

This is throwaway decision-support code for
[Design taxonomy bootstrap and Taxonomy Evolution Cycle behavior](https://github.com/jidankim/mdplace/issues/5).
It is not an mdplace implementation and writes no files or semantic state.

## Question

Does this state model make zero-taxonomy bootstrap and recurring taxonomy
evolution feel safe and understandable? In particular, should bootstrap require
one human-approved seed revision, should recurring discovery remain a shadow
concept layer until evidence recurs, and should automatic promotion remain
limited to a new leaf under an already accepted parent while leaving every note
placement unchanged?

The model intentionally keeps Pinterest-style dynamic micro-topics and
Alibaba-style discovered concepts as bounded analogies only. In this prototype
they are non-authoritative `shadow concepts`, distinct from the accepted
Category Tree.

## Validated verdict

Accepted with the user on 2026-08-02:

- Taxonomy Revision 0 contains only the stable, non-placeable system root.
- The bootstrap cycle may cluster a frozen corpus and propose top-level seed
  categories, names, parents, alternatives, examples, counterexamples, and
  impact, but the complete seed Change Set requires explicit human approval.
- The system root is never an Automation Grant scope in v1. Initial top-level
  categories therefore cannot be promoted automatically.
- After the human accepts Taxonomy Revision 1, an explicit Automation Grant may
  permit recurring, evidence-gated leaves beneath named accepted non-root
  parents. Promotion never places the supporting notes automatically.
- New-leaf and alias promotion require separate operation-type Automation
  Grants. Suspending one grant never authorizes or suspends the other.
- An ambiguous parent, collision, stale evidence, rejected-evidence cooldown,
  circuit breaker, or missing grant makes the proposal review-only.
- A pending proposal must be approved, rejected, or promoted before another
  cycle can advance or another proposal can replace it. Accepted state and its
  correction observation are tracked separately from the current proposal, so
  an Active leaf is not rediscovered and an automatically promoted leaf remains
  available for explicit correction.
- The runnable surface keeps an append-only in-memory transition ledger with
  stable accepted-change identifiers, grant and observation-window attribution,
  proposal dispositions, and reversal or compensation links. Later actions may
  change the current view but cannot erase earlier prototype evidence.
- A collision-free alias may use the same narrow automatic path only when its
  target is already an accepted Active category. Rename, reparent, merge,
  split, and deprecate operations remain human-gated.

## Run

```sh
bash prototypes/taxonomy-evolution-cycle-prototype/prototype.sh
```

The prototype is in memory only. It has no dependencies beyond Bash.

## Suggested walkthroughs

### 1. Zero-taxonomy bootstrap

Press `c`, `b`, `a`.

- A cycle cannot invent an accepted tree from revision zero.
- Bootstrap drafts a root plus seed branches from a frozen evidence snapshot.
- Only explicit human approval creates taxonomy revision 1.

### 2. Recurring low-impact discovery

Press `g`, `c`, `c`, `p` after bootstrap.

- The first cycle records a shadow concept only.
- A second cycle seven days later makes the same normalized label and parent
  eligible under the conservative evidence gate.
- An explicit subtree grant permits automatic promotion of that leaf.
- Promotion changes the taxonomy revision but leaves all five notes Unresolved;
  Placement Evaluation remains separate.

### 3. Structural safety gate

Press `m`, then `p`.

- A merge proposal includes impact and an intended inverse but cannot use the
  automatic-promotion path.
- Press `a` only if you want to simulate a human accepting that structural
  Change Set.

The same hard gate applies to split, reparent, and deprecate proposals through
`s`, `r`, and `d`.

### 4. Naming, nesting, and aliases

After two cycles, press `y` to make the candidate-parent evidence ambiguous.
The same recurring concept becomes human-gated even with an active grant. Press
`y` again to restore a clear parent-fit margin.

After promoting the sample leaf, press `k`, then `l` to surface a
collision-free alias proposal under its separate alias Automation Grant. With
two completed cycles, `p` may add the alias automatically. The screen keeps
label evidence, target identity, parent alternative, affected accepted notes,
projected moves, and impact separate.

### 5. Churn and feedback protection

After an automatic leaf promotion, press `x`.

- The prototype records a human correction, appends a dependency-safe forward
  reversal or compensating Change Set, and starts a 30-day rediscovery
  cooldown. A dependent accepted alias is retired by compensation; a pending
  proposal must be disposed before the correction can advance. Corrections
  outside the promotion observation window do not count against the grant.
- Generated labels, proposal outputs, and automatically placed notes never feed
  the proposal's own evidence. Only reviewed placements may become positive
  exemplars.
- A second correction inside the observation window suspends the scoped
  new-leaf grant;
  the simplified prototype exposes the counter even though it does not model a
  second proposal family in detail.

## Decision contract represented by the prototype

1. Taxonomy revision 0 contains only a stable, non-placeable system root.
   Bootstrap clusters a frozen corpus into shadow concepts, proposes names and
   parents with examples and counterexamples, and emits one human-gated seed
   Change Set. No bootstrap output is semantic truth before approval.
2. Every recurring Taxonomy Evolution Cycle binds one corpus snapshot,
   Taxonomy Revision, Processing Policy, evaluator contract, and evidence
   window. Outputs from the same cycle cannot become its inputs.
3. Accepted human placements may be positive exemplars. Automatically accepted
   placements are excluded until independently reviewed. Rejections are
   version-bound negative evidence, not timeless global bans. `No Fitting
   Category` evidence may support discovery; ambiguity and conflict do not by
   themselves prove a missing category.
4. Discovery first creates a shadow concept with a normalized label, candidate
   parent, cohesion/separation evidence, examples, counterexamples, source
   diversity, recurrence history, and collision checks. A shadow concept has no
   placement or Folder Projection authority.
5. A new leaf or collision-free alias may become automatically promotable only
   under its own operation-type Automation Grant, evidence gate, Promotion
   Floor, observation window, and circuit breaker. Root/interior creation and
   rename, reparent, merge, split, and deprecate remain human-gated.
6. Hysteresis prevents churn: frozen inputs, multi-cycle recurrence, minimum
   elapsed time, source diversity, rejected-evidence cooldown, and an
   observation window all apply. Automatic promotion never places the notes
   whose evidence supported the taxonomy proposal.
7. Every proposal surfaces operation type, stable category identities,
   evidence and counterevidence, parent alternatives, affected accepted notes,
   projected moves, impact, grant/gate results, and intended inverse. Rejected,
   stale, superseded, reversed, and compensating decisions remain append-only.
   The prototype demonstrates that invariant in process memory; it does not
   define the production ledger schema or storage format.

## What this prototype does not decide

- Numeric model weights, clustering algorithms, or embedding models.
- Validation-corpus thresholds beyond the already accepted conservative
  authority defaults and floors.
- The final CLI review presentation or Folder Projection mechanics.
- Production schemas, storage, or process packaging.
- A durable regression suite or decomposed production reducer. The prototype
  deliberately keeps its state schema and transitions in one disposable,
  inspectable Bash surface; verification uses temporary reducer assertions and
  real terminal walkthroughs, and that test machinery is removed afterward.
