# mdplace

mdplace governs the semantic placement of Markdown notes while keeping content, semantic decisions, and physical projections distinct.

## Language

**mdplace Agent**:
The persistent local authority for one vault that coordinates capture processing, semantic decisions, derived views, and authorized filesystem materialization.
_Avoid_: daemon, service, worker

**Work Journal**:
The protected, durable, non-semantic record of accepted Work Items, queue ownership, Work Leases, budgets, retries, cancellation, resumability, operational receipts, and recovery decisions for one vault. Its state may schedule or recover work but never establishes semantic truth.
_Avoid_: Semantic ledger, in-memory queue, source of truth

**Scheduler**:
The logical mdplace Agent component that selects eligible Work Items from the Work Journal under versioned dependency, concurrency, lease, retry, and resource budgets. It cannot accept placement, change taxonomy, append semantic operations, or authorize vault mutation.
_Avoid_: Worker service, semantic orchestrator, message broker

**Work Item**:
A stable, versioned unit of operational intent recorded in the Work Journal with exact input bindings, dependencies, idempotency material, bounded budgets, and one durable lifecycle state. It carries no semantic authority.
_Avoid_: Job truth, queue message, semantic operation

**Work Lease**:
A bounded, version-bound ownership receipt granting one mdplace Agent instance exclusive permission to execute one Work Item until acknowledgement, cancellation, expiry, or recovery. A Work Lease never grants semantic or filesystem authority.
_Avoid_: Permanent ownership, semantic lock, advisory claim

**Exclusive Writer Lock**:
The per-vault operating-system lock that permits exactly one background or foreground mdplace Agent core to become ready and coordinate canonical or physical writers. Holding it is necessary for readiness but does not itself authorize a semantic append or vault mutation.
_Avoid_: Semantic authority, distributed lock, second writer

**Readiness Gate**:
A fail-closed startup or wake integrity check whose durable result states whether the mdplace Agent may accept work. The six ordered gates are the Exclusive Writer Lock, vault and filesystem profile, canonical Semantic Kernel state, executable and schema compatibility, derived-view recovery, and Work Journal reconciliation. After all six pass, the Agent atomically promotes its authenticated diagnostic-only Control Channel to work-admitting mode.
_Avoid_: Liveness probe, optimistic startup, warning-only check

**Control Command**:
A bounded, versioned, same-user request sent by a Control Client over the Control Channel and bound to one vault, idempotency key, exact base references, and authenticated peer. Transport authentication admits the request only; the owning authority revalidates every requested effect.
_Avoid_: Network request, privileged socket message, semantic operation

**Child Work Invocation**:
One fresh, capability-restricted Intelligence Adapter process launched for a single Work Item with an exact Processing Envelope, schema, scratch boundary, credential reference, endpoint allowlist, and resource budget. It produces only non-authoritative output and is destroyed after the invocation.
_Avoid_: Persistent adapter, plugin service, semantic worker

**Work Recovery**:
Default-deny reconciliation of interrupted operational work from exact Work Journal versions, Work Leases, receipts, budgets, filesystem observations, and canonical dependency references. Unknown completion is blocked or escalated rather than retried blindly.
_Avoid_: Best-effort retry, state guess, semantic replay

**Semantic Kernel**:
The sole authority that validates commands and appends canonical semantic operations for a vault, whether hosted by the background mdplace Agent or foreground recovery mode.
_Avoid_: direct ledger writer, database writer

**Control Channel**:
The same-user, per-vault, operating-system-local path through which a Control Client sends commands to the mdplace Agent. Its diagnostic-only mode exposes authenticated status and doctor results while accepting no work; work-affecting commands require work-admitting mode after readiness.
_Avoid_: network API, loopback service, remote control endpoint

**Vault Mutation Gate**:
The sole mdplace boundary that performs journaled, precondition-checked filesystem changes inside a vault without deciding semantic truth.
_Avoid_: semantic writer, arbitrary filesystem access

**Authorized Mutation Plan**:
A closed, immutable instruction accepted by the Vault Mutation Gate for exactly one declared Capture Promotion or Folder Projection operation. It binds the caller, ownership, trusted-root-relative source and target, immutable inputs, expected Descriptor Identity, durability, idempotency, and recovery intent; it never establishes placement or taxonomy truth.
_Avoid_: Filesystem request, inferred plan, mutation permission

