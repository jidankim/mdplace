# mdplace-spec/v1 foundation

This directory is the candidate foundation of the `mdplace-spec/v1` Specification Package. It defines how later product, architecture, contract, operations, security, performance, conformance, traceability, and claim artifacts become binding; it does not implement mdplace.

The binding package contract is [normative/package-contract.md](normative/package-contract.md). Machine-readable requirements are indexed in [normative/requirements.json](normative/requirements.json), and every product-domain term resolves to the repository [glossary](../../CONTEXT.md).

Machine-readable `.yaml` files in this package use the JSON serialization profile of YAML 1.2. This makes their byte representation deterministic and lets the offline validator parse them without ambient YAML rules.

Run the conformance surface from the repository root:

```sh
node --test mdplace-spec/v1/conformance/validator.test.mjs
node mdplace-spec/v1/conformance/validator.mjs mdplace-spec/v1
```

The validator produces a deterministic report on standard output. Pass `--write-evidence` to replace the committed generated report after intentional package changes.

## Authority

The manifest classifies every package artifact as normative or informative. Normative artifacts are binding. Informative artifacts provide navigation, rationale, tooling, or generated evidence and cannot change a normative requirement.

The current tree is a candidate foundation, not an immutable release. A release requires the distinct approvals and release transition defined in the package lifecycle table.
