import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {conformanceDigestForArtifacts} from './digest-bindings.mjs';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {checkArtifactBindings} from './package-checks.mjs';
import {copyCommittedPackage, runPreparedPackage, validatePackage} from './validator-test-support.mjs';

const extensionId = 'mdplace.validator-extension/evidence/v1';
const validatorVersion = '1.1.0';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const committedPackageRoot = fileURLToPath(new URL('../', import.meta.url));

async function writeJson(packageRoot, path, document) {
  const content = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(`${packageRoot}/${path}`, content);
  return {document, path, content, sha256: digest(content)};
}

async function createFreshClaimChain(packageRoot, {
  suffix = 'fresh-validator-evidence',
  reuseInvocationId = false,
  substantive = true,
} = {}) {
  const recordedClaimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const recordedClaimContent = await readFile(`${packageRoot}/${recordedClaimPath}`);
  const recordedClaim = JSON.parse(recordedClaimContent.toString('utf8'));
  const invocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  if (!reuseInvocationId) invocation.invocation_id = `invocation:${suffix}`;
  let freshArtifact = null;
  if (substantive) {
    freshArtifact = await writeJson(packageRoot, `conformance/evidence/${suffix}-observation.json`, {
      observation: suffix,
    });
    invocation.input_digests.push({
      ordinal: invocation.input_digests.length,
      label: 'fresh_observation',
      path: freshArtifact.path,
      sha256: freshArtifact.sha256,
    });
  }
  const invocationArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/invocations/${suffix}.json`,
    invocation,
  );
  const envelope = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'utf8',
  ));
  envelope.envelope_id = `evidence:${suffix}`;
  envelope.invocation = {
    invocation_id: invocation.invocation_id,
    path: invocationArtifact.path,
    sha256: invocationArtifact.sha256,
  };
  envelope.receipts[0].receipt_id = `receipt:${suffix}`;
  if (freshArtifact !== null) {
    envelope.input_digests.push({...invocation.input_digests.at(-1)});
  }
  const envelopeArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/envelopes/${suffix}.json`,
    envelope,
  );
  const freshClaim = structuredClone(recordedClaim);
  freshClaim.evidence_bindings[0].evidence_ref = envelopeArtifact.path;
  freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
  const claimArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/claims/${suffix}.json`,
    freshClaim,
  );
  return {
    recordedClaim,
    recordedClaimBinding: {
      claim_id: recordedClaim.claim_id,
      path: recordedClaimPath,
      sha256: digest(recordedClaimContent),
    },
    freshClaim,
    freshClaimBinding: {
      claim_id: freshClaim.claim_id,
      path: claimArtifact.path,
      sha256: claimArtifact.sha256,
    },
    invocationArtifact,
    envelopeArtifact,
    freshArtifact,
  };
}

async function createFreshRecoveryReport(packageRoot, chain, suffix = 'fresh-supply') {
  const report = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  report.report_id = `evidence-recovery:${suffix}`;
  report.claim = structuredClone(chain.freshClaimBinding);
  report.recorded_claim = structuredClone(chain.recordedClaimBinding);
  report.prior_verdict = chain.recordedClaim.verdict;
  report.fresh_evidence_supplied = true;
  for (const artifact of [chain.freshClaimBinding, chain.envelopeArtifact, chain.invocationArtifact, chain.freshArtifact]) {
    if (artifact === null) continue;
    report.recomputed_bindings.push({
      path: artifact.path,
      expected_sha256: artifact.sha256,
      observed_sha256: artifact.sha256,
      matches: true,
    });
  }
  report.operations = ['reopen declared artifact', 'recompute sha256', 'accept fresh required evidence'];
  report.terminal_state = 'awaiting_evidence';
  report.effective_verdict = chain.freshClaim.verdict;
  const artifact = await writeJson(packageRoot, `conformance/evidence/${suffix}-report.json`, report);
  return {
    report,
    binding: {report_id: report.report_id, path: artifact.path, sha256: artifact.sha256},
  };
}

function transitionAttempt({command, fromState, freshClaim, recordedClaim = null, recoveryReport = null}) {
  return {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: fromState,
    command,
    actor_authority: command === 'record_verdict'
      ? {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}
      : {roles: ['evidence_supplier'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
    fresh_evidence_supplied: true,
    recorded_claim: recordedClaim,
    recovery_report: recoveryReport,
    fresh_claim: freshClaim,
  };
}

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
  const defaultFiles = {
    'contracts/verdicts/validator-verdicts.json': await readFile(
      new URL('../contracts/verdicts/validator-verdicts.json', import.meta.url),
      'utf8',
    ),
    'normative/requirements.json': await readFile(
      new URL('../normative/requirements.json', import.meta.url),
      'utf8',
    ),
  };
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
    ...defaultFiles,
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
  const claimPath = 'conformance/evidence/claims/inconclusive.json';
  const claim = {
    schema_id: 'mdplace.claim-manifest/v1',
    claim_id: 'CLAIM-RECOVERY-001',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    evidence_requirements: [{evidence_kind: 'proof', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'proof', mandatory: true, availability: 'missing', applicability: 'applicable',
      evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
    applicability: 'applicable',
    verdict: 'inconclusive',
  };
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  const document = {
    schema_id: 'mdplace.evidence-recovery-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    claim_id: claim.claim_id,
    claim: {claim_id: claim.claim_id, path: claimPath, sha256: digest(claimContent)},
    prior_verdict: 'inconclusive',
    fresh_evidence_supplied: false,
    recomputed_bindings: [{
      path: claimPath, expected_sha256: digest(claimContent),
      observed_sha256: digest(claimContent), matches: true,
    }],
    terminal_state: 'verdict_recorded',
    effective_verdict: 'inconclusive',
  };

  // When the public validator evaluates recovery state.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-REC-001',
    schemaPath: 'contracts/schemas/evidence-recovery-report.schema.json',
    subjectSchemas: [
      'contracts/schemas/evidence-recovery-report.schema.json',
      'contracts/schemas/claim-manifest.schema.json',
    ],
    document,
    extraFiles: {
      'contracts/schemas/claim-manifest.schema.json': schemaFor(claim),
      [claimPath]: claimContent,
    },
    oracle: expected({
      verdict: 'pass',
      codes: [],
      output: 'recovery report accepted',
      operations: ['resolve validator extension', 'validate extension document', 'verify specification and validator bindings', 'recompute evidence bindings', 'preserve non-pass verdict'],
      terminalState: 'verdict_recorded',
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
  const claimPath = 'conformance/evidence/claims/stale.json';
  const claim = {
    schema_id: 'mdplace.claim-manifest/v1',
    claim_id: 'CLAIM-RECOVERY-002',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    evidence_requirements: [],
    evidence_bindings: [],
    applicability: 'not_applicable',
    verdict: 'pass',
  };
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  const document = {
    schema_id: 'mdplace.evidence-recovery-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    claim_id: claim.claim_id,
    claim: {claim_id: claim.claim_id, path: claimPath, sha256: 'a'.repeat(64)},
    prior_verdict: 'pass',
    fresh_evidence_supplied: false,
    recomputed_bindings: [{
      path: claimPath, expected_sha256: 'a'.repeat(64),
      observed_sha256: digest(claimContent), matches: false,
    }],
    terminal_state: 'verdict_recorded',
    effective_verdict: 'pass',
  };

  // When readback evaluates the observed bytes.
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-REC-101',
    schemaPath: 'contracts/schemas/evidence-recovery-report.schema.json',
    subjectSchemas: [
      'contracts/schemas/evidence-recovery-report.schema.json',
      'contracts/schemas/claim-manifest.schema.json',
    ],
    document,
    extraFiles: {
      'contracts/schemas/claim-manifest.schema.json': schemaFor(claim),
      [claimPath]: claimContent,
    },
    oracle: expected({
      verdict: 'fail',
      codes: [
        'evidence.recovery_stale_pass',
        'evidence.recovery_state_invalid',
      ],
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

test('conformance-driving profile claims are normative while generated reports remain informative', async () => {
  // Given the package authority ledger.
  const manifest = JSON.parse(await readFile(new URL('../package-manifest.yaml', import.meta.url), 'utf8'));
  const authority = new Map(manifest.artifacts.map(({path, authority: value}) => [path, value]));

  // When reference claim and evidence artifacts are compared with generated reports.
  // Then only the artifacts consumed by conformance carry normative authority.
  assert.equal(authority.get('claims-and-evidence.yaml'), 'normative');
  assert.equal(authority.get('conformance/claim-manifests/core.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/envelopes/validator-evidence-reference.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/invocations/validator-evidence-reference.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/evidence-recovery-report.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/validation-report.json'), 'informative');
  assert.equal(authority.get('conformance/evidence/traceability-report.json'), 'informative');
});

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

test('CLI enforces the verdict table availability matrix for every claim binding', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    applicability: 'applicable',
    verdict: 'fail',
    evidence_requirements: [{evidence_kind: 'contradiction', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'contradiction', mandatory: true, availability: 'missing',
      applicability: 'applicable', evidence_ref: null, evidence_digest: null, verdict: 'fail',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-104',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.verdict_availability_mismatch'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI keeps unknown mandatory applicability in the aggregate verdict', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    applicability: 'unknown',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'undetermined', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'undetermined', mandatory: true, availability: 'missing',
      applicability: 'unknown', evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-105',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.mandatory_evidence_inconclusive'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI rejects a Claim Manifest whose normative requirement is unresolved', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-FAKE-999',
    applicability: 'not_applicable',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'irrelevant', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'irrelevant', mandatory: true, availability: 'missing',
      applicability: 'not_applicable', evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-106',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.requirement_unresolved'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI contains malformed transition rows as structured extension failures', async () => {
  const document = {
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'awaiting_evidence',
    command: 'record_verdict',
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-107',
    schemaPath: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
    extraFiles: {'contracts/transitions/evidence-lifecycle.json': '{"transitions":[null]}\n'},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.transition_unresolved'],
      output: 'evidence transition rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate evidence lifecycle',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI contains a malformed subject-schema registry as a structured extension failure', async () => {
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-108',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    subjectSchemas: 7,
    document: {schema_id: 'mdplace.evidence-envelope/v1'},
    oracle: expected({
      verdict: 'fail',
      codes: ['schema.constraint'],
      output: 'validator extension rejected',
      operations: ['resolve validator extension'],
      terminalState: 'rejected',
    }),
  });
});

test('evidence authority cannot be downgraded by changing the validator version literal', async () => {
  const packageRoot = await copyCommittedPackage();
  const manifestPath = `${packageRoot}/package-manifest.yaml`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.validator_version = '1.0.0';
  for (const artifact of manifest.artifacts) {
    if (artifact.path === 'claims-and-evidence.yaml' ||
        artifact.path.startsWith('conformance/claim-manifests/') ||
        artifact.path.startsWith('conformance/evidence/claims/') ||
        artifact.path.startsWith('conformance/evidence/envelopes/') ||
        artifact.path.startsWith('conformance/evidence/invocations/') ||
        artifact.path === 'conformance/evidence/evidence-recovery-report.json') {
      artifact.authority = 'informative';
    }
  }
  manifest.normative_digest = digest(manifest.artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`)
    .join(''));
  manifest.conformance_digest = conformanceDigestForArtifacts(manifest.artifacts);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const {check} = await checkArtifactBindings(packageRoot, manifest);

  assert.ok(check.codes.includes('artifact.authority_mismatch'));
});