**Descriptor Identity**:
The device, inode, size, and content SHA-256 tuple captured with `fstat`, same-handle reading, and a second `fstat` through one descriptor resolved from the trusted vault root with descriptor-relative `openat` and `O_NOFOLLOW`. A pathname observation is never Descriptor Identity.
_Avoid_: Path identity, stat result, filename hash

**Operation Receipt**:
The durable Vault Mutation Gate record that echoes one Authorized Mutation Plan, its precondition Descriptor Identity, exact operation, caller, ownership, Mutation Journal, and post-operation same-descriptor readback. Console text and pathname observations are not receipts.
_Avoid_: Success message, log line, semantic operation

**Mutation Journal**:
The durable, append-only, sync-ordered record of one Authorized Mutation Plan from prepare through validation, mutation, Operation Receipt, readback, commit, and any recovery action. Its state is physical operational evidence and never semantic truth.
_Avoid_: Work Journal, semantic ledger, mutable status file

**Vault Mutation Recovery**:
Default-deny reconciliation of an interrupted Vault Mutation Gate operation from the exact Authorized Mutation Plan, Mutation Journal, Operation Receipt, Descriptor Identity, ownership, and idempotency bindings. It deterministically resumes, performs an exact safe rollback, applies explicit compensation, or halts in Terminal Manual Repair without guessing.
_Avoid_: Blind retry, best-effort cleanup, semantic rollback

**Terminal Manual Repair**:
The terminal physical-operation state used when Vault Mutation Recovery cannot prove that resume, exact rollback, or compensation is safe. It reports the unresolved evidence and forbids success until a new explicitly authorized repair plan is supplied.
_Avoid_: Warning, ignored failure, automatic success

**Capture Source**:
An external producer that writes an untrusted Capture Candidate from exactly one browser tab without making semantic decisions. Stock Obsidian Web Clipper 1.7.0 is the first Capture Source.
_Avoid_: Capture Adapter, semantic classifier

**Source Profile**:
A versioned, user-approved local declaration of which Capture Source, claimed source version, candidate schema, exact template identifier, version, import-artifact hash, URL-retention mode, Processing Policy hash, and capture-contract hash a Capture Adapter may accept. It establishes compatibility permission, not semantic authority or verified runtime provenance.
_Avoid_: Automatic trust, observed source version

**Capture Candidate**:
A protected local intake artifact produced by a Capture Source before mdplace validation. It is not a Captured Tab Note and has no placement or taxonomy authority.
_Avoid_: Raw note, temporary Captured Tab Note

**Capture Occurrence**:
One intentional act of capturing one browser tab. Separate Capture Occurrences remain distinct even when their source URL or normalized content matches; retrying the same Capture Candidate recovers the original occurrence rather than creating another.
_Avoid_: Browser session, source-page identity, duplicate note

**Targeted Recapture**:
An explicit mdplace-directed Capture Occurrence that names an existing Captured Tab Note and appends an Observed Note Version while preserving the note's identity and prior versions. It updates only capture-owned source data and managed content streams; user-owned data, accepted placement, and current path remain unchanged. Target authority comes from a trusted mdplace command, never from Capture Candidate or page-derived fields.
_Avoid_: Implicit URL merge, overwrite, duplicate suppression

**Recapture Plan**:
A human-confirmed, version-bound plan for one Targeted Recapture that binds the exact Capture Candidate, target note, expected base version, source comparison, and content-change summary. V1 cannot append a targeted version without confirmation of this plan.
_Avoid_: Automatic refresh, unattended targeted promotion

**Recapture Conflict**:
A Semantic Conflict in which a Targeted Recapture's expected base version or admitted file state no longer matches the current Captured Tab Note. It preserves the candidate and current note unchanged until a human accepts the captured version, keeps the current version, or promotes the candidate as a new Captured Tab Note.
_Avoid_: Automatic merge, overwrite, failed intake

**Recapture Source Mismatch**:
A review state in which a Recapture Plan's prospective sanitized source URL, derived by mdplace from pending Capture Candidate evidence, differs from the current Source Observation's retained sanitized URL under compatible sanitizer versions. It preserves the candidate evidence and current Source Observation and requires explicit human confirmation before append; withheld or unusable URLs are unknown, and outputs from incompatible sanitizer versions are incomparable.
_Avoid_: Source Page conflict, permanent rejection, URL identity

