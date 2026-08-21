import assert from 'node:assert/strict';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';
import {codexReceiptMatchesScenario, codexSha256} from './codex-adapter-core.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {codexAdapterRecoveryRecord, observeCodexAdapterScenario} from './codex-adapter-observer.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

function rebindProof(document, kind, proof) {
  const proofJson = canonicalJson(proof);
  const proofSha256 = codexSha256(proofJson);
  document[`${kind}_json`] = proofJson;
  document[`${kind}_sha256`] = proofSha256;
  const boundary = JSON.parse(document.boundary_json);
  boundary[`${kind}_proof_sha256`] = proofSha256;
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);
}

function rebindEnvelope(document, envelope) {
  document.processing_envelope_json = canonicalJson(envelope);
  document.processing_envelope_sha256 = codexSha256(document.processing_envelope_json);
  const boundary = JSON.parse(document.boundary_json);
  boundary.processing_envelope_sha256 = document.processing_envelope_sha256;
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);
}

function recordZeroTransmission(document) {
  document.transmitted_bytes = 0;
  document.transmitted_sha256 = codexSha256(Buffer.alloc(0));
  document.attempt_observation.provider_request_id = null;
}

async function validFixture(t) {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const path = resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/valid-noninteractive-proposal.json');
  return {packageRoot, fixture: JSON.parse(await readFile(path, 'utf8'))};
}

test('valid Codex fixture crosses the closed boundary as inert advice', async (t) => {
  // Given a positive Codex fixture at the public schema and observer seams.
  const {packageRoot, fixture} = await validFixture(t);
  const boundary = JSON.parse(fixture.subject.document.boundary_json);
  const proposal = JSON.parse(fixture.subject.document.raw_output);

  // When the boundary and resulting receipt are validated.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);
  const boundaryCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-boundary.schema.json',
    boundary,
  ));
  const proposalCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/intelligence-proposal.schema.json',
    proposal,
  ));
  const receiptCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-receipt.schema.json',
    receipt,
  ));
  const inheritedReceiptCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/adapter-run-receipt.schema.json',
    receipt,
  ));

  // Then the fixture is accepted as inert advice through closed, schema-valid artifacts.
  assert.equal(boundaryCode, null);
  assert.equal(proposalCode, null);
  assert.equal(receiptCode, null);
  assert.equal(inheritedReceiptCode, null);
  const approvedEnvelope = await readFile(resolve(packageRoot, 'contracts/codex-intelligence-adapter/approved-processing-envelope.json'));
  assert.equal(boundary.approved_processing_envelope_ref, 'contracts/codex-intelligence-adapter/approved-processing-envelope.json');
  assert.equal(boundary.approved_processing_envelope_sha256, codexSha256(approvedEnvelope));
  assert.equal(boundary.processing_envelope_sha256, fixture.subject.document.processing_envelope_sha256);
  assert.deepEqual(observed.codes, []);
  assert.equal(observed.terminal_state, 'accepted');
  assert.deepEqual(observed.filesystem_effects, ['none']);
});

test('Codex invocation contract closes the host-controlled process boundary', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const boundary = JSON.parse(document.boundary_json);
  const invocationPath = resolve(packageRoot, 'contracts/codex-intelligence-adapter/invocation-contract.json');
  const invocationBytes = await readFile(invocationPath);
  const invocation = JSON.parse(invocationBytes);
  const outputSchemaBytes = await readFile(resolve(packageRoot, invocation.output.schema_ref));
  const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-invocation-contract.schema.json',
    invocation,
  ));

  assert.equal(schemaCode, null);
  assert.equal(boundary.interface.invocation_contract_ref, 'contracts/codex-intelligence-adapter/invocation-contract.json');
  assert.equal(boundary.invocation_contract_sha256, codexSha256(invocationBytes));
  assert.equal(boundary.output_schema_sha256, codexSha256(outputSchemaBytes));
  assert.deepEqual(invocation.argv.slice(0, 4), ['exec', '--skip-git-repo-check', '--ephemeral', '--json']);
  assert.equal(invocation.argv.at(-1), '$MDPLACE_TRUSTED_INSTRUCTION');
  assert.equal(invocation.trusted_instruction.captured_content_permitted, false);
  assert.equal(invocation.stdin.framing, 'separate_stdin_context');
  assert.equal(invocation.output.schema_sha256, boundary.output_schema_sha256);
  assert.equal(invocation.output.host_output_file, false);
  assert.equal(invocation.configuration.user_config, 'ignored');
  assert.equal(invocation.configuration.rules, 'ignored');
  assert.equal(invocation.environment.codex_home, 'dedicated_minimal');
  assert.equal(invocation.environment.vault_mounted, false);
});

