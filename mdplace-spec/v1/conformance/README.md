# Package-foundation conformance

This conformance pack tests the public package boundary defined by issue #31. Its fixtures are Normative Material; the validator, tests, and generated reports are Informative Material.

Each fixture declares all observable dimensions even when the expected value is `none`: inputs, outputs, operations, receipts, filesystem effects, terminal state, and illegal-transition status. The validator does not inspect private helper calls or implementation structure.

Transition actors are canonical authenticated human principals, so aliases for one person share one `principal_id`. A release fixture supplies structured evidence: a trusted local-validator receipt for a filesystem-presence observation of every required slot and its canonical slot-set digest, artifact verification and two nondelegated approval receipts bound to the current package manifest's normative-digest reference, and an empty immutable target reservation. The observer resolves the series, release version, slot declaration, and digest reference from the package under validation and uses `lstat` to compare every presence claim with the safe package-relative observation root. Caller-supplied match flags, literal digest aliases, unattested slot-name lists, and false presence claims are not accepted. `release-targets/complete/` is normative fixture data that physically realizes every required slot for the positive release case.

Fixture categories are positive, negative, exact boundary, stale state, authority denial, illegal transition, and crash/recovery. The suite runs offline and deterministically from JSON-profile YAML and JSON artifacts.

The validator evaluates every package instance and fixture target against the Draft 2020-12 keywords used by the package. It also checks the closed-schema convention, complete transition matrix, canonical glossary references, artifact hashes, aggregate normative digest, total traceability, fixture registration and oracles, version/amendment evidence, and crash/recovery evidence. It emits the deterministic report on standard output and has no filesystem publication authority.

Issue #32 extends the same public CLI seam with the closed `mdplace.validator-extension/evidence/v1` registry entry. The extension validates explicit invocations, deterministic Evidence Envelopes, isolated Claim Manifests, the four-row Conformance Verdict table, the complete evidence lifecycle, and readback/recovery reports. The profile claims under `claim-manifests/` are synthetic conformance records; they do not claim product readiness.