**Capture Intake**:
The protected, non-authoritative lifecycle in which Capture Candidates await validation or retain their processing outcome. It is distinct from the Inbox and has no placement, indexing, projection, or remote-processing authority.
_Avoid_: Inbox, staging category, unclassified notes

**Captured Tab Note**:
A Markdown note accepted by mdplace from exactly one browser tab after its Capture Candidate satisfies the ingestion contract. It preserves normalized readable content, one-tab provenance, and allowlisted source metadata when policy permits; a withheld or unusable source URL does not invalidate it.
_Avoid_: Browser tab note, tab capture, Capture Candidate

**Captured Tab Note Identity**:
The single stable file identity shared by a Captured Tab Note's `mdplace_id` bridge and semantic ledger entity, minted in the existing `file:<ULID>` namespace. It is independent of path and content; Capture Occurrences and Observed Note Versions have distinct records but never introduce a second note identity.
_Avoid_: Capture note ID, path identity, content identity

**Identity Collision**:
A blocking conflict in which multiple filesystem artifacts claim the same `mdplace_id`. mdplace never resolves it from path or content; a human chooses which artifact retains the identity and may explicitly adopt another as a new note with copy provenance.
_Avoid_: Automatic reminting, duplicate note identity

**Note Copy Adoption**:
An explicit operation that gives a copied artifact a new `mdplace_id` and records its derivation from an admitted Observed Note Version. The copy remains a Captured Tab Note only when that lineage and capture provenance validate; otherwise it may be adopted solely as a generic Markdown note.
_Avoid_: Automatic reminting, new Capture Occurrence, invented provenance

**Observed Note Version**:
A provenance-bearing snapshot of one Captured Tab Note's accepted content and allowlisted source metadata at a point in time. Each successful Capture Occurrence produces a distinct Observed Note Version even when its content and source hashes repeat; multiple versions share one note identity, and prior versions remain historical evidence.
_Avoid_: Captured Tab Note identity, current file

**Observed Version Artifact**:
An immutable, content-addressed local artifact preserving the normalized capture-owned streams and source manifest for an Observed Note Version. Identical bytes may share storage; explicit retention-policy purging preserves version hashes, provenance receipts, and tombstones.
_Avoid_: Current note, identity record, mutable backup

**Version Restoration**:
A human-confirmed, compare-and-append operation that makes content from an earlier Observed Version Artifact current by creating a new Observed Note Version. It never rewinds history or changes Captured Tab Note identity, accepted placement, or path.
_Avoid_: Version rewind, history rewrite, file rollback

**Source Observation**:
The allowlisted source metadata and normalized content evidence bound to one Observed Note Version. Only source URLs produced by compatible sanitizer versions and content hashes produced by compatible hash contracts may relate observations; matches never establish a shared Source Page identity or alter Captured Tab Note identity.
_Avoid_: Source Page identity, canonical page

**Duplicate Candidate**:
A non-authoritative proposal that two distinct Captured Tab Notes may represent redundant captured material. V1 may generate one automatically only from version-compatible exact `content_hash` equality between current Observed Note Versions; it has no merge, deletion, placement, taxonomy, or projection effect.
_Avoid_: Duplicate fact, identity match, automatic merge

**Related Capture Candidate**:
Non-authoritative evidence that distinct Source Observations may be related, such as equal retained sanitized URLs produced by compatible sanitizer versions despite different content, or a current version matching another note's historical content under compatible hash contracts. It neither proposes duplication nor establishes a Source Page identity.
_Avoid_: Duplicate Candidate, Source Page match, identity relation

**Same Source Relationship**:
A human-accepted, symmetric relationship between two exact Source Observations judged to come from the same external source. It records evidence and rationale but never merges notes, implies duplication, or establishes a Source Page identity.
_Avoid_: Source Page identity, Duplicate Relationship, note identity

