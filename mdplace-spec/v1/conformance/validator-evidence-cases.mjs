import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';

import {validatePackage} from './validator-test-support.mjs';

const extensionId = 'mdplace.validator-extension/evidence/v1';
const validatorVersion = '1.1.0';
const digest = (value) => createHash('sha256').update(value).digest('hex');

function schemaFor(document) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:mdplace:test:${document.schema_id}`,
    type: 'object',
    additionalProperties: false,
    required: Object.keys(document),
    properties: Object.fromEntries(Object.keys(document).map((key) => [key, {}])),
  };
}

function expected({verdict, codes, output, operations, terminalState, illegalTransition = false}) {
  return {
    verdict,
    codes,
    outputs: [output],
    operations,
    receipts: ['EvidenceValidationReceipt'],
    filesystem_effects: ['none'],
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}

async function runExtensionFixture({fixtureId, extension = extensionId, schemaPath, document, oracle, extraFiles = {}}) {
  const fixture = {
    $schema: '../../contracts/schemas/conformance-fixture.schema.json',
    schema_id: 'mdplace.conformance-fixture/v1',
    fixture_id: fixtureId,
    category: 'negative',
    requirement_ids: ['REQ-VAL-002'],
    subject: {kind: 'extension', extension_id: extension, schema: schemaPath, document},
    expected: oracle,
  };
  const conformance = {
    fixtures: [{
      fixture_id: fixtureId,
      path: `fixtures/${fixtureId.toLowerCase()}.json`,
      category: fixture.category,
      requirement_ids: fixture.requirement_ids,
      expected_verdict: oracle.verdict,
      observable_assertions: {
        inputs: true,
        outputs: true,
        operations: true,
        receipts: true,
        filesystem_effects: true,
        terminal_state: true,
        illegal_transition: oracle.illegal_transition,
      },
    }],
  };
  const registry = {
    schema_id: 'mdplace.validator-extension-registry/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_version: validatorVersion,
    extensions: [{
      extension_id: extensionId,
      validator_id: 'mdplace.package-validator',
      validator_version: validatorVersion,
      subject_schemas: [schemaPath],
    }],
  };
  const result = await validatePackage({
    'package-manifest.yaml': {validator_version: validatorVersion},
    'contracts/validator-extensions.json': registry,
    [schemaPath]: schemaFor(document),
    'conformance/manifest.yaml': conformance,
    [`conformance/fixtures/${fixtureId.toLowerCase()}.json`]: fixture,
    ...extraFiles,
  });
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixtureId, verdict: 'pass', codes: []}]);
}

test('CLI rejects an evidence envelope bound to another specification version', async () => {
  // Given an envelope whose explicit release binding differs from the package under validation.
  const document = {
    schema_id: 'mdplace.evidence-envelope/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.1.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
  };

  // When the public validator resolves and evaluates the registered extension.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-STATE-001',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.specification_version_mismatch'],
      output: 'evidence envelope rejected',
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings'],
      terminalState: 'rejected',
    }),
  });
  // Then the negative fixture passes only when stale evidence remains non-pass.
});

test('CLI denies pass when a mandatory evidence binding is missing', async () => {
  // Given a claim that declares mandatory evidence missing while asserting pass.
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    applicability: 'applicable',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'test_evidence', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'test_evidence', mandatory: true, availability: 'missing', applicability: 'applicable',
      evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  // When the public validator evaluates the claim manifest.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-001',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.mandatory_evidence_missing'],
      output: 'claim manifest rejected',
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings', 'evaluate mandatory evidence'],
      terminalState: 'rejected',
    }),
  });
  // Then absent mandatory proof is an explicit non-pass result.
});

test('CLI rejects an unregistered validator extension', async () => {
  // Given a closed extension registry that does not declare the requested identifier.
  const document = {schema_id: 'mdplace.evidence-envelope/v1'};

  // When the public validator resolves the extension identifier.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-AUTH-001',
    extension: 'mdplace.validator-extension/ambient/v1',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['validator.extension_unsupported'],
      output: 'validator extension rejected',
      operations: ['resolve validator extension'],
      terminalState: 'rejected',
    }),
  });
  // Then ambient or inferred validator behavior cannot authorize the invocation.
});

test('CLI preserves an inconclusive verdict during recovery without fresh evidence', async () => {
  // Given a crash recovery readback with no fresh required evidence.
  const document = {
    schema_id: 'mdplace.evidence-recovery-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    prior_verdict: 'inconclusive',
    fresh_evidence_supplied: false,
    effective_verdict: 'inconclusive',
  };

  // When the public validator evaluates recovery state.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-REC-001',
    schemaPath: 'contracts/schemas/evidence-recovery-report.schema.json',
    document,
    oracle: expected({
      verdict: 'pass',
      codes: [],
      output: 'recovery report accepted',
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings', 'recompute evidence bindings', 'preserve non-pass verdict'],
      terminalState: 'inconclusive',
    }),
  });
  // Then readback cannot upgrade an inconclusive result without fresh proof.
});

test('CLI denies replacing a recorded verdict before fresh evidence is supplied', async () => {
  // Given a lifecycle attempt to record another verdict from the recorded state.
  const document = {
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'record_verdict',
  };
  const table = {
    transitions: [{
      from_state: 'verdict_recorded',
      command_or_event: 'record_verdict',
      allowed: false,
      terminal_state: 'verdict_recorded',
    }],
  };

  // When the public validator evaluates the declared lifecycle row.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-ILLEGAL-001',
    schemaPath: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
    extraFiles: {'contracts/transitions/evidence-lifecycle.json': `${JSON.stringify(table)}\n`},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.transition_denied'],
      output: 'evidence transition denied',
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings', 'evaluate evidence lifecycle'],
      terminalState: 'verdict_recorded',
      illegalTransition: true,
    }),
  });
  // Then only the fresh-evidence transition can reopen evaluation.
});

test('test fixture digests are independently derived from their bytes', () => {
  // Given a known byte sequence.
  const content = '{"fixture":true}\n';
  // When its SHA-256 binding is computed.
  const binding = digest(content);
  // Then the independent known-good vector is stable.
  assert.equal(binding, '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9');
});
