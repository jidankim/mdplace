import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {
  deriveRemoteAdapterVerdict,
  remoteAdapterClaimCodes,
} from './remote-adapter-claim-validation.mjs';
import {
  remoteAdapterEvidenceDigest,
  remoteSha256,
} from './remote-adapter-core.mjs';
import {observeRemoteAdapterScenario} from './remote-adapter-observer.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
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
  // Given the committed package after Remote Intelligence Adapter artifact generation.
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
    const authorized = fixture.subject.document.authorized_attempts;
    assert.equal(authorized.length, observations.length, caseId);
    for (const [index, observation] of observations.entries()) {
      const bytes = Buffer.from(observation.payload_base64, 'base64');
      assert.equal(bytes.toString('utf8'), authorized[index].processing_envelope_json, caseId);
      assert.equal(observation.attempt_id, authorized[index].attempt_id, caseId);
      assert.equal(observation.attempt_sequence, index, caseId);
      assert.equal(observation.attempt_kind, authorized[index].attempt_kind, caseId);
      assert.equal(observation.destination, 'https://api.remote-alpha.test/v1/process');
      assert.equal(observation.transmitted_bytes, bytes.length);
      assert.equal(observation.transmitted_sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(observation.boundary, 'egress_complete');
      const envelope = JSON.parse(authorized[index].processing_envelope_json);
      assert.deepEqual(envelope.ceilings, {
        input_bytes: 4096,
        output_bytes: 3000,
        runtime_ms: 800,
        cost_microunits: 5000,
      });
      assert.equal(envelope.retention_facts[0].status, 'unknown_acknowledged');
      assert.equal(envelope.retention_facts[0].region, 'unsupported');
    }
  }
});

test('self-consistent bytes are denied when they differ from the authorized Processing Envelope', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/remote-intelligence-adapter/permitted-primary-exact-bytes.json',
  ), 'utf8'));
  const scenario = structuredClone(fixture.subject.document);
  const observations = JSON.parse(scenario.attempt_observations_json);
  const payload = canonicalJson({not: 'the authorized Processing Envelope'});
  observations[0].payload_base64 = Buffer.from(payload).toString('base64');
  observations[0].transmitted_bytes = Buffer.byteLength(payload);
  observations[0].transmitted_sha256 = remoteSha256(payload);
  scenario.attempt_observations_json = canonicalJson(observations);
  scenario.attempt_observations_sha256 = remoteSha256(scenario.attempt_observations_json);

  const observed = await observeRemoteAdapterScenario(
    {kind: 'remote_intelligence_adapter', document: scenario},
    packageRoot,
  );

  assert.ok(observed.codes.includes('remote.transmitted_payload_mismatch'));
  assert.equal(observed.verdict, 'fail');
});

