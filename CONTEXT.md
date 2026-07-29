# mdplace

mdplace governs the semantic placement of Markdown notes while keeping content, semantic decisions, and physical projections distinct.

## Language

**Captured Tab Note**:
A Markdown note created from exactly one browser tab that preserves normalized readable content and allowlisted source metadata. Captured content and metadata are untrusted data; embedded instructions have no authority. Window and browser-session associations are contextual metadata and do not determine the note's identity.
_Avoid_: Browser tab note, tab capture

**Policy-Governed Taxonomy**:
A taxonomy whose automated classification and evolution authority is bounded by explicit user policy. Every promoted change remains versioned, explainable, and reversible.
_Avoid_: Machine-governed taxonomy, human-governed taxonomy

**Capture Adapter**:
An external producer that creates Captured Tab Notes according to mdplace's ingestion contract without making semantic placement decisions. Stock Obsidian Web Clipper 1.7.0 is the first evaluated Capture Adapter candidate and is not supported until an additional adapter or upstream change satisfies the ingestion contract.
_Avoid_: Importer, semantic classifier

**Category Tree**:
The strict primary hierarchy in which each non-root category has exactly one parent. A Captured Tab Note may have one accepted primary category in this tree.
_Avoid_: Folder tree, tag hierarchy

**Folder Projection**:
The nested directory structure generated from the Category Tree for ordinary filesystem and Obsidian navigation. It represents accepted placement but is not semantic truth.
_Avoid_: Taxonomy, source of truth

**Unresolved Placement**:
A decision state indicating that no primary category can yet be accepted safely, together with the reason and candidate categories when available. It is not a category in the Category Tree.
_Avoid_: Unknown category, Uncategorized category, Miscellaneous

**Inbox**:
The operational holding area for Captured Tab Notes that do not yet have an accepted primary category. Its location represents workflow state rather than semantic meaning.
_Avoid_: Unknown folder, taxonomy root

**Placement Evaluation**:
The evaluation of one Captured Tab Note against the active Category Tree, resulting in an accepted primary category or an Unresolved Placement. It does not change the Category Tree.
_Avoid_: Taxonomy update, folder move

**Taxonomy Evolution Cycle**:
A separately triggered evaluation of accumulated corpus evidence for changes to the Category Tree. It may propose or promote changes according to the Policy-Governed Taxonomy rules.
_Avoid_: Placement evaluation, per-note classification

**Processing Policy**:
The user's versioned, default-deny rules for which Captured Tab Notes, fields, and derived artifacts may be persisted or processed by each local or remote model provider and which taxonomy automation is authorized. It may tighten or disable Automatic Promotion and define its Policy Thresholds, but cannot relax a Safety Invariant. Before persistence or transmission, source URLs are canonicalized and credentials, fragments, sensitive query parameters, session identifiers, and PII are removed unless an explicit field-level rule permits protected local retention. Remote transmission is forbidden unless the policy permits the provider, purpose, and exact payload fields explicitly.
_Avoid_: Privacy setting, blanket consent

**Intelligence Adapter**:
A local or remote reasoning integration that produces evidence, placement candidates, or taxonomy-change proposals under the Processing Policy. It treats Captured Tab Notes only as untrusted data, has no tool or credential access by default, and returns schema-constrained outputs. It neither establishes semantic truth nor causes external effects without separate explicit authorization.
_Avoid_: Source of truth, taxonomy authority

**Taxonomy Proposal**:
A provenance-bearing, non-authoritative candidate for any change to the accepted taxonomy. It has no semantic or projection effect until promoted.
_Avoid_: Pending truth, automatic fact

**Automatic Promotion**:
Acceptance of a Taxonomy Proposal without contemporaneous human confirmation. It is permitted only when an enabled Automation Grant covers the proposal's operation type and named category scope, the proposal is an Auto-Promotable Taxonomy Change, and it satisfies the applicable evidence gate, Promotion Floor, and Policy Thresholds.
_Avoid_: Silent mutation, automatic rewrite

**Auto-Promotable Taxonomy Change**:
A Taxonomy Proposal limited to creating a new leaf beneath an existing active parent or adding a collision-free non-canonical alias to an existing category. It cannot alter accepted categories, relationships, placements, or projections.
_Avoid_: Safe change, minor structural change

**Human-Gated Taxonomy Change**:
A Taxonomy Proposal that alters existing accepted meaning or projected paths and therefore requires explicit human confirmation before promotion. Rename, reparent, merge, split, deprecate, and delete operations are human-gated.
_Avoid_: Automatic structural change

