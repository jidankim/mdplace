import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';
import {runExtensionFixture} from './validator-evidence-fixture-support.mjs';
import {schemaFor, expected, digest, validatorVersion} from './validator-evidence-support.mjs';

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

test('conformance-driving evidence is normative while publication reports remain informative', async () => {
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
  assert.equal(authority.get('conformance/evidence/semantic-kernel-recovery-report.json'), 'normative');
  assert.equal(authority.get('conformance/evidence/validation-report.json'), 'informative');
  assert.equal(authority.get('conformance/evidence/traceability-report.json'), 'informative');
});