test('record-verdict requires an artifact-bound fresh-supply report', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'awaiting_evidence',
    command: 'record_verdict',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: true,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)},
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_report_required'));
});

test('record-verdict accepts the claim bound by a validated fresh-supply report', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'recordable-fresh-evidence'});
  const recovery = await createFreshRecoveryReport(packageRoot, chain, 'recordable-fresh-evidence');
  const document = transitionAttempt({
    command: 'record_verdict',
    fromState: 'awaiting_evidence',
    freshClaim: chain.freshClaimBinding,
    recoveryReport: recovery.binding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'verdict_recorded');
});

test('recovery rejects omission from the transitive binding set', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.recomputed_bindings = recovery.recomputed_bindings.slice(0, 1);

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_binding_set_mismatch'));
});

test('recovery binding enumeration descends through invocation subjects', async () => {
  const packageRoot = await copyCommittedPackage();
  const baseInvocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  const nestedInvocation = structuredClone(baseInvocation);
  nestedInvocation.invocation_id = 'invocation:nested-recovery-subject';
  const nestedInvocationArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/invocations/nested-recovery-subject.json',
    nestedInvocation,
  );
  const baseEnvelope = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'utf8',
  ));
  const nestedEnvelope = structuredClone(baseEnvelope);
  nestedEnvelope.envelope_id = 'evidence:nested-recovery-subject';
  nestedEnvelope.invocation = {
    invocation_id: nestedInvocation.invocation_id,
    path: nestedInvocationArtifact.path,
    sha256: nestedInvocationArtifact.sha256,
  };
  nestedEnvelope.receipts[0].receipt_id = 'receipt:nested-recovery-subject';
  const nestedEnvelopeArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/envelopes/nested-recovery-subject.json',
    nestedEnvelope,
  );
  const nestedClaim = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/claims/recovery-snapshot.json`,
    'utf8',
  ));
  nestedClaim.claim_id = 'CLAIM-NESTED-001';
  nestedClaim.evidence_bindings[0].evidence_ref = nestedEnvelopeArtifact.path;
  nestedClaim.evidence_bindings[0].evidence_digest = nestedEnvelopeArtifact.sha256;
  const nestedClaimArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/nested-recovery-subject.json',
    nestedClaim,
  );
  const outerInvocation = structuredClone(baseInvocation);
  outerInvocation.invocation_id = 'invocation:outer-recovery-subject';
  outerInvocation.subject = {
    kind: 'claim_manifest',
    subject_id: 'claim:nested-recovery-subject',
    path: nestedClaimArtifact.path,
    schema: 'contracts/schemas/claim-manifest.schema.json',
    sha256: nestedClaimArtifact.sha256,
  };
  const outerInvocationArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/invocations/outer-recovery-subject.json',
    outerInvocation,
  );
  const outerEnvelope = structuredClone(baseEnvelope);
  outerEnvelope.envelope_id = 'evidence:outer-recovery-subject';
  outerEnvelope.invocation = {
    invocation_id: outerInvocation.invocation_id,
    path: outerInvocationArtifact.path,
    sha256: outerInvocationArtifact.sha256,
  };
  outerEnvelope.subject = {
    kind: outerInvocation.subject.kind,
    subject_id: outerInvocation.subject.subject_id,
    schema: outerInvocation.subject.schema,
    sha256: outerInvocation.subject.sha256,
  };
  outerEnvelope.receipts[0].receipt_id = 'receipt:outer-recovery-subject';
  const outerEnvelopeArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/envelopes/outer-recovery-subject.json',
    outerEnvelope,
  );
  const rootClaim = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/claims/recovery-snapshot.json`,
    'utf8',
  ));
  rootClaim.subject = {
    kind: outerEnvelope.subject.kind,
    subject_id: outerEnvelope.subject.subject_id,
    sha256: outerEnvelope.subject.sha256,
  };
  rootClaim.evidence_bindings[0].evidence_ref = outerEnvelopeArtifact.path;
  rootClaim.evidence_bindings[0].evidence_digest = outerEnvelopeArtifact.sha256;
  const rootClaimArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/outer-recovery-subject.json',
    rootClaim,
  );
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  recovery.claim = {
    claim_id: rootClaim.claim_id,
    path: rootClaimArtifact.path,
    sha256: rootClaimArtifact.sha256,
  };
  recovery.recomputed_bindings = recovery.recomputed_bindings.map((binding) => {
    if (binding.path === 'conformance/evidence/claims/recovery-snapshot.json') {
      return {path: rootClaimArtifact.path, expected_sha256: rootClaimArtifact.sha256,
        observed_sha256: rootClaimArtifact.sha256, matches: true};
    }
    if (binding.path === 'conformance/evidence/envelopes/validator-evidence-reference.json') {
      return {path: outerEnvelopeArtifact.path, expected_sha256: outerEnvelopeArtifact.sha256,
        observed_sha256: outerEnvelopeArtifact.sha256, matches: true};
    }
    if (binding.path === 'conformance/evidence/invocations/validator-evidence-reference.json') {
      return {path: outerInvocationArtifact.path, expected_sha256: outerInvocationArtifact.sha256,
        observed_sha256: outerInvocationArtifact.sha256, matches: true};
    }
    return binding;
  });
  recovery.recomputed_bindings.push({
    path: nestedClaimArtifact.path,
    expected_sha256: nestedClaimArtifact.sha256,
    observed_sha256: nestedClaimArtifact.sha256,
    matches: true,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_binding_set_mismatch'));
});