**Safety Invariant**:
A non-configurable boundary that Automatic Promotion may never cross. It prevents automatic changes to accepted category identity, parentage, or meaning; accepted note placement; and destructive filesystem state.
_Avoid_: Default threshold, recommended setting

**Automation Grant**:
An explicit Processing Policy permission for one Auto-Promotable Taxonomy Change type within named category scopes. It is disabled by default, is not implicitly inherited by newly created categories, and may be revoked so pending proposals become review-only.
_Avoid_: Global AI permission, implicit consent

**Promotion Observation Window**:
The bounded period after Automatic Promotion during which corrections and invariant failures are attributed to the governing Automation Grant for safety monitoring.
_Avoid_: Provisional truth, temporary category

**Automation Circuit Breaker**:
The scoped suspension of an Automation Grant after its observed corrections cross a safety threshold. Pending proposals become review-only until a human explicitly re-enables the grant.
_Avoid_: Global automation shutdown, automatic rollback

**Policy Threshold**:
A configurable numeric eligibility condition within the Safety Invariants, such as evidence diversity, observation period, confidence, ambiguity, or maximum affected unresolved notes.
_Avoid_: Safety guarantee, invariant

**Promotion Floor**:
The non-configurable minimum evidence below which a Taxonomy Proposal cannot be automatically promoted. A proposal below the floor may still be explicitly approved by a human.
_Avoid_: Default threshold, recommendation

**New-Leaf Evidence Gate**:
The recurring, cross-source evidence required before an authorized Taxonomy Proposal may automatically create a leaf category. It establishes taxonomy stability only; note placement remains a separate decision.
_Avoid_: Placement confidence, category suggestion

**Category Alias**:
A collision-free, non-canonical label that resolves unambiguously to one active category without changing that category's identity, canonical name, parentage, or projected path.
_Avoid_: Rename, duplicate category

**Alias Evidence Gate**:
The recurring, cross-source evidence required before an authorized Taxonomy Proposal may automatically add a Category Alias. Generic, polysemous, or context-dependent labels remain human-gated.
_Avoid_: Name similarity, occurrence count

**Taxonomy Change Impact**:
The low, medium, or high classification of a Taxonomy Proposal based on semantic scope, affected accepted categories and placements, and projected filesystem effects. It determines review strength and cannot make an otherwise human-gated change automatic.
_Avoid_: Confidence, model risk

**Taxonomy Change Set**:
An immutable accepted bundle of taxonomy operations with its base revision, evidence, actor, Processing Policy version, impact report, and intended inverse.
_Avoid_: Taxonomy patch file, mutable transaction

**Taxonomy Revision**:
The monotonic accepted-ledger position produced by a Taxonomy Change Set through a single-writer, atomic compare-and-append against the current revision; a mismatched base revision cannot be accepted. It identifies semantic truth independently of whether Folder Projection has finished materializing it.
_Avoid_: Folder version, export version

**Materialized Taxonomy Revision**:
The latest Taxonomy Revision whose validated Folder Projection has fully reached a terminal applied state. It may lag the accepted Taxonomy Revision.
_Avoid_: Current taxonomy, accepted revision

**Taxonomy Supersession**:
A forward correction that appends a Taxonomy Change Set naming the exact earlier effects it replaces while preserving unrelated effects and all historical category identities.
_Avoid_: Edit history, replace event

**Taxonomy Reversal**:
An append-only Taxonomy Change Set that applies the still-valid inverse of explicitly named earlier effects and produces a new Taxonomy Revision.
_Avoid_: Rewind, delete event, restore snapshot

**Compensating Taxonomy Change**:
A forward Taxonomy Change Set used when dependencies make an exact Taxonomy Reversal invalid. It restores the intended outcome without claiming history was undone.
_Avoid_: Partial rollback, forced inverse

**Stale Taxonomy Proposal**:
An immutable Taxonomy Proposal whose base revision is no longer current. It cannot be accepted directly and must be re-evaluated or returned to human review.
_Avoid_: Rebased proposal, delayed proposal

**Projection Recovery**:
Restart reconciliation for a nonterminal projection operation using its accepted revision, validated plan, policy, manifests, file identities, and hashes. Matching state may resume idempotently; drift becomes a Semantic Conflict.
_Avoid_: Retry, best-effort continuation

**Semantic Conflict**:
A durable unresolved contradiction involving accepted semantic truth, operation preconditions, projection state, or external vault state. It blocks affected transitions rather than allowing the system to guess or overwrite.
_Avoid_: Warning, transient error

**Accepted Taxonomy State**:
The current authoritative taxonomy derived from append-only promotion, supersession, and reversal decisions. It is projected rather than silently overwritten.
_Avoid_: Current taxonomy file
