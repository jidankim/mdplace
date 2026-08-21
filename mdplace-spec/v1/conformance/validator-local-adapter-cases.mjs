import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {validateAgainstSchemaPath} from './json-schema.mjs';
import {observeLocalAdapterScenario} from './local-adapter-observer.mjs';
import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';

async function localCheckAfterMutation(t, mutate) {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  await mutate(packageRoot);
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);
  return report.checks.find(({id}) => id === 'local-intelligence-adapter-profile');
}

test('committed package proves the independent Local Intelligence Adapter profile', async (t) => {
  // Given the committed specification package with its Local Intelligence Adapter artifacts.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));

  // When the public package validator evaluates the complete package.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then the Local Intelligence Adapter profile is independently validated and passing.
  assert.deepEqual(
    report.checks.find(({id}) => id === 'local-intelligence-adapter-profile'),
    {id: 'local-intelligence-adapter-profile', verdict: 'pass', codes: []},
  );
});

test('Local Intelligence Adapter claim fails closed when capability evidence is unsupported', async (t) => {
  // Given a previously passing package whose required capability fact becomes unsupported.
  const check = await localCheckAfterMutation(t, async (packageRoot) => {
    const path = resolve(packageRoot, 'contracts/local-intelligence-adapter/capability-evidence.json');
    const evidence = JSON.parse(await readFile(path, 'utf8'));
    evidence.status = 'unsupported';
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  });

  // When the public validator resolves the Local Intelligence Adapter claim, then pass is denied.
  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('local.profile_boundary_invalid'));
  assert.ok(check.codes.includes('local.claim_verdict_invalid'));
});

test('Local Intelligence Adapter recovery rejects a tampered exact evidence digest', async (t) => {
  // Given a syntactically valid Claim Manifest with a digest that covers no current evidence.
  const check = await localCheckAfterMutation(t, async (packageRoot) => {
    const path = resolve(packageRoot, 'contracts/local-intelligence-adapter/claim-manifest.json');
    const claim = JSON.parse(await readFile(path, 'utf8'));
    claim.rows[0].evidence_digest = '0'.repeat(64);
    await writeFile(path, `${JSON.stringify(claim, null, 2)}\n`);
  });

  // When the public validator recomputes the digest, then the claim remains non-pass.
  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('local.claim_evidence_digest_mismatch'));
  assert.ok(check.codes.includes('local.recovery_evidence_invalid'));
});

test('Local Intelligence Adapter claim fails closed when isolation evidence is missing', async (t) => {
  // Given a package from which the mandatory Local Intelligence Adapter isolation evidence is absent.
  const check = await localCheckAfterMutation(t, async (packageRoot) => {
    await unlink(resolve(packageRoot, 'contracts/local-intelligence-adapter/isolation-evidence.json'));
  });

  // When the public validator resolves the profile, then absence cannot become a pass.
  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('schema.instance_missing'));
});

test('Local Intelligence Adapter attempts emit the inherited Adapter Run Receipt', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/local-intelligence-adapter/valid-abstention.json',
  ), 'utf8'));
  const receipt = JSON.parse(fixture.expected.receipts[0]);

  assert.equal(receipt.schema_id, 'mdplace.adapter-run-receipt/v1');
  assert.deepEqual(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/adapter-run-receipt.schema.json',
    receipt,
  ), []);
});

test('Local Intelligence Adapter public validator rejects a stale recovery claim digest', async (t) => {
  // Given a persisted recovery record whose claim digest no longer names the current claim bytes.
  const check = await localCheckAfterMutation(t, async (packageRoot) => {
    const path = resolve(packageRoot, 'conformance/evidence/local-adapter-recovery-report.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.cases[0].claim_manifest_sha256 = '0'.repeat(64);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  });

  // When the public package validator evaluates recovery, then it fails closed.
  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('local.observable_mismatch'));
  assert.ok(check.codes.includes('local.recovery_evidence_invalid'));
});

test('Local Intelligence Adapter public validator rejects every mismatched recovery target field', async (t) => {
  const mismatches = [
    ['attempt_id', 'adapter-attempt:lia-999'],
    ['attempt_sequence', 1],
    ['crash_boundary', 'before_receipt'],
  ];
  for (const [field, value] of mismatches) await t.test(field, async (t) => {
    // Given a persisted recovery record naming a different exact target field.
    const check = await localCheckAfterMutation(t, async (packageRoot) => {
      const path = resolve(packageRoot, 'conformance/evidence/local-adapter-recovery-report.json');
      const report = JSON.parse(await readFile(path, 'utf8'));
      report.cases[0][field] = value;
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    });

    // When the public package validator evaluates recovery, then it rejects the wrong target.
    assert.equal(check.verdict, 'fail');
    assert.ok(check.codes.includes('local.observable_mismatch'));
    assert.ok(check.codes.includes('local.recovery_evidence_invalid'));
  });
});

test('Local Intelligence Adapter recovery consumes the persisted external recovery record', async (t) => {
  // Given the committed positive recovery fixture and its report record outside claim material.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/local-intelligence-adapter/recovery-revalidates-current-digests.json',
  ), 'utf8'));
  const recoveryReport = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/evidence/local-adapter-recovery-report.json',
  ), 'utf8'));

  // When recovery is attempted without and then with that persisted external record.
  const withoutRecord = await observeLocalAdapterScenario(fixture.subject, packageRoot);
  const observed = await observeLocalAdapterScenario(
    fixture.subject,
    packageRoot,
    recoveryReport.cases.find(({fixture_id: id}) => id === fixture.fixture_id),
  );

  // Then recovery requires the external record, whose exact bindings permit the committed verdict.
  assert.equal(withoutRecord.verdict, 'fail');
  assert.ok(withoutRecord.codes.includes('local.recovery_claim_digest_mismatch'));
  assert.equal(observed.verdict, 'pass');
  assert.deepEqual(observed.codes, []);
});