test('Codex invocation contract mutations deny before transmission', async (t) => {
  const mutations = [
    ['argv', (contract) => contract.argv.splice(contract.argv.indexOf('--ephemeral'), 1), 'codex.invocation_contract_malformed'],
    ['trusted prompt', (contract) => { contract.trusted_instruction.captured_content_permitted = true; }, 'codex.invocation_contract_malformed'],
    ['minimal CODEX_HOME', (contract) => { contract.environment.codex_home = 'ambient'; }, 'codex.invocation_contract_malformed'],
    ['output schema', (contract) => { contract.output.schema_sha256 = '0'.repeat(64); }, 'codex.invocation_contract_binding_mismatch'],
  ];
  for (const [label, mutate, expectedCode] of mutations) {
    await t.test(label, async (child) => {
      const {packageRoot, fixture} = await validFixture(child);
      const document = fixture.subject.document;
      const path = resolve(packageRoot, 'contracts/codex-intelligence-adapter/invocation-contract.json');
      const contract = JSON.parse(await readFile(path, 'utf8'));
      mutate(contract);
      await writeFile(path, `${JSON.stringify(contract, null, 2)}\n`);
      const boundary = JSON.parse(document.boundary_json);
      boundary.invocation_contract_sha256 = codexSha256(await readFile(path));
      document.boundary_json = canonicalJson(boundary);
      document.boundary_sha256 = codexSha256(document.boundary_json);
      recordZeroTransmission(document);

      const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
      const receipt = JSON.parse(observed.receipts[0]);

      assert.deepEqual(observed.codes, [expectedCode]);
      assert.equal(observed.terminal_state, 'denied');
      assert.equal(receipt.transmitted_bytes, 0);
      assert.deepEqual(observed.network_effects, ['none']);
    });
  }
});