test('recovery cannot upgrade unsupported to pass without fresh evidence', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.prior_verdict = 'unsupported';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_verdict_upgrade'));
});

test('recovery rejects a freshness Boolean bound to incomplete mandatory evidence', async () => {
  const claimPath = 'conformance/claim-manifests/core.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.claim_id = 'CLAIM-CORE-001';
  recovery.claim = {claim_id: recovery.claim_id, path: claimPath, sha256: digest(claimContent)};
  recovery.prior_verdict = 'inconclusive';
  recovery.fresh_evidence_supplied = true;
  recovery.recomputed_bindings = [{
    path: claimPath,
    expected_sha256: digest(claimContent),
    observed_sha256: digest(claimContent),
    matches: true,
  }];
  recovery.terminal_state = 'awaiting_evidence';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_required'));
});

test('recovery rejects unchanged recorded evidence presented as fresh', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.recorded_claim = structuredClone(recovery.claim);
  recovery.fresh_evidence_supplied = true;
  recovery.terminal_state = 'awaiting_evidence';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('CLI contains a malformed digest-bound Claim Manifest as a structured failure', async () => {
  const packageRoot = await copyCommittedPackage();
  const claimPath = 'conformance/claim-manifests/core.json';
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.evidence_bindings = [null];
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, claimContent);
  const indexPath = `${packageRoot}/claims-and-evidence.yaml`;
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.claims.find(({manifest_ref: path}) => path === claimPath).sha256 = digest(claimContent);
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({id, codes}) =>
    ['schema-instances', 'validator-evidence-contract'].includes(id) && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('CLI contains malformed recovery claim collections as structured failures', async () => {
  const packageRoot = await copyCommittedPackage();
  const recoveryPath = 'conformance/evidence/evidence-recovery-report.json';
  const recovery = JSON.parse(await readFile(`${packageRoot}/${recoveryPath}`, 'utf8'));
  const claimPath = recovery.claim.path;
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.evidence_bindings = 7;
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  const claimDigest = digest(claimContent);
  await writeFile(`${packageRoot}/${claimPath}`, claimContent);
  recovery.claim.sha256 = claimDigest;
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  Object.assign(claimBinding, {expected_sha256: claimDigest, observed_sha256: claimDigest, matches: true});
  await writeFile(`${packageRoot}/${recoveryPath}`, `${JSON.stringify(recovery, null, 2)}\n`);

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({id, codes}) =>
    ['schema-instances', 'validator-evidence-contract'].includes(id) && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('CLI contains malformed normative requirement rows as structured failures', async () => {
  const packageRoot = await copyCommittedPackage();
  await writeFile(`${packageRoot}/normative/requirements.json`, '{"requirements":[null]}\n');

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('recovery accepts an accurate stale downgrade from a prior pass', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const claimPath = recovery.claim.path;
  const changedClaim = `${await readFile(`${packageRoot}/${claimPath}`, 'utf8')}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, changedClaim);
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  claimBinding.observed_sha256 = digest(changedClaim);
  claimBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});

test('stale recovery retains semantic Claim Manifest failures', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const claimPath = recovery.claim.path;
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.requirement_id = 'REQ-VAL-999';
  const changedClaim = `${JSON.stringify(claim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, changedClaim);
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  claimBinding.observed_sha256 = digest(changedClaim);
  claimBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('claim.requirement_unresolved'));
});

test('recovery accepts null as the truthful observation of an absent artifact', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const absentPath = 'normative/validator-evidence-contract.md';
  await unlink(`${packageRoot}/${absentPath}`);
  const absentBinding = recovery.recomputed_bindings.find(({path}) => path === absentPath);
  absentBinding.observed_sha256 = null;
  absentBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});

test('readback requires a digest-bound recursively validated Recovery Report', async () => {
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_report_required'));
});

test('transition freshness fields cannot contradict their bound evidence', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)},
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_inconsistent'));
});

test('fresh-evidence supply rejects a replayed Claim Manifest chain', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const claim = {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)};
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'supply_fresh_evidence',
    actor_authority: {roles: ['evidence_supplier'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
    fresh_evidence_supplied: true,
    recorded_claim: claim,
    recovery_report: null,
    fresh_claim: claim,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('readback accepts a digest-bound recursively validated Recovery Report', async () => {
  const reportPath = 'conformance/evidence/evidence-recovery-report.json';
  const reportContent = await readFile(new URL(`../${reportPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: {
      report_id: 'evidence-recovery:pass-readback',
      path: reportPath,
      sha256: digest(reportContent),
    },
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'verdict_recorded');
});

test('mark-stale accepts an accurate digest-bound stale Recovery Report', async () => {
  const packageRoot = await copyCommittedPackage();
  const recordedClaimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const staleClaimPath = 'conformance/evidence/claims/stale-recovery-snapshot.json';
  const staleClaim = JSON.parse(await readFile(`${packageRoot}/${recordedClaimPath}`, 'utf8'));
  staleClaim.evidence_bindings[0].evidence_digest = 'a'.repeat(64);
  const staleClaimContent = `${JSON.stringify(staleClaim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${staleClaimPath}`, staleClaimContent);
  const report = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  report.report_id = 'evidence-recovery:stale-readback';
  report.claim.path = staleClaimPath;
  report.claim.sha256 = digest(staleClaimContent);
  report.recomputed_bindings[0] = {
    path: staleClaimPath,
    expected_sha256: digest(staleClaimContent),
    observed_sha256: digest(staleClaimContent),
    matches: true,
  };
  const envelopeBinding = report.recomputed_bindings.find(({path}) =>
    path === 'conformance/evidence/envelopes/validator-evidence-reference.json');
  envelopeBinding.expected_sha256 = 'a'.repeat(64);
  envelopeBinding.matches = false;
  report.operations = ['reopen declared artifact', 'recompute sha256', 'mark evidence stale'];
  report.terminal_state = 'evidence_stale';
  report.effective_verdict = 'inconclusive';
  const reportPath = 'conformance/evidence/evidence-stale-recovery-report.json';
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(`${packageRoot}/${reportPath}`, reportContent);
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'mark_stale',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: {report_id: report.report_id, path: reportPath, sha256: digest(reportContent)},
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});

test('fresh-evidence supply rejects identifier-only churn', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'identifier-churn', substantive: false});
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('fresh-evidence supply rejects unauthenticated receipt-only churn', async () => {
  for (const receiptMutation of ['type', 'digest']) {
    const packageRoot = await copyCommittedPackage();
    const suffix = `receipt-${receiptMutation}-churn`;
    const chain = await createFreshClaimChain(packageRoot, {suffix, substantive: false});
    const envelope = JSON.parse(await readFile(`${packageRoot}/${chain.envelopeArtifact.path}`, 'utf8'));
    if (receiptMutation === 'type') envelope.receipts[0].receipt_type = 'AlternateReceipt';
    else envelope.receipts[0].sha256 = 'a'.repeat(64);
    const envelopeArtifact = await writeJson(packageRoot, chain.envelopeArtifact.path, envelope);
    chain.freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
    const claimArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, chain.freshClaim);
    chain.freshClaimBinding.sha256 = claimArtifact.sha256;
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState: 'verdict_recorded',
      recordedClaim: chain.recordedClaimBinding,
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', receiptMutation);
    assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'), receiptMutation);
  }
});

test('fresh-evidence supply rejects digest-list churn without new proof bytes', async () => {
  const mutations = [
    {
      name: 'remove',
      apply(envelope) {
        envelope.artifact_digests.pop();
      },
    },
    {
      name: 'reorder',
      apply(envelope) {
        envelope.artifact_digests = envelope.artifact_digests.reverse()
          .map((entry, ordinal) => ({...entry, ordinal}));
      },
    },
    {
      name: 'duplicate bytes',
      async apply(envelope, packageRoot) {
        const copiedPath = 'conformance/evidence/copied-contract.md';
        await writeFile(
          `${packageRoot}/${copiedPath}`,
          await readFile(`${packageRoot}/${envelope.artifact_digests[0].path}`),
        );
        envelope.artifact_digests.push({
          ...envelope.artifact_digests[0],
          ordinal: envelope.artifact_digests.length,
          label: 'copied_contract',
          path: copiedPath,
        });
      },
    },
    {
      name: 'role',
      apply(envelope) {
        const output = envelope.output_digests[0];
        const artifact = envelope.artifact_digests[0];
        envelope.output_digests[0] = {...artifact, ordinal: 0};
        envelope.artifact_digests[0] = {...output, ordinal: 0};
      },
    },
  ];
  for (const mutation of mutations) {
    const packageRoot = await copyCommittedPackage();
    const suffix = `digest-${mutation.name.replace(' ', '-')}-churn`;
    const chain = await createFreshClaimChain(packageRoot, {suffix, substantive: false});
    const envelope = JSON.parse(await readFile(`${packageRoot}/${chain.envelopeArtifact.path}`, 'utf8'));
    await mutation.apply(envelope, packageRoot);
    const envelopeArtifact = await writeJson(packageRoot, chain.envelopeArtifact.path, envelope);
    chain.freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
    const claimArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, chain.freshClaim);
    chain.freshClaimBinding.sha256 = claimArtifact.sha256;
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState: 'verdict_recorded',
      recordedClaim: chain.recordedClaimBinding,
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', mutation.name);
    assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'), mutation.name);
  }
});

test('fresh-evidence supply rejects reuse of the recorded invocation identity', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'reused-invocation', reuseInvocationId: true});
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('fresh-evidence supply accepts a new invocation with changed proof bytes', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot);
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});

test('fresh-evidence supply replaces every non-present mandatory evidence state', async () => {
  const cases = [
    {availability: 'missing', verdict: 'inconclusive', fromState: 'verdict_recorded'},
    {availability: 'stale', verdict: 'inconclusive', fromState: 'evidence_stale'},
    {availability: 'skipped', verdict: 'inconclusive', fromState: 'verdict_recorded'},
    {availability: 'unsupported', verdict: 'unsupported', fromState: 'verdict_recorded'},
  ];
  for (const {availability, verdict, fromState} of cases) {
    const packageRoot = await copyCommittedPackage();
    const chain = await createFreshClaimChain(packageRoot, {suffix: `${availability}-replacement`});
    const recordedClaim = structuredClone(chain.recordedClaim);
    recordedClaim.verdict = verdict;
    recordedClaim.evidence_bindings[0] = {
      ...recordedClaim.evidence_bindings[0],
      availability,
      evidence_ref: null,
      evidence_digest: null,
      verdict,
    };
    const recordedArtifact = await writeJson(
      packageRoot,
      `conformance/evidence/claims/recorded-${availability}.json`,
      recordedClaim,
    );
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState,
      recordedClaim: {
        claim_id: recordedClaim.claim_id,
        path: recordedArtifact.path,
        sha256: recordedArtifact.sha256,
      },
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'pass', availability);
    assert.equal(observed.terminal_state, 'awaiting_evidence', availability);
  }
});

test('fresh-evidence supply carries current mandatory proof while replacing missing proof', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'mixed-state-replacement'});
  const recordedClaim = structuredClone(chain.recordedClaim);
  recordedClaim.evidence_requirements.push({evidence_kind: 'replacement_evidence', mandatory: true});
  recordedClaim.evidence_bindings.push({
    evidence_kind: 'replacement_evidence',
    mandatory: true,
    availability: 'missing',
    applicability: 'applicable',
    evidence_ref: null,
    evidence_digest: null,
    verdict: 'inconclusive',
  });
  recordedClaim.verdict = 'inconclusive';
  const recordedArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/recorded-mixed-state.json',
    recordedClaim,
  );
  const freshClaim = structuredClone(recordedClaim);
  freshClaim.evidence_bindings[1] = {
    ...freshClaim.evidence_bindings[1],
    availability: 'present',
    evidence_ref: chain.envelopeArtifact.path,
    evidence_digest: chain.envelopeArtifact.sha256,
    verdict: 'pass',
  };
  freshClaim.verdict = 'pass';
  const freshArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, freshClaim);
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: {
      claim_id: recordedClaim.claim_id,
      path: recordedArtifact.path,
      sha256: recordedArtifact.sha256,
    },
    freshClaim: {
      claim_id: freshClaim.claim_id,
      path: freshArtifact.path,
      sha256: freshArtifact.sha256,
    },
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});

test('fresh recovery binds prior verdict to the recorded Claim Manifest', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'prior-verdict-mismatch'});
  const recovery = await createFreshRecoveryReport(packageRoot, chain, 'prior-verdict-mismatch');
  recovery.report.prior_verdict = 'unsupported';
  const reportArtifact = await writeJson(packageRoot, recovery.binding.path, recovery.report);
  recovery.binding.sha256 = reportArtifact.sha256;

  const reportObservation = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery.report,
  }, packageRoot);
  const transitionObservation = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document: transitionAttempt({
      command: 'record_verdict',
      fromState: 'awaiting_evidence',
      freshClaim: chain.freshClaimBinding,
      recoveryReport: recovery.binding,
    }),
  }, packageRoot);

  assert.equal(reportObservation.verdict, 'fail');
  assert.ok(reportObservation.codes.includes('evidence.recovery_claim_verdict_mismatch'));
  assert.equal(transitionObservation.verdict, 'fail');
  assert.ok(transitionObservation.codes.includes('evidence.recovery_report_invalid'));
  assert.ok(transitionObservation.codes.includes('evidence.recovery_claim_verdict_mismatch'));
});

test('fresh-evidence supply rejects replay when stale recorded proof cannot be reopened', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'unreadable-stale-proof', substantive: false});
  await writeFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'not valid JSON\n',
  );
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'evidence_stale',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('fresh-evidence supply can replace a semantically stale recorded claim chain', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'stale-replacement'});
  const recordedEnvelopePath = 'conformance/evidence/envelopes/validator-evidence-reference.json';
  const recordedEnvelope = await readFile(`${packageRoot}/${recordedEnvelopePath}`, 'utf8');
  await writeFile(`${packageRoot}/${recordedEnvelopePath}`, `${recordedEnvelope}\n`);
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'evidence_stale',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});

test('claim-level unknown applicability cannot aggregate to pass', async () => {
  const claim = JSON.parse(await readFile(new URL('../conformance/claim-manifests/core.json', import.meta.url), 'utf8'));
  claim.applicability = 'unknown';
  claim.evidence_bindings[0].applicability = 'not_applicable';
  claim.verdict = 'pass';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/claim-manifest.schema.json',
    document: claim,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('claim.mandatory_evidence_inconclusive'));
  assert.ok(observed.codes.includes('claim.applicability_mismatch'));
});

test('invocations reject duplicate ordered input identifiers', async () => {
  const invocation = JSON.parse(await readFile(
    new URL('../conformance/evidence/invocations/validator-evidence-reference.json', import.meta.url),
    'utf8',
  ));
  invocation.input_digests.push({...invocation.input_digests[0], ordinal: invocation.input_digests.length});

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/validator-invocation.schema.json',
    document: invocation,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.invocation_input_duplicate'));
});

test('evidence envelopes exactly reproduce invocation inputs and execution context', async (t) => {
  const envelopePath = new URL('../conformance/evidence/envelopes/validator-evidence-reference.json', import.meta.url);
  await t.test('input digests', async () => {
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    envelope.input_digests.pop();

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-envelope.schema.json',
      document: envelope,
    }, committedPackageRoot);

    assert.equal(observed.verdict, 'fail');
    assert.ok(observed.codes.includes('evidence.invocation_binding_mismatch'));
  });
  await t.test('execution context', async () => {
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    envelope.execution_context.network_access = 'declared';

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-envelope.schema.json',
      document: envelope,
    }, committedPackageRoot);

    assert.equal(observed.verdict, 'fail');
    assert.ok(observed.codes.includes('evidence.invocation_binding_mismatch'));
  });
});

test('invocation subjects share the package and validator version binding', async () => {
  const packageRoot = await copyCommittedPackage();
  const subjectPath = 'contracts/verdicts/validator-verdicts.json';
  const subject = JSON.parse(await readFile(`${packageRoot}/${subjectPath}`, 'utf8'));
  subject.release_version = '2.0.0';
  const subjectContent = `${JSON.stringify(subject, null, 2)}\n`;
  await writeFile(`${packageRoot}/${subjectPath}`, subjectContent);
  const invocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  invocation.subject.sha256 = digest(subjectContent);
  invocation.input_digests.find(({path}) => path === subjectPath).sha256 = digest(subjectContent);

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/validator-invocation.schema.json',
    document: invocation,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.specification_version_mismatch'));
});

test('normative Claim Manifest artifacts use domain-approved names', async () => {
  const index = JSON.parse(await readFile(new URL('../claims-and-evidence.yaml', import.meta.url), 'utf8'));
  const claim = JSON.parse(await readFile(new URL('../conformance/claim-manifests/core.json', import.meta.url), 'utf8'));

  assert.equal(index.index_kind, 'profile_claims');
  assert.equal(claim.manifest_kind, 'profile_claim');
});

test('unsupported recovery is bound to a normative fixture and Traceability Record', async () => {
  const manifest = JSON.parse(await readFile(new URL('../conformance/manifest.yaml', import.meta.url), 'utf8'));
  const traceability = JSON.parse(await readFile(new URL('../traceability.yaml', import.meta.url), 'utf8'));
  const record = traceability.records.find(({requirement_id: id}) => id === 'REQ-VAL-006');

  assert.ok(manifest.fixtures.some(({fixture_id: id}) => id === 'FIX-VAL-REC-003'));
  assert.ok(record.negative_fixture_ids.includes('FIX-VAL-REC-003'));
});

test('test fixture digests are independently derived from their bytes', () => {
  // Given a known byte sequence.
  const content = '{"fixture":true}\n';
  // When its SHA-256 binding is computed.
  const binding = digest(content);
  // Then the independent known-good vector is stable.
  assert.equal(binding, '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9');
});
