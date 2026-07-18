# mdplace

mdplace governs the semantic placement of Markdown notes while keeping content, semantic decisions, and physical projections distinct.

## Language

**Captured Tab Note**:
A Markdown note created from exactly one browser tab that preserves normalized readable content and source metadata. Window and browser-session associations are contextual metadata and do not determine the note's identity.
_Avoid_: Browser tab note, tab capture

**Policy-Governed Taxonomy**:
A taxonomy whose automated classification and evolution authority is bounded by explicit user policy. Every promoted change remains versioned, explainable, and reversible.
_Avoid_: Machine-governed taxonomy, human-governed taxonomy

**Capture Adapter**:
An external producer that creates Captured Tab Notes according to mdplace's ingestion contract without making semantic placement decisions. The Obsidian Web Clipper template is the first supported Capture Adapter.
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
The user's rules for which Captured Tab Notes, fields, and derived artifacts may be processed by each local or remote model provider. Remote transmission is forbidden unless the policy permits it explicitly.
_Avoid_: Privacy setting, blanket consent

**Intelligence Adapter**:
A local or remote reasoning integration that produces evidence, placement candidates, or taxonomy-change proposals under the Processing Policy. It neither owns credentials nor establishes semantic truth.
_Avoid_: Source of truth, taxonomy authority