**Duplicate Relationship**:
A human-accepted directional assertion from one Captured Tab Note to another chosen Canonical Note, bound to the exact Observed Note Versions, evidence, and rationale reviewed. Content hashes need not match. Self-links, cycles, and more than one current, non-stale accepted outgoing Duplicate Relationship from the same Captured Tab Note are invalid; following the sole current outgoing relationship repeatedly therefore resolves to one Canonical Note, and the relationship never merges identities or automatically deletes, archives, moves, or rewrites either note.
_Avoid_: Duplicate Candidate, identity merge, automatic cleanup

**Stale Duplicate Relationship**:
The current state of a Duplicate Relationship after either related Captured Tab Note gains a later Observed Note Version. The accepted historical decision remains recorded, but consumers must not collapse the notes until a human reconfirms or retracts the relationship.
_Avoid_: Active duplicate, automatic retraction

**Canonical Note**:
The root representative of a Captured Tab Note under current, non-stale accepted Duplicate Relationships. A note with no such outgoing relationship is its own Canonical Note; otherwise, following its sole current outgoing chain determines the Canonical Note. It remains an ordinary Captured Tab Note and does not absorb the identities, histories, or provenance of related notes.
_Avoid_: Merged note, source of shared identity

**Annotation Stream**:
Optional captured context derived from saved browser highlights whose original live-selection provenance cannot be established. It supplements but never replaces the Captured Tab Note's readable article.
_Avoid_: Selection stream, verified highlights

**Image Localization**:
A policy-authorized operation that replaces an inert remote-image reference with a locally stored asset while preserving source provenance and creating a new observed note version. It does not change Captured Tab Note identity.
_Avoid_: Automatic image download, transparent caching

**Policy-Governed Taxonomy**:
A taxonomy whose automated classification and evolution authority is bounded by explicit user policy. Every promoted change remains versioned, explainable, and reversible.
_Avoid_: Machine-governed taxonomy, human-governed taxonomy

**Capture Adapter**:
A source-specific mdplace integration that validates a Capture Candidate under the Processing Policy and either promotes it to a Captured Tab Note or records a failed intake result. It cannot make semantic placement decisions.
_Avoid_: Capture Source, importer, semantic classifier

**Category Tree**:
The strict primary hierarchy in which each non-root category has exactly one parent and the root is never placeable. Every active non-root category may be accepted as a Primary Category whether it is a leaf or an interior node; adding descendants neither invalidates nor automatically refines an existing placement.
_Avoid_: Folder tree, tag hierarchy

**Category Identity**:
The opaque stable identifier of one Category Tree category, independent of its name, parent, path, and lifecycle state. It is never reused and survives rename, reparent, deprecation, and historical mapping.
_Avoid_: Category path, category name, folder identity

**Category Name**:
The canonical label of one Category Tree category, normalized uniquely among siblings. Different branches may reuse a name, but ambiguous references require Category Identity or the full category path.
_Avoid_: Category Identity, globally unique label

**Category Lifecycle**:
The accepted state of a category, limited in v1 to Active or Deprecated. Active categories may receive new placements and appear in current Placement Candidate Sets; Deprecated categories preserve identity and existing placements for review but receive neither, merge and split deprecate their source categories through explicit mappings, categories are never deleted or reused, and reactivation requires a new accepted taxonomy change.
_Avoid_: Deletion, archival state, implicit reactivation

**Placement Outcome**:
The single current semantic outcome for a Captured Tab Note: either an accepted Primary Category or an Unresolved Placement, never both or neither. Retracting a Primary Category without a replacement produces Awaiting Evaluation by default, while only an explicit defer action produces User Deferred.
_Avoid_: Placement status, empty placement, review flag

**Primary Category**:
The single non-root Category Tree category currently accepted for a Captured Tab Note. New placements may target only Active categories; an existing placement remains accepted across bound evaluation-input changes, including later category deprecation under review, until a separate accepted placement decision supersedes or retracts it.
_Avoid_: Folder, inferred topic, category candidate

**Secondary Facet**:
A typed, multi-valued, versioned semantic assertion with stable identity and a lifecycle independent of Primary Category placement; the closed v1 kinds are Topic, Project, and Collection, each using a flat vocabulary whose values may be active, aliased, or deprecated but never have parentage. Every facet assertion, vocabulary change, or schema change is proposal-only until human confirmation in v1; facets have no Folder Projection authority, ordinary Markdown tags remain user-owned content, workflow state remains operational, and external references and other typed relationships remain separate relationship assertions.
_Avoid_: Primary Category, Markdown tag, relationship