test('non-canonical payload Base64 denies before transmission', async (t) => {
  // Given an otherwise valid fixture whose payload has trailing non-Base64 data.
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.payload_base64 += '!';
  recordZeroTransmission(document);

  // When both public validation seams inspect the malformed payload.
  const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-scenario.schema.json',
    document,
  ));
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then neither seam decodes it as the approved bytes or permits egress.
  assert.notEqual(schemaCode, null);
  assert.deepEqual(observed.codes, ['codex.payload_digest_mismatch']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('extra Processing Envelope field and segment deny before transmission', async (t) => {
  // Given an otherwise valid fixture with a second, undeclared payload segment.
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const envelope = JSON.parse(document.processing_envelope_json);
  const extraPayload = 'undeclared neighboring note';
  envelope.transmitted_fields.push({
    field_id: 'field:neighbor-note', data_class: 'data:source-content',
    segment_id: 'segment:cdx-001-neighbor-note', redaction_receipt_sha256: '4a1b52bf2f36e1bc834b20df223c921abb8ea01bb0d673bb08da5d4e6bfda807',
  });
  envelope.payload_segments.push({
    segment_id: 'segment:cdx-001-neighbor-note', field_id: 'field:neighbor-note', utf8: extraPayload,
    byte_length: Buffer.byteLength(extraPayload), sha256: codexSha256(extraPayload),
  });
  rebindEnvelope(document, envelope);
  recordZeroTransmission(document);

  // When the public observer evaluates every bound segment.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then the extra field is denied before any bytes are transmitted.
  assert.deepEqual(observed.codes, ['codex.unapproved_payload']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('schema-valid Processing Envelope purpose mutation denies before transmission', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const envelope = JSON.parse(document.processing_envelope_json);
  envelope.purpose_id = 'purpose:unapproved';
  rebindEnvelope(document, envelope);
  recordZeroTransmission(document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.unapproved_purpose']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('attempt boundary binds the exact approved Processing Envelope artifact digest', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const boundary = JSON.parse(document.boundary_json);
  boundary.approved_processing_envelope_sha256 = '0'.repeat(64);
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);
  recordZeroTransmission(document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.stale_processing_envelope']);
  assert.equal(observed.terminal_state, 'denied');
});

test('global precedence selects purpose denial before contradictory timing', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const envelope = JSON.parse(document.processing_envelope_json);
  envelope.purpose_id = 'purpose:unapproved';
  rebindEnvelope(document, envelope);
  recordZeroTransmission(document);
  document.attempt_observation.observed_completed_at = document.attempt_observation.observed_started_at;

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.unapproved_purpose']);
  assert.deepEqual(observed.receipts, []);
});

test('receipt preserves exact equivalent-offset observation timestamps', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.attempt_observation.observed_started_at = '2026-08-23T09:01:00.000+09:00';
  document.attempt_observation.observed_completed_at = '2026-08-23T09:01:00.250+09:00';

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, []);
  assert.equal(receipt.observed_started_at, document.attempt_observation.observed_started_at);
  assert.equal(receipt.observed_completed_at, document.attempt_observation.observed_completed_at);
  assert.equal(codexReceiptMatchesScenario(receipt, document), true);
});

test('combined stale envelope and extra payload use global precedence', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  const envelope = JSON.parse(document.processing_envelope_json);
  envelope.bindings.policy.sha256 = '0'.repeat(64);
  envelope.transmitted_fields.push({
    field_id: 'field:neighbor-note', data_class: 'data:source-content',
    segment_id: 'segment:cdx-001-neighbor-note', redaction_receipt_sha256: '4a1b52bf2f36e1bc834b20df223c921abb8ea01bb0d673bb08da5d4e6bfda807',
  });
  envelope.payload_segments.push({
    segment_id: 'segment:cdx-001-neighbor-note', field_id: 'field:neighbor-note', utf8: 'neighbor',
    byte_length: 8, sha256: codexSha256('neighbor'),
  });
  rebindEnvelope(document, envelope);
  recordZeroTransmission(document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.stale_processing_envelope']);
});

test('malformed Processing Envelope returns a deterministic fail-closed observation', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.processing_envelope_json = '{';
  document.processing_envelope_sha256 = codexSha256(document.processing_envelope_json);
  const boundary = JSON.parse(document.boundary_json);
  boundary.processing_envelope_sha256 = document.processing_envelope_sha256;
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);
  recordZeroTransmission(document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.processing_envelope_malformed']);
  assert.equal(observed.terminal_state, 'denied');
  assert.deepEqual(observed.receipts, []);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('malformed Processing Envelope preserves observed nonzero network effects', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.processing_envelope_json = '{';
  document.processing_envelope_sha256 = codexSha256(document.processing_envelope_json);
  const boundary = JSON.parse(document.boundary_json);
  boundary.processing_envelope_sha256 = document.processing_envelope_sha256;
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const denial = JSON.parse(observed.observations.at(-1));

  assert.deepEqual(observed.codes, ['codex.processing_envelope_malformed']);
  assert.equal(observed.terminal_state, 'rejected');
  assert.deepEqual(observed.receipts, []);
  assert.deepEqual(observed.network_effects, [`transmitted ${document.transmitted_bytes} exact bytes to ${document.requested_destination}`]);
  assert.equal(denial.transmitted_bytes, document.transmitted_bytes);
});

test('failed attempt isolation observation denies before transmission', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const isolation = fixture.subject.document.attempt_observation.isolation;
  isolation.ephemeral = false;
  isolation.fresh_process = false;
  isolation.filesystem = 'present';
  isolation.tools = 'present';
  isolation.ambient_configuration = 'readable';
  recordZeroTransmission(fixture.subject.document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.isolation_unavailable']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
});

test('failed attempt isolation canary denies before transmission', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  fixture.subject.document.attempt_observation.isolation.canary.passed = false;
  fixture.subject.document.attempt_observation.isolation.canary.observed = 'unavailable';
  recordZeroTransmission(fixture.subject.document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.isolation_canary_failed']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
});

test('global precedence selects capability denial before credential denial', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.authentication_json = null;
  document.authentication_sha256 = null;
  document.capability_json = null;
  document.capability_sha256 = null;
  recordZeroTransmission(document);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.capability_proof_missing']);
  assert.equal(observed.terminal_state, 'denied');
});

