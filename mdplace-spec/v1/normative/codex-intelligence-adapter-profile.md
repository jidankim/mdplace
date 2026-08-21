# Codex Intelligence Adapter profile

This normative profile applies the general Intelligence Adapter protocol to a closed, specification-only Codex boundary. Its accepted decision inputs are evaluated in this order:

1. [DEC-011](https://github.com/jidankim/mdplace/issues/11#issuecomment-5118839348), which fixes the Codex-specific non-interactive invocation and evidence boundary.
2. [DEC-008](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093), which supplies the general advisory-only Intelligence Adapter protocol.

The profile identifiers, versions, destinations, bytes, and observations below are deterministic conformance fixtures. They are not observations of a live Codex installation, network service, account, model, or product capability.

## REQ-CODEX-001: Canonical Codex Intelligence Adapter vocabulary and stable identifiers are normative

The terms **Codex Intelligence Adapter**, **Intelligence Adapter**, **Processing Envelope**, **Intelligence Proposal**, **Adapter Run Receipt**, **Conformance Profile**, **Claim Manifest**, **Conformance Verdict**, **Conformance Fixture**, and **Traceability Record** have the meanings fixed in the package vocabulary. A conforming artifact MUST use the stable profile and owner identifier `codex-adapter`, the requirement identifiers `REQ-CODEX-001` through `REQ-CODEX-008`, and the fixture namespace `FIX-CODEX-PROFILE-NNN`.

The canonical profile binds the fixture-only interface `codex exec`, interface version `1.0.0`, approved CLI version `0.104.0`, framed standard input, bounded JSONL with a schema-constrained final value, and exact fixture destination `https://codex.openai.test/v1/execute`. These values MUST NOT be interpreted as claims about a currently installed or remotely operated Codex product.

## REQ-CODEX-002: The Codex boundary and lifecycle contracts are closed and complete

The profile, Codex boundary, authentication prerequisite, capability proof, network proof, scenario, proposal, denial, receipt, fixture manifest, evidence report, recovery report, isolated claim, and verdict table MUST validate against their closed schemas. Unknown fields, missing required fields, invalid enumerations, and digest mismatches MUST fail validation.

The capability-proof, network-proof, authentication-prerequisite, proposal-validation, denial, failure, and recovery transition tables MUST enumerate every state and command pair. Every pair MUST state whether it is allowed, name the exact actor authority, bind its preconditions and base references, name emitted records and postconditions, state its failure outcome, and identify its target state. Missing, ambiguous, unreachable, or unauthorized transitions MUST fail conformance.

## REQ-CODEX-003: Fixtures observe exact boundaries, denials, inert proposals, receipts, and recovery

Conformance Fixtures MUST cover positive results, exact ceilings, over-limit denials, stale evidence, authority denial, illegal transitions, crashes before and after transmission, current recovery, and stale recovery. The public observer MUST report the exact bound input digests, output disposition, operations, deterministic receipt, filesystem effects, network effects, terminal state, and illegal-transition flag.

For permitted attempts, the receipt MUST expose the exact transmitted byte count, SHA-256 digest, and destination. For a denial before transmission, the receipt and denial evidence MUST expose zero transmitted bytes, the SHA-256 digest of an empty byte string, no destination, no filesystem effects, no semantic effects, and no tool invocation. Proposal validation after transmission MUST retain the observed transmitted bytes while rejecting unsafe or malformed output.

## REQ-CODEX-004: Capability, network, authentication, destination, and Processing Envelope proof precede transmission

Before any payload byte is transmitted, the conformance observer MUST prove all of the following from explicit bound inputs:

- the documented interface is non-interactive and its exact command, subcommand, version, payload channel, and output mode match the profile;
- the opaque saved-login authentication prerequisite is current and satisfied, without observing a secret or treating authentication as proof of any other fact;
- the effective capabilities and disabled capability inventory are exact, with no model-visible tools, MCP servers, apps, plugins, skills, instruction roots, or host files;
- the network proof permits only the exact payload destination and separately identifies authentication-only destinations;
- the requested destination, transmitted field set, payload bytes, payload digest, and Processing Envelope digest match the boundary; and
- process freshness, scratch isolation, vault invisibility, unreadable ambient configuration, ceilings, and zero authority are proven.

A missing, stale, ambiguous, unsupported, inconclusive, mismatched, excessive, malformed, failed, or differently bound prerequisite MUST deny the attempt before transmission with zero transmitted bytes. Interactive-only operation, isolation failure, unapproved destination, unapproved payload, and unapproved fallback MUST have the same fail-closed result.

## REQ-CODEX-005: Codex output remains inert advice with zero tool or semantic authority

Codex output is untrusted data. A conforming observer MUST accept only a closed, schema-valid, digest-bound Intelligence Proposal that remains advisory, requests no tools, and records no semantic or filesystem effect. The Codex Intelligence Adapter has no semantic, note-placement, taxonomy, projection, filesystem, tool, command, or automation authority. It cannot append through the Semantic Kernel, invoke the Vault Mutation Gate, change a Folder Projection, execute a command, or call a tool.

Malformed or oversized output, a tool request, a command request, a secret request, an authority request, a stale binding, an isolation failure, and a fallback attempt MUST be rejected or denied. A satisfied authentication prerequisite MUST NOT establish capability, network, residency, retention, training, deletion, entitlement, or privacy claims. Every such claim remains unsupported by authentication and MUST produce a non-pass result.

## REQ-CODEX-006: One isolated claim row derives a non-elevating four-state verdict

The Codex Claim Manifest MUST contain exactly one row. Its identifier and owner MUST both be `codex-adapter`. Its verdict MUST be exactly one of `pass`, `fail`, `unsupported`, or `inconclusive`, under the precedence `fail`, `unsupported`, `inconclusive`, then `pass`.

`pass` requires every mandatory Codex artifact, proof, fixture result, receipt, and recovery result to be current, complete, digest-bound, and passing. Missing capability produces `unsupported`; indeterminate mandatory proof produces `inconclusive`; contradicted or invalid evidence produces `fail`. No verdict or dependency may elevate core, product-readiness, local-adapter, remote-adapter, placement-automation, or any other profile.

## REQ-CODEX-007: Validator assertions bind every artifact to ordered accepted decisions and machine evidence

Every Codex requirement MUST have one Traceability Record that preserves the accepted decision order `DEC-011`, then `DEC-008`; names its canonical terms and normative anchor; binds all applicable schemas and transition tables; names positive and negative fixtures; and points to machine-readable conformance and recovery evidence.

The validator MUST recompute fixture, receipt, boundary, authentication-prerequisite, capability-proof, network-proof, fixture-manifest, claim-material, invocation, envelope, and recovery digests from package bytes. It MUST validate schema instances and execute the fixtures through the public conformance observer. Absent, stale, tampered, reordered, or unbound evidence MUST prevent a passing Codex claim.

## REQ-CODEX-008: The Codex profile is specification and conformance only

This package defines no production mdplace implementation and performs no live Codex or network operation. It asserts neither availability nor behavior of an installed CLI, remote endpoint, saved login, provider, model, account, entitlement, retention policy, or privacy property. The fixture-only `.test` destinations MUST never be treated as live endpoints.

The profile MUST contain zero Capture Intake fixtures and zero stateful scenarios. Its generator and validator may read and write only Specification Package artifacts. Recovery MUST revalidate the parsed boundary, capability proof, network proof, authentication prerequisite, Processing Envelope, claim binding, and deterministic receipt without retransmission. If current bindings cannot be proven, recovery MUST remain blocked with zero new transmitted bytes.
