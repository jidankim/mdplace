# Normative package and contract meta-schema

This document is Normative Material for the `mdplace-spec/v1` Specification Package. The uppercase terms MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as requirement strength. Canonical mdplace terms are defined only in [`CONTEXT.md`](../../../CONTEXT.md).

The accepted decision in [issue #10](https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153) is an input to this contract. This document does not reopen that decision.

## REQ-PKG-001: Authority is explicit and one-way

Every package artifact MUST be declared exactly once as Normative Material or Informative Material. Normative Material is binding. Informative Material is never an input to a conformance decision and MUST NOT add, remove, relax, or override a normative requirement, schema, transition, fixture oracle, or acceptance gate. A contradictory informative statement has no effect because conformance is derived exclusively from Normative Material; a detected contradiction SHOULD be corrected as a documentation defect.

## REQ-PKG-002: Version identity is stable

Every package MUST declare the `mdplace-spec/v1` series, one canonical three-component SemVer release version with a nonzero major and no leading zeroes, one lifecycle state, its validator version, and a SHA-256 digest over the ordered normative artifact bindings. The package series identifies compatibility; the release version identifies exact content. A requirement identifier MUST retain its meaning for the lifetime of the series.

The ordered normative artifact binding is the UTF-8 concatenation of each normative artifact, sorted by ascending path, as `<path><NUL><lowercase-sha256><LF>`. `normative_digest` is the lowercase SHA-256 of that concatenation. The root manifest is self-declaring Normative Material and is excluded from its own artifact ledger; every other package file MUST occur in the ledger exactly once.

## REQ-PKG-003: Released content is immutable

After the `release` transition, every normative artifact, Conformance Fixture, Traceability Record, and published evidence binding MUST remain byte-for-byte addressable. A correction MUST be a Package Amendment at a strictly greater version and a new path. The source digest observed after the attempt MUST equal the released source digest. In-place mutation, downgrade, deletion, identifier reuse, and digest replacement MUST be rejected without changing the released source.

## REQ-PKG-004: Requirement identifiers are unique and permanent

Every normative requirement MUST use an uppercase stable identifier matching `REQ-<AREA>-<three digits>`. Identifiers MUST be unique within a release. A Package Amendment MUST preserve the identifier for an unchanged requirement, mark a changed requirement as amended, and allocate a new identifier for new meaning. Removed meaning remains traceable and MUST NOT be reassigned. The amendment gate MUST compare the manifest-bound source and target requirement catalogs, reject a removed source identifier, and require the observed changed- and new-identifier sets to equal the amendment receipt.

## REQ-PKG-005: Vocabulary is canonical

Every canonical term named by a requirement or Traceability Record MUST resolve exactly to a bold glossary entry in the repository root `CONTEXT.md`. A package MUST reference that glossary instead of duplicating definitions. Unknown aliases, terms listed under `_Avoid_`, and locally redefined canonical terms MUST fail validation.

## REQ-PKG-006: Structured contracts are closed

JSON and JSON-profile YAML contracts MUST identify JSON Schema Draft 2020-12, carry a stable `$id` or `schema_id`, require every semantically necessary field, and close every object with `additionalProperties: false` or `unevaluatedProperties: false`. Unknown fields MUST be rejected. Arrays that carry identifiers MUST reject duplicates. Exact bytes and digest values MUST use explicit boundary constraints.

The shared requirement, traceability, conformance, and transition meta-schemas MUST accept version-bound downstream area namespaces, scopes, suites, schema paths, transition identifiers, commands, states, categories, and authority roles without revising this foundation contract. The conformance fixture envelope provides a closed `extension` subject whose named downstream schema validates its opaque document and whose suite validator defines its observations. Package-release policy remains in the package lifecycle table and semantic checks rather than being encoded as a closed enumeration in the shared meta-schema. The candidate foundation MUST contain all eleven declared contract schemas and every bound root instance; removing a schema, instance, or binding is a conformance failure.

The reference validator MUST bound file size, artifact count, schema depth, collection size, reference traversal, regular-expression evaluation time, and reported errors. A bound violation is a deterministic non-pass result, never an unhandled exception or partial attestation.

## REQ-PKG-007: Lifecycle tables are complete

Every lifecycle transition table MUST enumerate the Cartesian product of its declared states and commands exactly once. Every row MUST declare command or event, actor authority, preconditions, base references, emitted records, filesystem effects, idempotency, terminal state, failure result, and recovery. Illegal rows are first-class denied transitions and MUST have a Conformance Fixture oracle.

## REQ-PKG-008: Traceability is stable and total

Every requirement MUST have one Traceability Record binding it to the accepted decision, canonical terms, normative prose anchor, applicable schemas or transition tables, positive and negative Conformance Fixtures, acceptance gate, scope, and evidence. Every referenced identifier and path MUST resolve, and no normative requirement MAY remain untraced.

## REQ-PKG-009: Conformance observes public effects

The conformance manifest MUST cover positive, negative, exact-boundary, stale-state, authority-denial, illegal-transition, and relevant crash/recovery behavior. Fixture oracles MUST assert observable inputs, outputs, operations, receipts, filesystem effects, and terminal states. Transition fixtures MUST identify canonical authenticated human principals and roles, delegation status, the package series and release version, fixed references to the current manifest, an artifact-bound lifecycle-state observation, artifact ledger, and `package-manifest.yaml#/normative_digest`, command-specific precondition evidence, release or amendment evidence when applicable, and idempotency status. The validator MUST independently recompute manifest and artifact bindings and compare the transition source state with that state observation for every allowed transition; a caller Boolean or assertion MUST NOT satisfy a precondition.

Release evidence MUST include a trusted local-validator receipt from a filesystem observation that enumerates every required slot, records each slot as present, binds the canonical slot-set digest, and proves the expected regular-file or directory type. It MUST also bind artifact verification and both approval receipts to that same manifest digest reference, identify an absent safely creatable immutable target, and publish the specification digest, conformance-report digest, validator version, validation report, and generated traceability report through manifest-bound references. Amendment evidence MUST identify a safe observation root, an observed released source manifest and digest, a strictly greater target version at a different absent path, and exact changed and new requirement identifier sets derived from source and target catalogs. The validator MUST reject symbolic links, non-regular artifacts, wrong slot types, unsafe path components, external targets, occupied release targets, caller-supplied match assertions, literal digest aliases, unattested slot-name lists, and unverified presence claims. Fixture oracles MUST NOT assert private helper calls, internal class shape, or unconsumed prose.

## REQ-PKG-010: Package layout is declared

The package manifest MUST declare the final release slots for `README.md`, `product.md`, `architecture.md`, `contracts/`, `operations.md`, `security-and-privacy.md`, `performance.md`, `conformance/manifest.yaml`, `conformance/fixtures/`, `conformance/scenarios/`, `conformance/benchmarks/`, `conformance/manual-acceptance.md`, `traceability.yaml`, and `claims-and-evidence.yaml`. Its candidate foundation slots MUST declare `README.md`, `normative/package-contract.md`, `normative/requirements.json`, `contracts/schemas/`, `contracts/transitions/`, `conformance/`, `traceability.yaml`, and `package-manifest.yaml`. A candidate foundation MAY leave later ticket-owned release slots unpopulated, but every required foundation schema, root instance, and binding MUST be present regardless of which paths the manifest declares. A release transition MUST fail while any required release slot is absent or has the wrong filesystem type.

## REQ-PKG-011: Release authority is non-ambiguous

A release candidate requires separate approvals from the vault owner for domain meaning, scope, and risk tolerance and from an independent technical reviewer for architecture, schemas, security, conformance coherence, and traceability. The two approvals MUST identify different canonical authenticated human principals and bind the same normative digest. Aliases for one human MUST resolve to one principal identifier before the package boundary; unresolved or unauthenticated identities MUST be denied. Release coordination cannot substitute for either approval, and ambiguous, alternative, delegated, or inferred authority MUST be denied.

## REQ-PKG-012: The package is specification-only

This ticket MAY add only the declared package-root documents, `normative/`, `contracts/`, and `conformance/` artifacts. It MAY include only the manifest-bound reference validator and conformance-test executable inventory under `conformance/`; another executable path requires a Package Amendment to the inventory. It MUST reject every undeclared top-level path and MUST NOT implement or invoke the mdplace Agent, Semantic Kernel, Control Channel, Vault Mutation Gate, Capture Adapter, Placement Evaluation, Taxonomy Evolution Cycle, or Folder Projection. Those production boundaries remain external subjects of later implementation work.

## Version and amendment rules

`mdplace-spec/v1` is the compatibility series. Exact releases use SemVer. A backward-compatible clarification or additive contract is a new minor or patch release within the v1 series; a contract that invalidates a previously conforming implementation requires a new major series. Every release is immutable. A Package Amendment names its predecessor, changed requirement identifiers, reason, approving authorities, new normative digest, and the preserved predecessor digest.

Pre-release lifecycle state is not evidence of release. Only the complete `release` transition, immutable repository tag, published specification and conformance digests, validator version, validation and traceability reports, and two distinct approvals establish a released package.

## Normative and informative boundary

The root package manifest, requirement index, schemas, transition tables, conformance manifest, fixtures, scenarios, and traceability map are Normative Material. This README, validator implementation, validator tests, and generated reports are Informative Material. The informative validator is a reference checker for the normative artifacts; another implementation may replace it only if it produces the same observable verdicts and codes.

## Closed-schema convention

All objects are closed unless a later schema defines a named extension map whose keys and values are themselves closed and version-bound. No contract may infer fields from filenames, surrounding directories, process environment, or undeclared defaults. A boundary parser rejects unknown data before lifecycle evaluation.

`ConformanceFixture.subject.document` is an opaque boundary value, not an open contract object. Its named `subject.schema` MUST validate that value before the fixture oracle is evaluated; when the value is an object, that target schema supplies the closed-object rules.

## Release gate

A release MUST fail when any normative `TBD`, `TODO`, placeholder identity, example-only threshold, unspecified owner, undefined failure result, missing schema, incomplete transition pair, ambiguous authority, duplicate identifier, unresolved traceability reference, missing required release slot, or failed mandatory fixture remains.
