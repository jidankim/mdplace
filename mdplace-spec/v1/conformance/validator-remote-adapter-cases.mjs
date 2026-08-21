import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';

async function remoteCheckAfterMutation(t, mutate) {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  await mutate(packageRoot);
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);
  return report.checks.find(({id}) => id === 'remote-intelligence-adapter-profile');
}

test('committed package proves the independent Remote Intelligence Adapter profile', async (t) => {
  // Given the committed specification package with its Remote Intelligence Adapter artifacts.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));

  // When the public package validator evaluates the complete package.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then the Remote Intelligence Adapter profile is independently validated and passing.
  assert.deepEqual(
    report.checks.find(({id}) => id === 'remote-intelligence-adapter-profile'),
    {id: 'remote-intelligence-adapter-profile', verdict: 'pass', codes: []},
  );
});

test('Remote Intelligence Adapter generation leaves complete package evidence current', async (t) => {
  // Given the committed package after Remote Adapter artifact generation.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));

  // When the public validator evaluates every package binding.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then no post-generation rewrite may leave shared evidence or manifest digests stale.
  assert.equal(report.verdict, 'pass', JSON.stringify(
    report.checks.filter(({verdict}) => verdict !== 'pass'),
  ));
});

test('permitted Remote Intelligence Adapter attempts bind every exact byte to the approved destination', async (t) => {
  // Given permitted primary, retry, and fallback profile fixtures.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const cases = ['permitted-primary-exact-bytes', 'permitted-retry-exact-bytes', 'permitted-fallback-exact-bytes'];

  // When their instrumented attempt observations are read, then every transmitted byte is exact.
  for (const caseId of cases) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`,
    ), 'utf8'));
    const observations = JSON.parse(fixture.subject.document.attempt_observations_json);
    for (const observation of observations) {
      const bytes = Buffer.from(observation.payload_base64, 'base64');
      assert.equal(observation.destination, 'https://api.remote-alpha.test/v1/process');
      assert.equal(observation.transmitted_bytes, bytes.length);
      assert.equal(observation.transmitted_sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(observation.boundary, 'egress_complete');
    }
  }
});

test('Remote Intelligence Adapter pre-egress denials prove zero transmitted bytes', async (t) => {
  // Given every required denial class from issue #47.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const cases = [
    'missing-processing-envelope-denied',
    'stale-policy-binding-denied',
    'malformed-processing-envelope-denied',
    'unsupported-provider-denied',
    'unauthorized-provider-denied',
    'input-budget-exhausted',
    'unapproved-destination-denied',
    'forbidden-retry-denied',
    'forbidden-fallback-denied',
    'failed-credential-boundary-denied',
  ];

  // When the public fixtures expose their receipts, then denial happened before any egress.
  for (const caseId of cases) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`,
    ), 'utf8'));
    const receipt = JSON.parse(fixture.expected.receipts[0]);
    assert.deepEqual(fixture.expected.network_effects, ['none'], caseId);
    assert.ok(receipt.attempts.every((attempt) => attempt.transmitted_bytes === 0 &&
      attempt.destination === null && attempt.boundary === 'pre_egress_denial' &&
      attempt.provider_request_id === null), caseId);
  }
});

test('credential evidence records only the normative prerequisite boundary', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const evidence = JSON.parse(await readFile(resolve(
    packageRoot,
    'contracts/remote-intelligence-adapter/credential-boundary-evidence.json',
  ), 'utf8'));

  assert.equal(evidence.prerequisite, 'satisfied');
  assert.equal(evidence.adapter_visibility, 'none');
  assert.equal(evidence.secret_access, 'none');
  assert.equal(evidence.ambient_configuration, 'unreadable');
  assert.equal(evidence.environment_values, 'unreadable');
  assert.deepEqual(evidence.claims_established, []);
});

test('authentication and transport cannot promote unproven provider facts', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const cases = [
    'authentication-does-not-establish-residency',
    'transport-does-not-establish-training',
    'provider-output-does-not-establish-deletion',
    'retry-does-not-establish-entitlement',
    'fallback-does-not-establish-privacy-behavior',
  ];
  for (const caseId of cases) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`,
    ), 'utf8'));
    const receipt = JSON.parse(fixture.expected.receipts[0]);
    const dimension = fixture.subject.document.provider_fact_claim;
    assert.ok(['unsupported', 'inconclusive'].includes(receipt.provider_fact_statuses[dimension]), caseId);
    assert.ok(fixture.expected.codes.includes('remote.provider_fact_unproven'), caseId);
    assert.equal(fixture.expected.verdict, 'fail', caseId);
  }
});

test('Remote Intelligence Adapter claim fails closed when bound fixture bytes change', async (t) => {
  const check = await remoteCheckAfterMutation(t, async (packageRoot) => {
    const path = resolve(
      packageRoot,
      'conformance/scenarios/remote-intelligence-adapter/permitted-primary-exact-bytes.json',
    );
    const fixture = JSON.parse(await readFile(path, 'utf8'));
    fixture.expected.outputs = ['tampered profile output'];
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  });

  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('remote.claim_material_digest_mismatch'));
});

test('Remote Intelligence Adapter recovery revalidates digests without network operations', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const report = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/evidence/remote-adapter-recovery-report.json',
  ), 'utf8'));

  assert.equal(report.network_operations, 0);
  assert.equal(report.cases.length, 3);
  assert.equal(report.cases[0].claim_digest_revalidated, true);
  assert.equal(report.cases[0].terminal_state, 'recovered');
  assert.ok(report.cases.slice(1).every((entry) =>
    entry.claim_digest_revalidated === false && entry.terminal_state === 'recovery_required'));
});
