import test from 'node:test';
import {runExtensionFixture} from './validator-evidence-fixture-support.mjs';
import {schemaFor, expected, digest, extensionId, validatorVersion} from './validator-evidence-support.mjs';

test('CLI validates a claim-bound envelope before accepting its verdict', async () => {
  // Given a current Claim Manifest whose digest-bound Evidence Envelope names a stale package version.
  const envelopePath = 'conformance/evidence/envelopes/stale-claim-proof.json';
  const envelope = {
    schema_id: 'mdplace.evidence-envelope/v1',
    extension_id: extensionId,
    package_series: 'mdplace-spec/v1',
    release_version: '2.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-002',
    subject: {
      kind: 'conformance_fixture', subject_id: 'fixture:claim-proof',
      schema: 'contracts/schemas/claim-manifest.schema.json', sha256: 'a'.repeat(64),
    },
    verdict: 'pass',
  };
  const envelopeContent = `${JSON.stringify(envelope, null, 2)}\n`;
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    subject: {kind: 'conformance_fixture', subject_id: 'fixture:claim-proof', sha256: 'a'.repeat(64)},
    requirement_id: 'REQ-VAL-002',
    applicability: 'applicable',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'test_evidence', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'test_evidence', mandatory: true, availability: 'present', applicability: 'applicable',
      evidence_ref: envelopePath, evidence_digest: digest(envelopeContent), verdict: 'pass',
    }],
  };

  // When the claim binding is evaluated through the registered extension.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-101',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    subjectSchemas: [
      'contracts/schemas/claim-manifest.schema.json',
      'contracts/schemas/evidence-envelope.schema.json',
    ],
    document,
    extraFiles: {
      'contracts/schemas/evidence-envelope.schema.json': schemaFor(envelope),
      [envelopePath]: envelopeContent,
    },
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.specification_version_mismatch'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
  // Then a matching digest cannot launder a stale envelope into a passing claim.
});

test('CLI rejects duplicate envelope artifact and receipt identifiers', async () => {
  // Given contiguous collections that repeat one artifact path and one receipt identifier.
  const artifactContent = 'validator input\n';
  const requirementsContent = '{"requirements":[{"id":"REQ-VAL-003"}]}\n';
  const document = {
    schema_id: 'mdplace.evidence-envelope/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-003',
    input_digests: [
      {ordinal: 0, path: 'normative/input.txt', sha256: digest(artifactContent)},
      {ordinal: 1, path: 'normative/input.txt', sha256: digest(artifactContent)},
    ],
    output_digests: [],
    artifact_digests: [],
    receipts: [
      {ordinal: 0, receipt_id: 'receipt:duplicate'},
      {ordinal: 1, receipt_id: 'receipt:duplicate'},
    ],
  };

  // When the envelope is evaluated.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-102',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    document,
    extraFiles: {
      'normative/input.txt': artifactContent,
      'normative/requirements.json': requirementsContent,
    },
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.artifact_reference_duplicate', 'evidence.receipt_duplicate'],
      output: 'evidence envelope rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'recompute referenced artifact digests',
      ],
      terminalState: 'rejected',
    }),
  });
  // Then contiguous ordinals do not make duplicated identifiers deterministic.
});

test('CLI ignores missing mandatory evidence that is explicitly not applicable', async () => {
  // Given a claim whose only mandatory binding is explicitly not applicable.
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    applicability: 'applicable',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'irrelevant_proof', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'irrelevant_proof', mandatory: true, availability: 'missing',
      applicability: 'not_applicable', evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  // When the aggregate verdict is evaluated.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-POS-101',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'pass',
      codes: [],
      output: 'claim manifest accepted',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'validated',
    }),
  });
  // Then not-applicable evidence cannot downgrade an otherwise complete result.
});

test('CLI preserves a failed claim when its mandatory evidence later becomes stale', async () => {
  // Given a recorded failed proof whose binding is now stale and has not been replaced.
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    applicability: 'applicable',
    verdict: 'fail',
    evidence_requirements: [{evidence_kind: 'contradiction', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'contradiction', mandatory: true, availability: 'stale',
      applicability: 'applicable', evidence_ref: null, evidence_digest: null, verdict: 'fail',
    }],
  };

  // When the Claim Manifest is read back without fresh evidence.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-STATE-101',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'pass',
      codes: [],
      output: 'claim manifest accepted',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'validated',
    }),
  });
  // Then aggregate precedence preserves fail until a fresh proof is supplied.
});