**Folder Projection**:
The nested directory structure generated from the Category Tree for ordinary filesystem and Obsidian navigation. It represents accepted placement but is not semantic truth.
_Avoid_: Taxonomy, source of truth

**Unresolved Placement**:
A decision state indicating that no Primary Category can yet be accepted safely. It has exactly one current Unresolved Placement Reason, while retaining candidate categories and all contributing evidence and diagnostics; it is not a category in the Category Tree.
_Avoid_: Unknown category, Uncategorized category, Miscellaneous

**Unresolved Placement Reason**:
The single canonical explanation for why a Captured Tab Note currently has no accepted Primary Category, chosen from the closed v1 set Awaiting Evaluation, Insufficient Evidence, Ambiguous Candidates, Conflicting Evidence, No Fitting Category, and User Deferred. For a note without an accepted Primary Category, Awaiting Evaluation applies before the first completed current evaluation and whenever a bound evaluation-input change makes the prior evaluation stale, except that User Deferred remains current across automatic input changes until the user explicitly resumes evaluation; afterward precedence is User Deferred, Conflicting Evidence, No Fitting Category, Ambiguous Candidates, then Insufficient Evidence, while review workflow states and adapter, policy, or missing-field diagnostics remain contributing context.
_Avoid_: Category, status tag, diagnostic list

**Inbox**:
The operational holding area for Captured Tab Notes that do not yet have an accepted Primary Category. Its location represents workflow state rather than semantic meaning.
_Avoid_: Unknown folder, taxonomy root

**Placement Candidate Set**:
An immutable, non-authoritative ranked snapshot bound to one exact Observed Note Version, Taxonomy Revision, evaluator contract, and Processing Policy. At most one set is current for a note; any bound-input change makes it stale, and reevaluation creates a new set without rewriting history.
_Avoid_: Mutable suggestions, accepted placement, evergreen ranking

**Placement Evaluation**:
The evaluation of one Captured Tab Note against the active Category Tree, resulting in an accepted Primary Category or an Unresolved Placement. It does not change the Category Tree.
_Avoid_: Taxonomy update, folder move

**Placement Automation Permission**:
A versioned, default-deny Processing Policy permission allowing automatic initial placement of an Unresolved Captured Tab Note into an existing Active category within a validation-bound scope. It never changes an accepted Primary Category or the Category Tree and remains distinct from the taxonomy-specific Automation Grant.
_Avoid_: Automation Grant, automatic reclassification, global placement consent

**Taxonomy Evolution Cycle**:
A separately triggered evaluation of accumulated corpus evidence for changes to the Category Tree. It may propose or promote changes according to the Policy-Governed Taxonomy rules.
_Avoid_: Placement evaluation, per-note classification

**Processing Policy**:
The user's versioned, default-deny rules for which Capture Candidates, Captured Tab Notes, fields, and derived artifacts may be persisted or processed by each local or remote model provider and which taxonomy automation is authorized. It may tighten or disable Automatic Promotion and define its Policy Thresholds, but cannot relax a Safety Invariant. Before persistence or transmission, source URLs are canonicalized and credentials, fragments, sensitive query parameters, session identifiers, and PII are removed unless an explicit field-level rule permits protected local intake retention. Remote transmission is forbidden unless the policy permits the provider, purpose, and exact payload fields explicitly.
_Avoid_: Privacy setting, blanket consent

**Intelligence Adapter**:
A local or remote reasoning integration that produces evidence, placement candidates, or taxonomy-change proposals under the Processing Policy. It treats Captured Tab Notes only as untrusted data, has no tool or credential access by default, and returns schema-constrained outputs. It neither establishes semantic truth nor causes external effects without separate explicit authorization.
_Avoid_: Source of truth, taxonomy authority

