# Local Intelligence Adapter profile

This Normative Material packages the independently claimable Local Intelligence Adapter profile. It applies the accepted Processing Policy and Intelligence Adapter decision at [issue #8](https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093) as an input without reopening that decision. The profile extends the default-deny Intelligence Adapter proposal protocol; it does not assume Remote Intelligence Adapter behavior or Core conformance.

## REQ-LIA-001: Canonical Local Intelligence Adapter vocabulary and stable identifiers are normative

The profile uses the canonical terms Local Intelligence Adapter, Processing Policy, Intelligence Adapter, Intelligence Adapter Attempt, Processing Envelope, Intelligence Proposal, Adapter Run Receipt, Adapter Isolation Canary, Conformance Fixture, Claim Manifest, Conformance Profile, and Conformance Verdict. Every Local Intelligence Adapter requirement has one stable `REQ-LIA-*` identifier.

## REQ-LIA-002: The Local Intelligence Adapter profile closes capability and isolation evidence

`local-adapter` is local, isolated, ephemeral, advisory-only, and bound to one exact Processing Policy and the Intelligence Adapter proposal protocol. Its only capabilities are producing one schema-validated Intelligence Proposal and one schema-validated receipt. Current capability and isolation evidence is mandatory; missing, stale, malformed, unsupported, or inconclusive facts deny a passing verdict.

## REQ-LIA-003: Only validated proposal and receipt evidence may leave an attempt

An Intelligence Adapter Attempt may expose only a complete Intelligence Proposal accepted by `mdplace.intelligence-proposal/v1` and a complete Adapter Run Receipt accepted by `mdplace.adapter-run-receipt/v1`. The receipt retains every envelope, transmission, destination, capability, retention, credential-boundary, isolation, canary, budget, timing, chain-position, response, proposal, outcome, and zero-effect binding required by the inherited Intelligence Adapter protocol. Receipt isolation, effective-capability, timing, and canary fields are copied from one digest-bound, schema-validated exact attempt observation; they are never synthesized from profile status or a missing observation. Raw output, success prose, partial JSON, unknown fields, or a schema-invalid proposal remains inert and cannot be salvaged.

## REQ-LIA-004: Every undeclared authority is denied

The Local Intelligence Adapter has no semantic, note-placement, taxonomy, projection, filesystem, network, tool, credential, ambient-configuration, or automation authority. Captured prompt injection is trusted inert prose for static authoring. Embedded tool calls, secret requests, ambient configuration reads, and misleading success text produce no semantic effect, no filesystem effect, no network effect, and no tool invocation.

## REQ-LIA-005: Local execution cases are deterministic and bounded

Positive, negative, exact-boundary, stale-state, authority-denial, malformed-output, interruption, cancellation, resume, repeated interruption, hung execution, flaky execution, crash, and recovery Conformance Fixtures declare observable inputs, outputs, operations, receipts, filesystem effects, terminal state, and illegal-transition status. Cancel, resume, repeated interruption, and prompt injection are deterministic static-authoring cases. Hung and flaky execution are bounded deterministic local cases.

## REQ-LIA-006: Capability, isolation, verdict, failure, and recovery transitions are complete

Each lifecycle table contains exactly one row for every declared state and command pair, and every declared state is reachable from the table's initial state through permitted rows. Denied rows preserve state, emit deterministic denial evidence, perform no filesystem effect, and never infer a private implementation state.

## REQ-LIA-007: The independent claim row binds one exact evidence digest

The Local Intelligence Adapter Claim Manifest contains exactly one row with `id: local-adapter` and `owner: local-adapter`. Its only verdicts are pass, fail, unsupported, or inconclusive. The row binds an exact ordered evidence digest covering the profile, capability evidence, isolation evidence, Local Intelligence Adapter fixture manifest, every Local Intelligence Adapter fixture, machine evidence, and every Adapter Run Receipt.

## REQ-LIA-008: Recovery revalidates parsed evidence before reading a verdict

Recovery receives a closed recovery-report record outside the recursively covered fixture material. That record supplies the exact target attempt identity, sequence, compatible crash boundary, Claim Manifest SHA-256, and claim-row evidence digest. Recovery parses and schema-validates capability evidence, isolation evidence, the fixture manifest, machine evidence, and the Claim Manifest, recomputes every bound digest, and revalidates the target attempt plus both supplied digests before reading the verdict. Either supplied digest being absent is a mismatch. Claim-digest failure does not skip independent evidence parsing, and a stale, malformed, absent, unsupported, inconclusive, attempt-mismatched, or digest-mismatched input remains non-pass.

## REQ-LIA-009: Traceability preserves the accepted decision input

Every Local Intelligence Adapter requirement traces to decision `DEC-008`, the accepted issue #8 resolution, plus its normative anchors, schemas or transition tables, positive and negative fixtures, acceptance gate, scope, and machine-readable evidence.

## REQ-LIA-010: The profile is specification and conformance only

This profile adds no production mdplace code, executes no model, opens no network connection, invokes no tool, mutates no filesystem or vault, and establishes no semantic truth. Missing or inconclusive Local Intelligence Adapter evidence cannot elevate Core, product readiness, Remote Intelligence Adapter, Codex Intelligence Adapter, or Placement Automation claims.
