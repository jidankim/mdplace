# Deterministic Reference Vault corpus contract

This document defines the specification-only Reference Vault corpus and generator boundary resolved by [issue #10](https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153). That accepted decision is an input without reopening it. The contract adds no production mdplace behavior, does not materialize the late Reference Vault, and makes no performance claim.

The public conformance boundary is the closed Scale Manifest, Corpus Manifest, Reference Vault Generator interface, generation and redistribution lifecycle tables, fixtures, receipts, recovery report, and traceability. The validator observes only declared inputs, outputs, operations, receipts, filesystem effects, terminal state, and illegal-transition status.

## REQ-RVG-001: Canonical corpus vocabulary and scope are fixed

Normative artifacts use Reference Vault, Corpus Manifest, Corpus Partition, Lineage Group, Scale Manifest, Generator Binding, Reference Vault Generator, and Corpus Redistribution exactly as defined by the canonical glossary. A corpus artifact is conformance evidence, never a production vault, implementation, or benchmark result.

## REQ-RVG-002: Corpus partitions and lineage groups are immutable

The only Corpus Partitions are `train`, `calibration`, and `test`. Every duplicate, recapture, historical-version, Same Source, and near-related case belongs to one indivisible Lineage Group, and every Lineage Group belongs to exactly one partition. Generation seals the partition membership digest. Corpus Redistribution may rebalance partition-local shards only by moving a complete Lineage Group; it cannot change train, calibration, or test membership.

The canonical compact Corpus Manifest accounts for 22,000 Lineage Groups across three non-overlapping ranges. Lineage Group count is not a fixed Reference Vault scale and does not substitute for the five fixed corpus counts.

## REQ-RVG-003: The scale manifest fixes every Reference Vault boundary

The closed Scale Manifest fixes exactly:

| Dimension | Required value |
| --- | ---: |
| Captured Tab Notes | 25,000 |
| Observed Note Versions | 100,000 |
| Active or Deprecated Categories | 1,000 |
| canonical events | 1,000,000 |
| queued Capture Candidates | 1,000 |
| normalized bytes in one queued Capture Candidate | at most 5,242,880 bytes (5 MiB) |

Deferred localized images are excluded from the candidate-size limit and from generated corpus materialization in this ticket. Below, exact, and over fixtures bind each count. Candidate-size fixtures accept below and exact values and reject an over-limit value; fixed-count fixtures accept only exact values.

## REQ-RVG-004: Seed and generator version bind deterministic output

The Generator Binding is the SHA-256 digest of the Reference Vault Generator identity, exact generator version, `sha256-counter-v1` algorithm, and public seed digest under `sorted-key-json-v1` canonicalization. The raw public seed is separately hashed and verified. Repeated generation with the identical seed and generator version must produce the identical compact Corpus Manifest bytes and digest. A duplicate seed/version registry key, a conflicting binding digest, or a stale current binding is rejected before output.

## REQ-RVG-005: Coverage accounting is total and unique

The Corpus Manifest accounts for Captured Tab Notes, Observed Note Versions, Categories, canonical events, and queued Capture Candidates exactly once. Partition-scoped dimensions equal the sum of the three partition counts; Categories use one global exact account. Missing, duplicate, under-counted, or over-counted coverage is invalid even when all other fields are schema-valid.

Counts never replace risk, boundary, transition, cohort, or failure-mode coverage. This compact manifest proves scale accounting and identity rules only; it makes no statistical representativeness claim.

## REQ-RVG-006: Redistribution preserves partition and lineage identity

The Reference Vault Generator interface contains the complete eight-row deterministic Corpus Redistribution rule table. A request binds the current sealed Corpus Manifest and Generator Binding. Only an idempotent retry or a whole-Lineage-Group move between two shards in the same Corpus Partition is permitted. Cross-partition movement, partial lineage movement, stale bases, coverage drift, and partition-membership digest changes are denied without effects.

## REQ-RVG-007: Generation redistribution and recovery lifecycles are complete

The six ordered generation rows bind the seed and version, resolve the Scale Manifest, allocate stable Lineage Groups, assign immutable Corpus Partitions, account all coverage, and seal the Corpus Manifest. The generation and redistribution lifecycle tables contain every state-command pair, including denied pairs with exact failure results, no filesystem effects, idempotency, and recovery behavior.

The four-row recovery table covers interruption before and after manifest sealing and before and after redistribution sealing. Recovery uses only digest-bound bindings, journals, manifests, and receipts; unknown or incomplete state fails closed.

## REQ-RVG-008: Boundary fixtures reject every invalid scale and identity case

The registered Reference Vault suite contains exactly 32 fixtures. It covers below, exact, and over values for all five fixed counts and the candidate-size limit; digest-identical repeated generation; legal and illegal redistribution; immutable membership; total coverage; duplicate and stale Generator Bindings; train/calibration/test lineage isolation; authority denial; illegal lifecycle transitions; and relevant crash and recovery outcomes.

Every fixture declares observable inputs, outputs, operations, receipts, filesystem effects, terminal state, and illegal-transition status. No fixture asserts a private helper call, an in-memory implementation shape, or a materialized vault.

## REQ-RVG-009: Recovery evidence is deterministic and observable

The Reference Vault recovery report binds the generator version, seed and Generator Binding digests, Scale Manifest digest, two identical generated manifest digests, complete fixture inventory, boundary matrix, lineage-isolation receipts, lifecycle-table digests, and recovery outcomes. All filesystem effects are `none`. A torn journal, unverified binding, unverified post-manifest state, or mismatched recovery decision is non-success.

## REQ-RVG-010: Traceability is complete and materialization remains deferred

Every REQ-RVG identifier links this contract, issue #10 as `input_without_reopening`, its closed schemas or lifecycle tables, positive and negative fixtures, acceptance gate, scope, validation report, traceability report, and Reference Vault recovery report. The package adds specification and conformance artifacts only. Final Reference Vault materialization, late scale runs, timings, resource measurements, and every performance claim remain deferred.
