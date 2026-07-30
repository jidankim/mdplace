# mdplace

mdplace governs how browser tabs become durable Markdown notes and how those notes are placed in an evolving, policy-governed taxonomy.

## Status

mdplace is in specification mode. It has no production implementation yet.

The active destination is [Issue #1: Specify Captured Tab Note ingestion and policy-governed taxonomy for mdplace](https://github.com/jidankim/mdplace/issues/1). The work resolves product and architecture decisions; it does not ship code.

## Product boundary

mdplace is a single-user, single-vault desktop knowledge-capture system.

- One successful capture from one browser tab produces one untrusted **Capture Candidate**. It becomes a **Captured Tab Note** only after mdplace validates and promotes it.
- Stock Obsidian Web Clipper 1.7.0 is the first **Capture Source**. It writes into protected Capture Intake and never creates a Captured Tab Note directly.
- mdplace is editor-agnostic. It does not require a custom Obsidian plugin or browser extension.
- The mdplace **Capture Adapter** validates, sanitizes, normalizes, hashes, and promotes a conforming candidate into the Inbox without making semantic-placement decisions.

## Semantic model

mdplace separates three authorities:

- Markdown body and source metadata are the note's content and capture record.
- Versioned accepted semantic decisions are the source of placement truth; evidence supports those decisions but cannot establish semantic truth on its own.
- Folder paths and managed frontmatter are reversible projections for navigation and interoperability.

The **Category Tree** is a strict primary hierarchy: each non-root category has one parent, and a Captured Tab Note has at most one accepted primary category. Tags, projects, workflow status, collections, and relationships are separate secondary facets.

A note that cannot be placed safely remains in the **Inbox** with an **Unresolved Placement** and a reason such as insufficient, ambiguous, or conflicting evidence. `Unknown`, `Miscellaneous`, and `Uncategorized` are workflow labels, never semantic categories.

## Governance and safety

Placement Evaluation decides whether one note can be placed in the current Category Tree. The separate Taxonomy Evolution Cycle evaluates accumulated evidence for changes to that tree.

All processing is local by default. A **Processing Policy** must explicitly permit any remote Intelligence Adapter, including its provider, purpose, and exact fields transmitted. A locally authenticated Codex installation may be explored as an optional Intelligence Adapter, but it cannot become semantic authority or act outside that policy.

Taxonomy changes remain versioned, explainable, reviewable, and reversible. High-impact or destructive changes require stronger policy gates.

## Read next

- [Project language and boundaries](CONTEXT.md)
- [Captured Tab Note intake contract](docs/captured-tab-note-intake-contract-v1.md)
- [Issue #1: destination and open decisions](https://github.com/jidankim/mdplace/issues/1)
- [Issue #2: reconcile the existing semantic ledger](https://github.com/jidankim/mdplace/issues/2)
- [Issue #12: Captured Tab Note and Web Clipper contract](https://github.com/jidankim/mdplace/issues/12)

Files intentionally kept local are ignored by explicit paths; committed project documents remain repository evidence.

## Out of scope

- Production implementation during the current Wayfinder effort
- Multi-user collaboration, hosted synchronization, and shared organizational taxonomies
- Mobile automation
- A custom browser extension or custom Obsidian plugin
- First-party Capture Adapters for non-web sources
