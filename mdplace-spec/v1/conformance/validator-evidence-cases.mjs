import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage, validatePackage} from './validator-test-support.mjs';

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

async function runExtensionFixture({
  fixtureId,
  extension = extensionId,
  schemaPath,
  subjectSchemas = [schemaPath],
  document,
  oracle,
  extraFiles = {},
}) {
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
      subject_schemas: subjectSchemas,
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
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings', 'evaluate mandatory evidence', 'validate bound evidence envelopes'],
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

test('CLI marks a recomputed digest mismatch stale and denies an effective pass', async () => {
  // Given recovery that accurately reports a mismatch but attempts to retain pass and recorded state.
  const proof = 'changed proof\n';
  const document = {
    schema_id: 'mdplace.evidence-recovery-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    prior_verdict: 'pass',
    fresh_evidence_supplied: false,
    recomputed_bindings: [{
      path: 'conformance/evidence/recovery-proof.json', expected_sha256: 'a'.repeat(64),
      observed_sha256: digest(proof), matches: false,
    }],
    terminal_state: 'verdict_recorded',
    effective_verdict: 'pass',
  };

  // When readback evaluates the observed bytes.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-REC-101',
    schemaPath: 'contracts/schemas/evidence-recovery-report.schema.json',
    document,
    extraFiles: {'conformance/evidence/recovery-proof.json': proof},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.recovery_stale_pass', 'evidence.recovery_state_invalid'],
      output: 'recovery report rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'recompute evidence bindings',
        'preserve non-pass verdict',
      ],
      terminalState: 'rejected',
    }),
  });
  // Then an accurately reported mismatch still cannot preserve pass.
});

test('CLI denies recording a verdict when fresh evidence was not supplied', async () => {
  // Given an otherwise allowed record-verdict row without fresh required evidence.
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
    fresh_evidence_supplied: false,
  };
  const table = {transitions: [{
    from_state: 'awaiting_evidence', command_or_event: 'record_verdict', allowed: true,
    actor_authority: authority, terminal_state: 'verdict_recorded',
  }]};

  // When the lifecycle attempt is evaluated.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-ILLEGAL-101',
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
  // Then an allowed table row cannot bypass its explicit evidence precondition.
});

test('CLI returns a structured check for a malformed validator evidence table', async () => {
  // Given valid JSON whose verdict row collection has the wrong shape.
  const packageRoot = await copyCommittedPackage();
  const path = `${packageRoot}/contracts/verdicts/validator-verdicts.json`;
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.rows = {};
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

  // When the public validator evaluates the package boundary.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then malformed collections remain deterministic and never collapse into the fallback report.
  assert.equal(result.status, 1);
  assert.equal(report.verdict, 'fail');
  assert.ok(report.checks.some(({id, codes}) => id === 'validator-evidence-contract' && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('CLI returns a structured check for a malformed claim index collection', async () => {
  // Given valid JSON whose Claim Manifest collection has the wrong shape.
  const packageRoot = await copyCommittedPackage();
  const path = `${packageRoot}/claims-and-evidence.yaml`;
  const document = JSON.parse(await readFile(path, 'utf8'));
  document.claims = {};
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

  // When the public validator evaluates every bound root instance.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then malformed collections remain deterministic and never collapse into the fallback report.
  assert.equal(result.status, 1);
  assert.equal(report.verdict, 'fail');
  assert.ok(report.checks.some(({id, codes}) => id === 'schema-instances' && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('verdict rows declare the complete permitted availability matrix', async () => {
  // Given the normative verdict table.
  const table = JSON.parse(await readFile(new URL('../contracts/verdicts/validator-verdicts.json', import.meta.url), 'utf8'));

  // When each verdict is mapped to its permitted evidence availability.
  const availability = Object.fromEntries(table.rows.map(({verdict, permitted_availability: values}) => [verdict, values]));

  // Then pass cannot absorb non-pass availability and preserved stale fail remains explicit.
  assert.deepEqual(availability, {
    pass: ['present'],
    fail: ['present', 'stale'],
    unsupported: ['present', 'unsupported'],
    inconclusive: ['present', 'missing', 'stale', 'skipped'],
  });
});

test('conformance-driving claim examples are normative while generated reports remain informative', async () => {
  // Given the package authority ledger.
  const manifest = JSON.parse(await readFile(new URL('../package-manifest.yaml', import.meta.url), 'utf8'));
  const authority = new Map(manifest.artifacts.map(({path, authority: value}) => [path, value]));

  // When reference claim and evidence artifacts are compared with generated reports.
  // Then only the artifacts consumed by conformance carry normative authority.
  assert.equal(authority.get('claims-and-evidence.yaml'), 'normative');
  assert.equal(authority.get('conformance/claim-manifests/core.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/envelopes/validator-evidence-example.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/invocations/validator-evidence-example.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/evidence-recovery-report.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/validation-report.json'), 'informative');
  assert.equal(authority.get('conformance/evidence/traceability-report.json'), 'informative');
});

test('test fixture digests are independently derived from their bytes', () => {
  // Given a known byte sequence.
  const content = '{"fixture":true}\n';
  // When its SHA-256 binding is computed.
  const binding = digest(content);
  // Then the independent known-good vector is stable.
  assert.equal(binding, '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9');
});