test('attempt topology binds distinct initial, retry, and fallback authorizations', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const cases = new Map([
    ['permitted-primary-exact-bytes', ['initial']],
    ['permitted-retry-exact-bytes', ['initial', 'retry']],
    ['permitted-fallback-exact-bytes', ['initial', 'fallback']],
    ['exact-attempt-ceiling', ['initial', 'retry', 'fallback']],
  ]);
  for (const [caseId, expectedKinds] of cases) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/remote-intelligence-adapter/${caseId}.json`,
    ), 'utf8'));
    const observations = JSON.parse(fixture.subject.document.attempt_observations_json);
    assert.deepEqual(observations.map(({attempt_kind: kind}) => kind), expectedKinds, caseId);
    assert.equal(new Set(observations.map(({attempt_id: id}) => id)).size, observations.length, caseId);
    assert.deepEqual(observations.map(({attempt_sequence: sequence}) => sequence),
      expectedKinds.map((_, index) => index), caseId);
    assert.deepEqual(fixture.subject.document.authorized_attempts.map(({authorization_id: id}) => id),
      expectedKinds.map((kind) => `adapter-authorization:remote-${kind === 'initial' ? 'primary' : kind}`), caseId);
  }
});

test('fallback advances to the next pre-authorized adapter in the ordered chain', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const profile = JSON.parse(await readFile(resolve(
    packageRoot,
    'contracts/remote-intelligence-adapter/profile.json',
  ), 'utf8'));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/remote-intelligence-adapter/permitted-fallback-exact-bytes.json',
  ), 'utf8'));
  const envelopes = fixture.subject.document.authorized_attempts
    .map(({processing_envelope_json: json}) => JSON.parse(json));

  assert.equal(profile.adapter_chain.length, 2);
  assert.equal(envelopes[0].bindings.adapter_id, profile.adapter_chain[0].adapter_id);
  assert.equal(envelopes[1].bindings.adapter_id, profile.adapter_chain[1].adapter_id);
  assert.equal(envelopes[1].bindings.model_id, profile.adapter_chain[1].model_id);
  assert.notEqual(envelopes[1].bindings.adapter_id, envelopes[0].bindings.adapter_id);
  assert.notEqual(envelopes[1].bindings.model_id, envelopes[0].bindings.model_id);
  assert.equal(envelopes[1].destination.endpoint, profile.adapter_chain[1].endpoint);
});

test('operation must agree with the authorized attempt topology', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/remote-intelligence-adapter/permitted-primary-exact-bytes.json',
  ), 'utf8'));
  const scenario = structuredClone(fixture.subject.document);
  scenario.operation = 'retry';

  const observed = await observeRemoteAdapterScenario(
    {kind: 'remote_intelligence_adapter', document: scenario},
    packageRoot,
  );

  assert.ok(observed.codes.includes('remote.attempt_topology_invalid'));
  assert.equal(observed.verdict, 'fail');
});

test('unknown egress completion always enters recovery', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/remote-intelligence-adapter/permitted-primary-exact-bytes.json',
  ), 'utf8'));
  const scenario = structuredClone(fixture.subject.document);
  const observations = JSON.parse(scenario.attempt_observations_json);
  observations[0].boundary = 'egress_completion_unknown';
  observations[0].provider_request_id = null;
  scenario.attempt_observations_json = canonicalJson(observations);
  scenario.attempt_observations_sha256 = remoteSha256(scenario.attempt_observations_json);

  const observed = await observeRemoteAdapterScenario(
    {kind: 'remote_intelligence_adapter', document: scenario},
    packageRoot,
  );
  const receipt = JSON.parse(observed.receipts[0]);

  assert.ok(observed.codes.includes('remote.recovery_required'));
  assert.equal(receipt.outcome, 'recovery_required');
  assert.equal(observed.verdict, 'fail');
});

test('duplicate Remote Intelligence Adapter attempt identity is denied', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/remote-intelligence-adapter/permitted-retry-exact-bytes.json',
  ), 'utf8'));
  const scenario = structuredClone(fixture.subject.document);
  const observations = JSON.parse(scenario.attempt_observations_json);
  observations[1].attempt_id = observations[0].attempt_id;
  scenario.attempt_observations_json = canonicalJson(observations);
  scenario.attempt_observations_sha256 = remoteSha256(scenario.attempt_observations_json);

  const observed = await observeRemoteAdapterScenario(
    {kind: 'remote_intelligence_adapter', document: scenario},
    packageRoot,
  );

  assert.ok(observed.codes.includes('remote.attempt_topology_invalid'));
  assert.equal(observed.verdict, 'fail');
});

test('every illegal-transition fixture targets a real denied table cell', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  for (const name of ['permitted-egress', 'denial', 'failure', 'retry', 'fallback', 'recovery', 'verdict']) {
    const fixture = JSON.parse(await readFile(resolve(
      packageRoot,
      `conformance/scenarios/remote-intelligence-adapter/illegal-${name}-transition-denied.json`,
    ), 'utf8'));
    const [path, pair] = fixture.subject.document.transition_ref.split('#');
    const table = JSON.parse(await readFile(resolve(packageRoot, path), 'utf8'));
    const row = table.transitions.find(({from_state: state, command_or_event: command}) =>
      `${state}:${command}` === pair);
    assert.equal(row?.allowed, false, `${name}:${pair}`);
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

test('disclosed retention facts resolve to packaged evidence while other facts remain unproven', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const evidence = JSON.parse(await readFile(resolve(
    packageRoot,
    'contracts/remote-intelligence-adapter/retention-evidence.json',
  ), 'utf8'));
  const disclosed = evidence.facts.filter(({status}) => status === 'disclosed');
  assert.deepEqual(disclosed.map(({dimension}) => dimension), ['retention']);
  const artifact = await readFile(resolve(packageRoot, disclosed[0].evidence_ref));
  assert.equal(remoteSha256(artifact), disclosed[0].evidence_sha256);
  assert.ok(evidence.facts.filter(({dimension}) => dimension !== 'retention')
    .every(({status}) => ['unsupported', 'inconclusive'].includes(status)));
});

test('Remote Intelligence Adapter claim verdict is derived from mandatory evidence', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const claim = JSON.parse(await readFile(resolve(
    packageRoot,
    'contracts/remote-intelligence-adapter/claim-manifest.json',
  ), 'utf8'));
  const evidencePath = resolve(packageRoot, 'conformance/evidence/remote-adapter-evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(await deriveRemoteAdapterVerdict(evidence, packageRoot), 'pass');
  assert.equal(await deriveRemoteAdapterVerdict({...evidence, network_operations: 1}, packageRoot), 'fail');
  assert.equal(await deriveRemoteAdapterVerdict({...evidence, fixture_bindings: []}, packageRoot), 'unsupported');
  const missingNetworkEvidence = structuredClone(evidence);
  delete missingNetworkEvidence.network_operations;
  assert.equal(await deriveRemoteAdapterVerdict(missingNetworkEvidence, packageRoot), 'unsupported');
  const wrongFixtureDigestEvidence = structuredClone(evidence);
  wrongFixtureDigestEvidence.fixture_bindings[0].fixture_sha256 = '0'.repeat(64);
  assert.equal(await deriveRemoteAdapterVerdict(wrongFixtureDigestEvidence, packageRoot), 'fail');
  assert.equal(await deriveRemoteAdapterVerdict({
    ...evidence,
    receipt_sha256s: evidence.receipt_sha256s.slice(1),
  }, packageRoot),
    'inconclusive');
  for (const verdict of ['fail', 'unsupported', 'inconclusive']) {
    const mutated = structuredClone(claim);
    mutated.rows[0].verdict = verdict;
    assert.ok((await remoteAdapterClaimCodes(mutated, packageRoot))
      .includes('remote.claim_verdict_invalid'), verdict);
  }

  const genericPath = resolve(packageRoot, 'conformance/claim-manifests/remote-intelligence-adapter.json');
  const generic = JSON.parse(await readFile(genericPath, 'utf8'));
  generic.verdict = 'unsupported';
  generic.evidence_bindings[0].verdict = 'unsupported';
  await writeFile(genericPath, `${JSON.stringify(generic, null, 2)}\n`);
  assert.ok((await remoteAdapterClaimCodes(claim, packageRoot))
    .includes('remote.claim_verdict_invalid'));
});

test('coordinated verdict labels cannot override independently derived evidence', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const claimPath = resolve(packageRoot, 'contracts/remote-intelligence-adapter/claim-manifest.json');
  const evidencePath = resolve(packageRoot, 'conformance/evidence/remote-adapter-evidence.json');
  const genericPath = resolve(packageRoot, 'conformance/claim-manifests/remote-intelligence-adapter.json');
  const envelopePath = resolve(packageRoot, 'conformance/evidence/envelopes/remote-adapter-profile.json');
  const claim = JSON.parse(await readFile(claimPath, 'utf8'));
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const generic = JSON.parse(await readFile(genericPath, 'utf8'));
  const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));

  evidence.verdict = 'unsupported';
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, evidenceBytes);
  const materialEntry = claim.rows[0].evidence_material.find(
    ({path}) => path === 'conformance/evidence/remote-adapter-evidence.json',
  );
  materialEntry.sha256 = remoteSha256(evidenceBytes);
  claim.rows[0].evidence_digest = remoteAdapterEvidenceDigest(claim.rows[0].evidence_material);
  claim.rows[0].verdict = 'unsupported';
  generic.verdict = 'unsupported';
  generic.evidence_bindings[0].verdict = 'unsupported';
  envelope.verdict = 'unsupported';
  await Promise.all([
    writeFile(genericPath, `${JSON.stringify(generic, null, 2)}\n`),
    writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`),
  ]);

  assert.ok((await remoteAdapterClaimCodes(claim, packageRoot))
    .includes('remote.claim_verdict_invalid'));
});

test('valid-format wrong mandatory digests cannot earn a passing claim', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const claimPath = resolve(packageRoot, 'contracts/remote-intelligence-adapter/claim-manifest.json');
  const evidencePath = resolve(packageRoot, 'conformance/evidence/remote-adapter-evidence.json');
  const claim = JSON.parse(await readFile(claimPath, 'utf8'));
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

  evidence.fixture_bindings[0].fixture_sha256 = '0'.repeat(64);
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidencePath, evidenceBytes);
  const materialEntry = claim.rows[0].evidence_material.find(
    ({path}) => path === 'conformance/evidence/remote-adapter-evidence.json',
  );
  materialEntry.sha256 = remoteSha256(evidenceBytes);
  claim.rows[0].evidence_digest = remoteAdapterEvidenceDigest(claim.rows[0].evidence_material);

  assert.ok((await remoteAdapterClaimCodes(claim, packageRoot))
    .includes('remote.claim_verdict_invalid'));
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