test('Local Intelligence Adapter receipt isolation is copied from a digest-bound observation', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/local-intelligence-adapter/valid-abstention.json',
  ), 'utf8'));
  const document = fixture.subject.document;
  assert.equal(
    createHash('sha256').update(document.attempt_observation_json).digest('hex'),
    document.attempt_observation_sha256,
  );
  const observation = JSON.parse(document.attempt_observation_json);
  const receipt = JSON.parse(fixture.expected.receipts[0]);

  assert.equal(receipt.isolation.canary_id, observation.isolation.canary.canary_id);
  assert.equal(
    receipt.isolation.canary_observed_sha256,
    createHash('sha256').update(observation.isolation.canary.observed).digest('hex'),
  );
  assert.deepEqual(receipt.effective_capabilities, observation.isolation.effective_capabilities);
  assert.equal(receipt.observed_started_at, observation.observed_started_at);
  assert.equal(receipt.observed_completed_at, observation.observed_completed_at);
  assert.equal(
    receipt.budget.runtime_ms,
    Date.parse(observation.observed_completed_at) - Date.parse(observation.observed_started_at),
  );
});

test('Local Intelligence Adapter rejects a malformed exact attempt observation without inventing receipt facts', async (t) => {
  const check = await localCheckAfterMutation(t, async (packageRoot) => {
    const path = resolve(
      packageRoot,
      'conformance/scenarios/local-intelligence-adapter/valid-abstention.json',
    );
    const fixture = JSON.parse(await readFile(path, 'utf8'));
    fixture.subject.document.attempt_observation_json = '{';
    fixture.subject.document.attempt_observation_sha256 = createHash('sha256').update('{').digest('hex');
    await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  });

  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('local.observable_mismatch'));
  assert.ok(check.codes.includes('local.receipt_invalid'));
});

test('Local Intelligence Adapter failed canary receipt preserves exact preflight timing', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/local-intelligence-adapter/isolation-canary-failed-denied.json',
  ), 'utf8'));
  const observation = JSON.parse(fixture.subject.document.attempt_observation_json);
  const receipt = JSON.parse(fixture.expected.receipts[0]);

  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_completed_at, observation.observed_completed_at);
  assert.equal(
    receipt.budget.runtime_ms,
    Date.parse(observation.observed_completed_at) - Date.parse(observation.observed_started_at),
  );
});

test('Local Intelligence Adapter lifecycle tables make every declared state reachable', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const names = ['capability', 'isolation', 'verdict', 'failure', 'recovery'];
  for (const name of names) {
    const table = JSON.parse(await readFile(resolve(
      packageRoot,
      `contracts/transitions/local-adapter-${name}-lifecycle.json`,
    ), 'utf8'));
    const reachable = new Set([table.states[0]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table.transitions) {
        if (row.allowed && reachable.has(row.from_state) && !reachable.has(row.terminal_state)) {
          reachable.add(row.terminal_state);
          changed = true;
        }
      }
    }
    assert.deepEqual([...reachable].sort(), [...table.states].sort(), name);
  }
});

test('Local Intelligence Adapter evidence outcomes are derived from bound bytes', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const cases = new Map([
    ['missing-capability-evidence-denied', 'local.capability_fact_missing'],
    ['stale-capability-evidence-denied', 'local.capability_fact_stale'],
    ['malformed-capability-evidence-denied', 'local.capability_fact_malformed'],
  ]);
  for (const [caseId, expectedCode] of cases) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/local-intelligence-adapter/${caseId}.json`,
    ), 'utf8'));
    assert.equal(Object.hasOwn(fixture.subject.document, 'capability_status'), false);
    const observed = await observeLocalAdapterScenario(fixture.subject, packageRoot);
    assert.ok(observed.codes.includes(expectedCode), caseId);
  }
});