test('recovery preserves a freshly rebound stale capability proof', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const path = resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/recovery-revalidates-current-bindings.json');
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  const document = fixture.subject.document;
  const capability = JSON.parse(document.capability_json);
  capability.status = 'stale';
  rebindProof(document, 'capability', capability);
  const recovery = await codexAdapterRecoveryRecord(fixture.fixture_id, packageRoot);

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot, recovery);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.capability_proof_stale']);
  assert.equal(observed.terminal_state, 'recovery_required');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('preflight failure preserves contradictory observed transmission evidence', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.capability_json = null;
  document.capability_sha256 = null;

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);
  const denial = JSON.parse(observed.observations.at(-1));

  assert.deepEqual(observed.codes, ['codex.transmitted_before_authorization']);
  assert.equal(observed.terminal_state, 'rejected');
  assert.equal(receipt.transmitted_bytes, document.transmitted_bytes);
  assert.equal(receipt.observed_destination, document.requested_destination);
  assert.equal(denial.boundary, 'post_response_validation');
});

test('postflight failures use the shared global precedence', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.output_kind = 'tool_request';
  document.runtime_ms = 801;
  const started = Date.parse(document.attempt_observation.observed_started_at);
  document.attempt_observation.observed_completed_at = new Date(started + document.runtime_ms).toISOString();

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.tool_request_denied']);
  assert.equal(receipt.reason, 'adapter.tool_request_denied');
});

test('global precedence selects filesystem authority denial before malformed output', async (t) => {
  const {packageRoot, fixture} = await validFixture(t);
  const document = fixture.subject.document;
  document.output_kind = 'malformed';
  document.raw_output = '{';
  document.output_bytes = 1;
  document.claimed_authority = 'filesystem';

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.filesystem_authority_denied']);
  assert.equal(receipt.reason, 'adapter.filesystem_authority_denied');
});

test('crash before transmission preserves zero-byte recovery evidence', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/codex-intelligence-adapter/crash-before-transmission-zero-bytes.json',
  ), 'utf8'));

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.crash_before_transmission']);
  assert.equal(observed.terminal_state, 'recovery_required');
  assert.equal(receipt.reason, 'adapter.recovery_unknown_completion');
  assert.equal(receipt.outcome, 'recovery_required');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.transmission_sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('contradictory timing outranks crash recovery terminal state', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/codex-intelligence-adapter/crash-before-transmission-zero-bytes.json',
  ), 'utf8'));
  const document = fixture.subject.document;
  document.attempt_observation.observed_completed_at = document.attempt_observation.observed_started_at;

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  assert.deepEqual(observed.codes, ['codex.output_measurement_mismatch']);
  assert.equal(observed.terminal_state, 'denied');
  assert.deepEqual(observed.receipts, []);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('crash-before label cannot contradict observed transmitted bytes', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/codex-intelligence-adapter/crash-before-transmission-zero-bytes.json',
  ), 'utf8'));
  const document = fixture.subject.document;
  document.transmitted_bytes = document.payload_bytes;
  document.transmitted_sha256 = document.payload_sha256;
  document.attempt_observation.provider_request_id = 'provider-request:cdx-062';

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.output_measurement_mismatch']);
  assert.equal(observed.terminal_state, 'rejected');
  assert.equal(receipt.transmitted_bytes, document.transmitted_bytes);
  assert.deepEqual(observed.network_effects, [`transmitted ${document.transmitted_bytes} exact bytes to ${document.requested_destination}`]);
});

test('successful recovery preserves a protocol-valid exact target receipt', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/recovery-revalidates-current-bindings.json'),
    'utf8',
  ));
  const recovery = await codexAdapterRecoveryRecord(fixture.fixture_id, packageRoot);
  const protocol = JSON.parse(await readFile(resolve(packageRoot, 'contracts/intelligence-adapter/protocol-rules.json'), 'utf8'));

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot, recovery);
  const receipt = JSON.parse(observed.receipts[0]);
  const rule = protocol.outcome_precedence.find(({code}) => code === receipt.reason);

  assert.equal(receipt.receipt_sha256, recovery.target_receipt_sha256);
  assert.equal(receipt.outcome, rule.outcome);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('malformed recovery fixture manifest fails closed at the public observer seam', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/codex-intelligence-adapter/recovery-revalidates-current-bindings.json',
  ), 'utf8'));
  const recovery = await codexAdapterRecoveryRecord(fixture.fixture_id, packageRoot);
  await writeFile(resolve(packageRoot, 'contracts/codex-intelligence-adapter/fixture-manifest.json'), '{}\n');

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot, recovery);

  assert.deepEqual(observed.codes, ['codex.recovery_binding_stale']);
  assert.equal(observed.terminal_state, 'recovery_required');
});