**Processing Envelope**:
A closed, immutable, least-privilege input for one Intelligence Adapter Attempt that binds the exact approved Processing Policy and Source Profile versions, provider, purpose, destination, transmitted fields and artifacts, applied redactions, effective capabilities, retention facts, credential boundary, contract versions, and input/output/runtime/cost ceilings before any payload byte is transmitted. A remote destination uses only its bound credential-free HTTPS endpoint with a lowercase, normalization-stable, multi-label DNS-style authority outside the `localhost` namespace, a name-bearing final label, and default port; a local destination uses only its equivalently closed local endpoint and is not network egress. It contains untrusted data, never instructions or authority.
_Avoid_: Prompt, ambient context, blanket provider request

**Intelligence Adapter Attempt**:
One independently authorized, isolated, ephemeral execution of an Intelligence Adapter against exactly one Processing Envelope. Initial, retry, and fallback attempts each have distinct immutable bindings, ceilings, isolation evidence, canary evidence, and an Adapter Run Receipt.
_Avoid_: Persistent adapter session, retry loop, semantic operation

**Intelligence Proposal**:
A versioned, strictly validated, inert advisory output from an Intelligence Adapter, bound to one exact Processing Envelope and containing only the closed proposal vocabulary. Even a valid Intelligence Proposal remains non-authoritative data until a separately authorized consumer evaluates it under that consumer's own authority.
_Avoid_: Accepted placement, semantic truth, executable instruction

**Adapter Run Receipt**:
The deterministic, immutable operational record for one Intelligence Adapter Attempt, binding its Processing Envelope, exact transmission observation, destination, capabilities, retention artifacts, credential boundary, canonical observed timestamps reconciled exactly with measured runtime, provider request identifier when available, resource use, isolation and canary evidence, output artifacts, outcome, and reason. Invalid or calendar-impossible observation timestamps are rejected before an attempt observation and are never replaced with invented facts. Its reason is the earliest applicable condition in the closed global precedence, even when several failures are observed. Recovery names one exact initial, retry, or fallback attempt by identity and sequence and accepts its receipt only when a compatible crash boundary and the same closed evaluator recompute the preceding cumulative chain state, safely observed measurements, and complete target receipt. It contains no credential or secret and grants no semantic or filesystem authority.
_Avoid_: Provider log, semantic receipt, success message

**Adapter Isolation Canary**:
A deterministic pre-transmission challenge proving that one Intelligence Adapter Attempt is fresh, ephemeral, least-privilege, advisory-only, limited to its declared destination, and unable to invoke tools, read ambient configuration, acquire credentials, or access filesystem or semantic writers. Failure prevents transmission.
_Avoid_: Health check, provider ping, post-execution audit

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
A Taxonomy Proposal that alters existing accepted meaning or projected paths and therefore requires explicit human confirmation before promotion. Rename, reparent, merge, split, and deprecate operations are human-gated; category deletion is invalid in v1.
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
The scoped suspension of an Automation Grant when observed corrections attributed during its Promotion Observation Window cross the governing Policy Threshold; an observed correction is a human rejection of an Automatic Promotion recorded as a Taxonomy Reversal or, when dependencies prevent an exact inverse, a Compensating Taxonomy Change. The threshold may be tightened but not weakened, and pending proposals become review-only until a human explicitly re-enables the grant.
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
A globally unique, collision-free, non-canonical label that resolves without path context to one active category. It never changes that category's identity, canonical name, parentage, or projected path.
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
The current authoritative taxonomy derived from the accepted append-only ledger of promotion, supersession, and reversal decisions. It remains authoritative independently of the potentially lagging Folder Projection, which materializes but does not define it.
_Avoid_: Current taxonomy file

**Reference Vault**:
The bounded, deterministic conformance corpus profile fixed at 25,000 Captured Tab Notes, 100,000 Observed Note Versions, 1,000 Categories, 1,000,000 canonical events, and 1,000 queued Capture Candidates. Its late materialization and performance measurements are outside the specification package.
_Avoid_: Production vault, benchmark result, sample vault

**Corpus Manifest**:
A closed, digest-bound accounting record for one deterministic corpus generation. It binds the Generator Binding, Scale Manifest, immutable Corpus Partitions, Lineage Groups, coverage totals, and no note bodies or deferred localized images.
_Avoid_: Generated vault, mutable index, benchmark output

**Corpus Partition**:
One immutable train, calibration, or test membership set in a Corpus Manifest. Partition-local shards may be rebalanced only by moving whole Lineage Groups without changing partition membership or scale totals.
_Avoid_: Mutable split, shard, folder

