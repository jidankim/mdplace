import test from 'node:test';
import {runExtensionFixture} from './validator-evidence-fixture-support.mjs';
import {schemaFor, expected, digest, extensionId, validatorVersion} from './validator-evidence-support.mjs';

test('CLI rejects a caller freshness assertion without a digest-bound claim', async () => {
  // Given an allowed transition whose caller supplies only the freshness Boolean.
  const authority = {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'};
  const document = {
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'awaiting_evidence',
    command: 'record_verdict',
    actor_authority: authority,
    fresh_evidence_supplied: true,
    fresh_claim: null,
  };
  const table = {transitions: [{
    from_state: 'awaiting_evidence', command_or_event: 'record_verdict', allowed: true,
    actor_authority: authority, terminal_state: 'verdict_recorded',
  }]};

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-ILLEGAL-102',
    schemaPath: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
    extraFiles: {'contracts/transitions/evidence-lifecycle.json': `${JSON.stringify(table)}\n`},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.fresh_evidence_required'],
      output: 'evidence transition denied',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate evidence lifecycle',
      ],
      terminalState: 'awaiting_evidence',
      illegalTransition: true,
    }),
  });
});

test('CLI rejects recovery that names no resolvable Claim Manifest', async () => {
  // Given a recovery report whose caller-chosen claim identifier has no bound Claim Manifest.
  const proof = 'current proof\n';
  const document = {
    schema_id: 'mdplace.evidence-recovery-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    claim_id: 'CLAIM-FAKE-999',
    claim: {
      claim_id: 'CLAIM-FAKE-999',
      path: 'conformance/evidence/claims/missing.json',
      sha256: 'a'.repeat(64),
    },
    prior_verdict: 'pass',
    fresh_evidence_supplied: false,
    recomputed_bindings: [{
      path: 'conformance/evidence/recovery-proof.json', expected_sha256: digest(proof),
      observed_sha256: digest(proof), matches: true,
    }],
    terminal_state: 'verdict_recorded',
    effective_verdict: 'pass',
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-REC-102',
    schemaPath: 'contracts/schemas/evidence-recovery-report.schema.json',
    document,
    extraFiles: {'conformance/evidence/recovery-proof.json': proof},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.recovery_claim_binding_mismatch', 'evidence.recovery_binding_set_mismatch'],
      output: 'recovery report rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'recompute evidence bindings',
        'preserve non-pass verdict',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI rejects an invocation whose inner subject schema is undeclared', async () => {
  const document = {
    schema_id: 'mdplace.validator-invocation/v1',
    extension_id: extensionId,
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    subject: {
      kind: 'conformance_fixture', subject_id: 'fixture:undeclared-subject',
      path: 'conformance/evidence/subjects/undeclared.json',
      schema: 'contracts/schemas/undeclared.schema.json', sha256: 'a'.repeat(64),
    },
    requirement_ids: ['REQ-VAL-002'],
    input_digests: [],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-AUTH-102',
    schemaPath: 'contracts/schemas/validator-invocation.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['validator.extension_schema_denied'],
      output: 'validator invocation rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'recompute referenced artifact digests',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI rejects a digest-matching invocation that is not valid JSON', async () => {
  const invocationPath = 'conformance/evidence/invocations/invalid-json.json';
  const invocation = '{not json}\n';
  const document = {
    schema_id: 'mdplace.evidence-envelope/v1',
    extension_id: extensionId,
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    invocation: {invocation_id: 'invocation:invalid-json', path: invocationPath, sha256: digest(invocation)},
    requirement_id: 'REQ-VAL-003',
    input_digests: [],
    output_digests: [],
    receipts: [],
    artifact_digests: [],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-103',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    subjectSchemas: [
      'contracts/schemas/evidence-envelope.schema.json',
      'contracts/schemas/validator-invocation.schema.json',
    ],
    document,
    extraFiles: {
      'contracts/schemas/validator-invocation.schema.json': schemaFor({schema_id: 'mdplace.validator-invocation/v1'}),
      [invocationPath]: invocation,
    },
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.invocation_binding_mismatch'],
      output: 'evidence envelope rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'recompute referenced artifact digests',
      ],
      terminalState: 'rejected',
    }),
  });
});