test('recovery rejects and reports any newly transmitted bytes', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(resolve(
    packageRoot,
    'conformance/scenarios/codex-intelligence-adapter/recovery-revalidates-current-bindings.json',
  ), 'utf8'));
  const document = fixture.subject.document;
  const recovery = await codexAdapterRecoveryRecord(fixture.fixture_id, packageRoot);
  document.transmitted_bytes = document.payload_bytes;
  document.transmitted_sha256 = document.payload_sha256;
  document.attempt_observation.provider_request_id = 'provider-request:cdx-065';

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot, recovery);
  const receipt = JSON.parse(observed.receipts[0]);

  assert.deepEqual(observed.codes, ['codex.transmitted_before_authorization']);
  assert.equal(observed.terminal_state, 'recovery_required');
  assert.equal(receipt.transmitted_bytes, document.transmitted_bytes);
  assert.equal(receipt.observed_destination, document.requested_destination);
  assert.deepEqual(observed.network_effects, [`transmitted ${document.transmitted_bytes} exact bytes to ${document.requested_destination}`]);
});

test('illegal Codex lifecycle fixture is valid input and an observed denial', async (t) => {
  // Given a closed fixture for a forbidden capability-proof transition.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/illegal-capability-proof-transition-denied.json'),
    'utf8',
  ));

  // When the scenario schema and public observer evaluate the declared transition.
  const scenarioCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-scenario.schema.json',
    fixture.subject.document,
  ));
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  // Then the fixture itself is valid while the lifecycle operation fails closed.
  assert.equal(scenarioCode, null);
  assert.deepEqual(observed.codes, ['codex.illegal_transition']);
  assert.equal(observed.terminal_state, 'denied');
  assert.deepEqual(observed.network_effects, ['none']);
});

test('illegal transition cannot conceal observed transmitted bytes', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/illegal-capability-proof-transition-denied.json'),
    'utf8',
  ));
  const document = fixture.subject.document;
  document.transmitted_bytes = document.payload_bytes;
  document.transmitted_sha256 = document.payload_sha256;
  document.attempt_observation.provider_request_id = 'provider-request:cdx-067';

  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const denial = JSON.parse(observed.observations.at(-1));

  assert.deepEqual(observed.codes, ['codex.transmitted_before_authorization']);
  assert.equal(observed.terminal_state, 'rejected');
  assert.equal(denial.boundary, 'post_response_validation');
  assert.equal(denial.transmitted_bytes, document.transmitted_bytes);
  assert.deepEqual(observed.network_effects, [`transmitted ${document.transmitted_bytes} exact bytes to ${document.requested_destination}`]);
});