**Lineage Group**:
The indivisible corpus unit that keeps duplicate, recapture, historical-version, Same Source, and near-related cases together in exactly one Corpus Partition through generation and redistribution.
_Avoid_: Note identity, source page, individual fixture

**Scale Manifest**:
The closed, digest-bound declaration of every fixed Reference Vault count and the 5 MiB Capture Candidate limit, including the explicit exclusion of deferred localized images from both that limit and this ticket's materialization.
_Avoid_: Capacity estimate, performance result, configurable profile

**Generator Binding**:
The immutable digest of one Reference Vault Generator identity, version, algorithm, and seed digest. The same binding must produce a digest-identical Corpus Manifest, while duplicate or stale bindings are invalid.
_Avoid_: Random seed, runtime configuration, mutable version label

**Reference Vault Generator**:
The specification-only deterministic interface that turns one Generator Binding and Scale Manifest into a compact Corpus Manifest and conformance receipts. It neither writes a vault nor implements production mdplace behavior.
_Avoid_: Production importer, benchmark runner, vault materializer

**Corpus Redistribution**:
A deterministic partition-local shard rebalance that moves only a whole Lineage Group, binds the current Corpus Manifest, preserves partition membership and identity, and changes no fixed coverage total.
_Avoid_: Repartitioning, cross-split move, partial-lineage copy

**Specification Package**:
An independently versioned, immutable-after-release collection of mdplace Normative Material, Informative Material, schemas, Conformance Fixtures, transition tables, traceability, and validation evidence. The `mdplace-spec/v1` series begins the contract and never contains production mdplace behavior.
_Avoid_: Implementation bundle, mutable specification folder

**Normative Material**:
Binding content in a Specification Package that defines required behavior, authority, schemas, transitions, acceptance gates, or conformance outcomes. Its authority is declared by the package manifest and cannot be weakened by Informative Material.
_Avoid_: Guidance, example, background

**Informative Material**:
Nonbinding context, rationale, examples, generated reports, or operator guidance in a Specification Package. It may explain Normative Material but cannot add, remove, or override a requirement.
_Avoid_: Optional requirement, secondary authority

**Conformance Fixture**:
A deterministic, version-bound input and observable oracle used to accept or reject a Specification Package or implementation claim without inspecting private implementation details.
_Avoid_: Unit-test mock, illustrative sample

**Traceability Record**:
A stable machine-readable binding from one normative requirement to its accepted decision source, canonical terms, schemas or transition tables, positive and negative Conformance Fixtures, acceptance gate, scope, and validation evidence.
_Avoid_: Link list, issue backlink

**Package Amendment**:
A new immutable Specification Package release that names the earlier release it changes and preserves the earlier release byte-for-byte. It never edits or replaces released requirements, fixtures, or evidence in place.
_Avoid_: Patch in place, silent correction

**Validator Extension**:
A closed, version-bound conformance adapter selected by an explicit registry identifier and subject schema. It observes declared inputs and emits an Evidence Envelope without inferring authority, versions, files, or execution context from ambient state.
_Avoid_: Plugin hook, dynamic validator, inferred checker

**Evidence Envelope**:
A deterministic, immutable record that binds one normative requirement and declared subject to one Validator Extension invocation, ordered input and output digests, ordered receipts, artifact digests, explicit execution context, and one Conformance Verdict.
_Avoid_: Test log, mutable result, inferred evidence

**Claim Manifest**:
A closed, version-bound assertion for exactly one Conformance Profile and subject that names one requirement, its mandatory or optional evidence, digest-bound Evidence Envelopes, applicability, and one Conformance Verdict.
_Avoid_: Feature checklist, aggregate status, unbound claim

**Conformance Profile**:
An isolated claim scope whose verdict depends only on the requirements and Evidence Envelopes declared for that scope. A profile never inherits pass from another profile or from overall product status.
_Avoid_: Product tier, implicit capability, inherited claim

**Conformance Verdict**:
One closed result: pass, fail, unsupported, or inconclusive. Pass requires current complete mandatory proof; fail records contradicted, invalid, or denied behavior; unsupported declares absent validator capability; inconclusive declares that available proof cannot determine the requirement.
_Avoid_: Boolean success, skipped-as-pass, unknown status