test('expired current-labelled Codex proof denies before transmission', async (t) => {
  // Given a capability proof whose status says current but whose validity window has ended.
  const {packageRoot, fixture} = await validFixture(t);
  const capability = JSON.parse(fixture.subject.document.capability_json);
  capability.expires_at = '2000-01-01T00:00:00.000Z';
  rebindProof(fixture.subject.document, 'capability', capability);
  recordZeroTransmission(fixture.subject.document);

  // When the public observer evaluates the self-consistent but expired proof.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then expiry is treated as stale before any payload byte can leave the boundary.
  assert.deepEqual(observed.codes, ['codex.capability_proof_stale']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('capability proof missing one disabled feature denies before transmission', async (t) => {
  // Given a current, re-digested capability proof that omits one required deny-set member.
  const {packageRoot, fixture} = await validFixture(t);
  const capability = JSON.parse(fixture.subject.document.capability_json);
  capability.disabled_capability_features = capability.disabled_capability_features.slice(1);
  rebindProof(fixture.subject.document, 'capability', capability);
  recordZeroTransmission(fixture.subject.document);

  // When the public observer validates the exact capability proof.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then incomplete capability evidence fails closed before transmission.
  assert.deepEqual(observed.codes, ['codex.capability_proof_malformed']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('network proof without the exact observed destination denies before transmission', async (t) => {
  // Given a network proof that names the allowlist destination but never observes it.
  const {packageRoot, fixture} = await validFixture(t);
  const network = JSON.parse(fixture.subject.document.network_json);
  network.observed_payload_destinations = [];
  rebindProof(fixture.subject.document, 'network', network);
  recordZeroTransmission(fixture.subject.document);

  // When the public observer evaluates the incomplete network proof.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then the missing observation fails closed before transmission.
  assert.deepEqual(observed.codes, ['codex.network_proof_malformed']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.observed_destination, null);
});

test('actual Codex output bytes cannot be hidden by a smaller declared counter', async (t) => {
  // Given a schema-valid proposal whose actual bytes exceed the ceiling while its counter remains below it.
  const {packageRoot, fixture} = await validFixture(t);
  const proposal = JSON.parse(fixture.subject.document.raw_output);
  proposal.rationale = `${proposal.rationale}${'x'.repeat(5000)}`;
  fixture.subject.document.raw_output = canonicalJson(proposal);

  // When the public observer measures the actual returned bytes.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then the real byte length wins and the response is rejected without effects.
  assert.deepEqual(observed.codes, ['codex.output_limit_exceeded']);
  assert.equal(observed.terminal_state, 'rejected');
  assert.ok(receipt.transmitted_bytes > 0);
  assert.deepEqual(receipt.semantic_effects, []);
  assert.deepEqual(receipt.filesystem_effects, []);
});

async function forgedRecoveryProfile(t, mutate) {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const path = resolve(packageRoot, 'conformance/evidence/codex-adapter-recovery-report.json');
  const recovery = JSON.parse(await readFile(path, 'utf8'));
  mutate(recovery.cases[0]);
  await writeFile(path, `${JSON.stringify(recovery, null, 2)}\n`);
  const report = JSON.parse(runPreparedPackage(packageRoot).stdout);
  return report.checks.find(({id}) => id === 'codex-intelligence-adapter-profile');
}

test('recovery report terminal state must match the observed fixture result', async (t) => {
  const profile = await forgedRecoveryProfile(t, (recoveryCase) => {
    recoveryCase.terminal_state = 'recovered';
  });
  assert.ok(profile.codes.includes('codex.recovery_evidence_invalid'));
});

test('recovery report receipt digest must match the observed fixture receipt', async (t) => {
  const profile = await forgedRecoveryProfile(t, (recoveryCase) => {
    recoveryCase.receipt_sha256 = '0'.repeat(64);
  });
  assert.ok(profile.codes.includes('codex.recovery_evidence_invalid'));
});

test('recovery report target attempt identity must match recomputed evidence', async (t) => {
  const profile = await forgedRecoveryProfile(t, (recoveryCase) => {
    recoveryCase.target_attempt_id = 'adapter-attempt:cdx-999';
  });
  assert.ok(profile.codes.includes('codex.recovery_evidence_invalid'));
});

test('missing recovery target behavior is contained as recovery evidence failure', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const path = resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/crash-after-transmission-preserves-bytes.json');
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  fixture.subject.document.behavior = 'complete';
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);

  const report = JSON.parse(runPreparedPackage(packageRoot).stdout);
  const profile = report.checks.find(({id}) => id === 'codex-intelligence-adapter-profile');

  assert.ok(profile.codes.includes('codex.recovery_evidence_invalid'));
  assert.ok(!profile.codes.includes('validator.deterministic_failure'));
});

test('malformed shared protocol fails closed without collapsing validation', async (t) => {
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  await writeFile(resolve(packageRoot, 'contracts/intelligence-adapter/protocol-rules.json'), '{}\n');

  const report = JSON.parse(runPreparedPackage(packageRoot).stdout);
  const profile = report.checks.find(({id}) => id === 'codex-intelligence-adapter-profile');

  assert.equal(profile.verdict, 'fail');
  assert.ok(!profile.codes.includes('validator.deterministic_failure'));
});

test('committed package proves the independent Codex Intelligence Adapter profile', async (t) => {
  // Given the committed specification package with its Codex Intelligence Adapter artifacts.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));

  // When the public package validator evaluates the complete package.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then the Codex Intelligence Adapter profile is independently validated and passing.
  assert.deepEqual(
    report.checks.find(({id}) => id === 'codex-intelligence-adapter-profile'),
    {id: 'codex-intelligence-adapter-profile', verdict: 'pass', codes: []},
  );
});
