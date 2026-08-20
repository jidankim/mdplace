import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {adapterReceiptDigest, canonicalDigest, parseReceiptStrings, sha256} from './intelligence-adapter-core.mjs';
import {observeIntelligenceAdapterScenario} from './intelligence-adapter-observer.mjs';
import {forbiddenActionCode, preflightCode} from './intelligence-adapter-validation.mjs';
import {validateJsonSchema} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

async function scenario(caseId) {
  const fixture = await readJson(`conformance/scenarios/intelligence-adapter/${caseId}.json`);
  return structuredClone(fixture.subject.document);
}

test('CLI validates the complete Intelligence Adapter proposal protocol pack', () => {
  // Given the candidate Specification Package at the public conformance seam.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the validator evaluates issue #45 protocol artifacts and observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const adapterResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-IAP-'));

  // Then the dedicated check and all 42 protocol fixtures pass without production authority.
  assert.ok(report.checks.some(({id, verdict}) => id === 'intelligence-adapter-protocol' && verdict === 'pass'));
  assert.equal(adapterResults.length, 42);
  assert.ok(adapterResults.every(({verdict}) => verdict === 'pass'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('attempt authorization denies an unapproved model before transmission', async () => {
  const document = await scenario('remote-valid-proposal-advice');
  document.attempts[0].envelope.bindings.model_id = 'model:unapproved';
  const proposal = JSON.parse(document.attempts[0].double.raw_output);
  proposal.bindings.model_id = 'model:unapproved';
  document.attempts[0].double.raw_output = JSON.stringify(proposal);

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.deepEqual(observed.codes, ['adapter.provider_denied']);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('attempt chains enforce trusted budgets, legal order, and retry counts before transmission', async () => {
  const retry = await scenario('authorized-retry-succeeds');
  const standaloneRetry = structuredClone(retry);
  standaloneRetry.attempts = [standaloneRetry.attempts[1]];
  const tooManyAttempts = structuredClone(retry);
  tooManyAttempts.chain_budget.max_attempts = 1;
  const repeatedRetry = structuredClone(retry);
  repeatedRetry.attempts.push(structuredClone(repeatedRetry.attempts[1]));
  const widenedBudget = structuredClone(retry);
  widenedBudget.chain_budget.cost_microunits += 1;

  const results = await Promise.all([standaloneRetry, tooManyAttempts, repeatedRetry, widenedBudget]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.deepEqual(results.map(({codes}) => codes), [
    ['adapter.retry_exhausted'],
    ['adapter.retry_exhausted'],
    ['adapter.retry_exhausted'],
    ['adapter.policy_binding_denied'],
  ]);
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('one-off envelopes may narrow authorized sets without widening them', async () => {
  const document = await scenario('remote-valid-proposal-advice');
  const attempt = document.attempts[0];
  const keptField = attempt.envelope.transmitted_fields[0];
  attempt.envelope.transmitted_fields = [keptField];
  attempt.envelope.payload_segments = attempt.envelope.payload_segments
    .filter(({segment_id: id}) => id === keptField.segment_id);
  attempt.envelope.redactions = attempt.envelope.redactions
    .filter(({receipt_sha256: digest}) => digest === keptField.redaction_receipt_sha256);
  attempt.envelope.transmitted_artifacts = [attempt.envelope.transmitted_artifacts[0]];
  attempt.envelope.retention_artifacts = [attempt.envelope.retention_artifacts[0]];
  const proposal = JSON.parse(attempt.double.raw_output);
  proposal.evidence_segment_ids = [keptField.segment_id];
  proposal.candidates[0].evidence_segment_ids = [keptField.segment_id];
  attempt.double.raw_output = JSON.stringify(proposal);

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.equal(observed.verdict, 'pass');
});

test('recovery binds the exact attempt and never retransmits prior bytes', async () => {
  const afterReceipt = await scenario('crash-after-receipt-preserves-receipt');
  const unrelated = structuredClone(afterReceipt.recovery.prior_receipts[0]);
  unrelated.attempt_id = 'adapter-attempt:unrelated-0';
  unrelated.receipt_sha256 = adapterReceiptDigest(unrelated);
  afterReceipt.recovery.prior_receipts = [unrelated];
  const afterTransmission = await scenario('crash-after-transmission-requires-recovery');

  const [unrelatedResult, transmittedResult] = await Promise.all([
    observeIntelligenceAdapterScenario(afterReceipt, packageRoot),
    observeIntelligenceAdapterScenario(afterTransmission, packageRoot),
  ]);

  assert.deepEqual(unrelatedResult.codes, ['adapter.recovery_unknown_completion']);
  assert.deepEqual(unrelatedResult.network_effects, ['none']);
  assert.deepEqual(transmittedResult.codes, ['adapter.recovery_unknown_completion']);
  assert.deepEqual(transmittedResult.network_effects, ['none']);
  assert.ok(transmittedResult.operations.every((operation) => !operation.startsWith('transmit exact')));
});

test('every recovery evidence mismatch terminates without entering normal execution', async () => {
  const beforeTransmission = await scenario('crash-before-transmission-recovers-denied');
  const afterTransmission = await scenario('crash-after-transmission-requires-recovery');
  beforeTransmission.recovery.transmission_observed = true;
  beforeTransmission.recovery.prior_transmission = structuredClone(afterTransmission.recovery.prior_transmission);

  const observed = await observeIntelligenceAdapterScenario(beforeTransmission, packageRoot);
  const [receipt] = parseReceiptStrings(observed.receipts);

  assert.deepEqual(observed.codes, ['adapter.recovery_unknown_completion']);
  assert.deepEqual(observed.network_effects, ['none']);
  assert.ok(observed.operations.every((operation) => !operation.startsWith('transmit exact')));
  assert.deepEqual(receipt.budget, {input_bytes: 0, output_bytes: 0, runtime_ms: 0, cost_microunits: 0});
});

test('field authorization binds each field to its exact redaction obligation', async () => {
  const document = await scenario('remote-valid-proposal-advice');
  const attempt = document.attempts[0];
  const sourceUrl = attempt.envelope.transmitted_fields.find(({field_id: id}) => id === 'field:source-url');
  const removeSecrets = attempt.envelope.redactions.find(({rule_id: id}) => id === 'redaction:remove-secrets');
  sourceUrl.redaction_receipt_sha256 = removeSecrets.receipt_sha256;
  attempt.envelope.transmitted_fields = [sourceUrl];
  attempt.envelope.payload_segments = attempt.envelope.payload_segments
    .filter(({segment_id: id}) => id === sourceUrl.segment_id);
  attempt.envelope.redactions = [removeSecrets];
  const proposal = JSON.parse(attempt.double.raw_output);
  proposal.evidence_segment_ids = [sourceUrl.segment_id];
  proposal.candidates[0].evidence_segment_ids = [sourceUrl.segment_id];
  attempt.double.raw_output = JSON.stringify(proposal);

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.deepEqual(observed.codes, ['adapter.redaction_unproven']);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('recovery rejects re-digested receipts with changed isolation or measured budget', async () => {
  const isolationMismatch = await scenario('crash-after-receipt-preserves-receipt');
  isolationMismatch.recovery.prior_receipts[0].isolation.canary_passed = false;
  isolationMismatch.recovery.prior_receipts[0].receipt_sha256 = adapterReceiptDigest(isolationMismatch.recovery.prior_receipts[0]);
  const budgetMismatch = await scenario('crash-after-receipt-preserves-receipt');
  budgetMismatch.recovery.prior_receipts[0].budget.runtime_ms += 1;
  budgetMismatch.recovery.prior_receipts[0].receipt_sha256 = adapterReceiptDigest(budgetMismatch.recovery.prior_receipts[0]);
  const outcomeMismatch = await scenario('crash-after-receipt-preserves-receipt');
  outcomeMismatch.recovery.prior_receipts[0].reason = 'adapter.timeout';
  outcomeMismatch.recovery.prior_receipts[0].receipt_sha256 = adapterReceiptDigest(outcomeMismatch.recovery.prior_receipts[0]);

  const results = await Promise.all([isolationMismatch, budgetMismatch, outcomeMismatch]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.recovery_unknown_completion'));
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('recovery recomputes proposal validity and terminal outcome from bound observations', async () => {
  const malformedAccepted = await scenario('crash-after-receipt-preserves-receipt');
  const malformedRaw = '{"foo":1}';
  malformedAccepted.attempts[0].double.raw_output = malformedRaw;
  malformedAccepted.recovery.prior_receipts[0].raw_response_sha256 = sha256(malformedRaw);
  malformedAccepted.recovery.prior_receipts[0].proposal_sha256 = canonicalDigest(JSON.parse(malformedRaw));
  malformedAccepted.recovery.prior_receipts[0].budget.output_bytes = Buffer.byteLength(malformedRaw);
  malformedAccepted.recovery.prior_receipts[0].receipt_sha256 = adapterReceiptDigest(malformedAccepted.recovery.prior_receipts[0]);
  const falseDenial = await scenario('crash-after-receipt-preserves-receipt');
  falseDenial.recovery.prior_receipts[0].outcome = 'denied';
  falseDenial.recovery.prior_receipts[0].reason = 'adapter.tool_request_denied';
  falseDenial.recovery.prior_receipts[0].proposal_sha256 = null;
  falseDenial.recovery.prior_receipts[0].receipt_sha256 = adapterReceiptDigest(falseDenial.recovery.prior_receipts[0]);

  const results = await Promise.all([malformedAccepted, falseDenial]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.recovery_unknown_completion'));
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('observed timing is canonical and exactly reconciled with measured runtime', async () => {
  const malformed = await scenario('remote-valid-proposal-advice');
  malformed.attempts[0].double.observed_started_at = 'not-a-time';
  malformed.attempts[0].double.observed_completed_at = 'also-not-a-time';
  const inconsistent = await scenario('remote-valid-proposal-advice');
  inconsistent.attempts[0].double.observed_completed_at = inconsistent.attempts[0].double.observed_started_at;

  const results = await Promise.all([malformed, inconsistent]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.malformed_output'));
  for (const observed of results) {
    const [receipt] = parseReceiptStrings(observed.receipts);
    assert.equal(Date.parse(receipt.observed_completed_at) - Date.parse(receipt.observed_started_at),
      receipt.budget.runtime_ms);
  }
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');
  const receiptSchema = await readJson('contracts/schemas/adapter-run-receipt.schema.json');
  assert.equal(typeof scenarioSchema.$defs.double.properties.observed_started_at.pattern, 'string');
  assert.equal(typeof scenarioSchema.$defs.double.properties.observed_completed_at.pattern, 'string');
  assert.equal(typeof receiptSchema.$defs.timestamp.pattern, 'string');
});

test('forbidden actions retain precedence before transient scheduling and resource outcomes', async () => {
  const transient = await scenario('authorized-retry-succeeds');
  transient.attempts[0].double.requested_actions = ['invoke_tool'];
  transient.attempts[0].double.duration_ms = transient.attempts[0].envelope.ceilings.runtime_ms + 1;
  transient.attempts[0].double.cost_microunits = transient.attempts[0].envelope.ceilings.cost_microunits + 1;
  transient.attempts[0].double.raw_output = 'oversized'.repeat(transient.attempts[0].envelope.ceilings.output_bytes);
  const terminal = await scenario('remote-valid-proposal-advice');
  terminal.attempts[0].double.behavior = 'timeout';
  terminal.attempts[0].double.requested_actions = ['invoke_tool'];
  terminal.attempts[0].double.duration_ms = terminal.attempts[0].envelope.ceilings.runtime_ms + 1;

  const results = await Promise.all([transient, terminal]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.tool_request_denied'));
  assert.equal(results[0].receipts.length, 1);
  assert.equal(results[0].network_effects.length, 1);
  const [receipt] = parseReceiptStrings(results[0].receipts);
  assert.equal(Date.parse(receipt.observed_completed_at) - Date.parse(receipt.observed_started_at),
    receipt.budget.runtime_ms);
  assert.equal(receipt.budget.runtime_ms, 500);
});

test('retry scheduling requires the next attempt exact authorization to remain valid', async () => {
  const document = await scenario('authorized-retry-succeeds');
  document.attempts[1].envelope.bindings.model_id = 'model:unapproved';

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.deepEqual(observed.codes, ['adapter.retry_exhausted']);
  assert.equal(observed.receipts.length, 1);
  assert.equal(observed.network_effects.length, 1);
});

test('destination schemas bind HTTPS remote egress and local-only delivery schemes', async () => {
  const envelopeSchema = await readJson('contracts/schemas/processing-envelope.schema.json');
  const contextSchema = await readJson('contracts/schemas/intelligence-adapter-approved-context.schema.json');
  const remote = await scenario('remote-valid-proposal-advice');
  remote.attempts[0].envelope.destination.endpoint = 'http://cleartext.test/process';
  const local = await scenario('local-valid-abstention-advice');
  local.attempts[0].envelope.destination.endpoint = 'https://remote.test/process';
  const context = await readJson('contracts/intelligence-adapter/approved-context.json');
  const remoteAuthorization = context.attempt_authorizations.find(({destination}) => destination.locality === 'remote');
  remoteAuthorization.destination.endpoint = 'http://cleartext.test/process';
  const credentialContext = await readJson('contracts/intelligence-adapter/approved-context.json');
  const credentialDocument = await scenario('remote-valid-proposal-advice');
  const credentialAuthorization = credentialContext.attempt_authorizations
    .find(({authorization_id: id}) => id === credentialDocument.attempts[0].envelope.authorization_id);
  const credentialEndpoint = 'https://alice:secret@credential-leak.test/process';
  credentialAuthorization.destination.endpoint = credentialEndpoint;
  credentialDocument.attempts[0].envelope.destination.endpoint = credentialEndpoint;
  credentialDocument.attempts[0].isolation.network_scope = [credentialEndpoint];

  assert.ok(validateJsonSchema(envelopeSchema, remote.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(envelopeSchema, local.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(contextSchema, context).length > 0);
  assert.ok(validateJsonSchema(envelopeSchema, credentialDocument.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(contextSchema, credentialContext).length > 0);
  assert.equal(preflightCode(credentialDocument.attempts[0], credentialContext), 'adapter.destination_denied');
});

test('local adapter delivery is observed without claiming network egress', async () => {
  const local = await scenario('local-valid-abstention-advice');

  const observed = await observeIntelligenceAdapterScenario(local, packageRoot);
  const [receipt] = parseReceiptStrings(observed.receipts);

  assert.equal(observed.verdict, 'pass');
  assert.deepEqual(observed.network_effects, ['none']);
  assert.ok(receipt.transmitted_bytes > 0);
  assert.equal(observed.observations.length, 1);
});

test('crash behavior and recovery evidence are fail-closed and shape-compatible', async () => {
  const executeBeforeTransmit = await scenario('remote-valid-proposal-advice');
  executeBeforeTransmit.attempts[0].double.behavior = 'crash_before_transmit';
  executeBeforeTransmit.attempts[0].double.raw_output = null;
  const contradictoryRecovery = await scenario('crash-after-receipt-preserves-receipt');
  contradictoryRecovery.attempts[0].double.behavior = 'crash_after_transmit';
  contradictoryRecovery.attempts[0].double.raw_output = null;
  const priorReceipt = contradictoryRecovery.recovery.prior_receipts[0];
  priorReceipt.raw_response_sha256 = null;
  priorReceipt.proposal_sha256 = null;
  priorReceipt.budget.output_bytes = 0;
  priorReceipt.outcome = 'malformed_output';
  priorReceipt.reason = 'adapter.malformed_output';
  priorReceipt.receipt_sha256 = adapterReceiptDigest(priorReceipt);

  const [beforeResult, contradictoryResult] = await Promise.all([
    observeIntelligenceAdapterScenario(executeBeforeTransmit, packageRoot),
    observeIntelligenceAdapterScenario(contradictoryRecovery, packageRoot),
  ]);
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');

  assert.deepEqual(beforeResult.codes, ['adapter.recovery_before_transmission_denied']);
  assert.deepEqual(beforeResult.network_effects, ['none']);
  assert.deepEqual(contradictoryResult.codes, ['adapter.recovery_unknown_completion']);
  assert.deepEqual(contradictoryResult.network_effects, ['none']);
  assert.ok(validateJsonSchema(scenarioSchema, executeBeforeTransmit).length > 0);
  assert.ok(validateJsonSchema(scenarioSchema, contradictoryRecovery).length > 0);
});

test('combined failures select the first declared global outcome precedence', async () => {
  const filesystemAndSemantic = await scenario('remote-valid-proposal-advice');
  const authorityProposal = JSON.parse(filesystemAndSemantic.attempts[0].double.raw_output);
  authorityProposal.authority.filesystem = 'write';
  authorityProposal.authority.semantic = 'establish_truth';
  filesystemAndSemantic.attempts[0].double.raw_output = JSON.stringify(authorityProposal);
  const staleCacheAndIsolation = await scenario('stale-cached-proposal-denied');
  staleCacheAndIsolation.attempts[0].isolation.filesystem = 'present';
  const stalePolicyAndChainOverflow = await scenario('remote-valid-proposal-advice');
  stalePolicyAndChainOverflow.attempts[0].envelope.bindings.policy.sha256 = 'b'.repeat(64);
  stalePolicyAndChainOverflow.chain_budget.max_attempts = 0;
  const providerAndContract = await scenario('remote-valid-proposal-advice');
  providerAndContract.attempts[0].envelope.bindings.provider_id = 'provider:other';
  providerAndContract.attempts[0].envelope.contracts.adapter_contract_version = '2.0.0';

  const results = await Promise.all([
    filesystemAndSemantic,
    staleCacheAndIsolation,
    stalePolicyAndChainOverflow,
    providerAndContract,
  ].map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.filesystem_authority_denied',
    'adapter.isolation_failed',
    'adapter.policy_binding_denied',
    'adapter.policy_binding_denied',
  ]);
});

test('retry scheduling denies known aggregate input exhaustion before emitting a schedule receipt', async () => {
  const document = await scenario('authorized-retry-succeeds');
  const exactChainInput = document.attempts.reduce((total, {envelope}) =>
    total + Buffer.byteLength(canonicalJson(envelope)), 0);
  document.chain_budget.input_bytes = exactChainInput - 1;

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.deepEqual(observed.codes, ['adapter.retry_exhausted']);
  assert.equal(observed.receipts.length, 1);
  assert.equal(observed.network_effects.length, 1);
});

test('forbidden-action precedence is independent of caller array order', () => {
  assert.equal(forbiddenActionCode(['choose_note_placement', 'invoke_tool']), 'adapter.tool_request_denied');
  assert.equal(forbiddenActionCode(['invoke_tool', 'choose_note_placement']), 'adapter.tool_request_denied');
});

test('taxonomy caching, receipt reasons, and transmission dependencies are closed', async () => {
  const envelopeSchema = await readJson('contracts/schemas/processing-envelope.schema.json');
  const contextSchema = await readJson('contracts/schemas/intelligence-adapter-approved-context.schema.json');
  const proposalSchema = await readJson('contracts/schemas/intelligence-proposal.schema.json');
  const receiptSchema = await readJson('contracts/schemas/adapter-run-receipt.schema.json');
  const rules = await readJson('contracts/intelligence-adapter/protocol-rules.json');
  const execution = await readJson('contracts/transitions/intelligence-adapter-execution-lifecycle.json');

  assert.ok(envelopeSchema.$defs.bindings.required.includes('taxonomy_revision'));
  assert.ok(envelopeSchema.$defs.cachedProposal.required.includes('taxonomy_revision_sha256'));
  assert.ok(contextSchema.required.includes('taxonomy_revision_binding'));
  assert.ok(proposalSchema.$defs.bindings.required.includes('taxonomy_revision_sha256'));
  assert.deepEqual(
    new Set(receiptSchema.properties.reason.enum),
    new Set(rules.receipt_reasons.map(({code}) => code)),
  );
  const transmit = execution.transitions.find(({from_state: state, command_or_event: command}) =>
    state === 'authorized' && command === 'transmit_adapter_payload');
  assert.ok(transmit.preconditions.some((value) => value.includes('isolation')));
  assert.ok(transmit.preconditions.some((value) => value.includes('canary')));
  assert.ok(!transmit.emitted_records.includes('AdapterRunReceipt'));
});

test('only terminal lifecycle outcomes emit Adapter Run Receipts', async () => {
  const rules = await readJson('contracts/intelligence-adapter/protocol-rules.json');
  const terminalStates = new Map([
    ['TRANS-IAP-EXECUTION', new Set(['terminal'])],
    ['TRANS-IAP-DENIAL', new Set(['denied'])],
    ['TRANS-IAP-TIMEOUT', new Set(['timed_out'])],
    ['TRANS-IAP-RETRY', new Set(['exhausted'])],
    ['TRANS-IAP-FALLBACK', new Set(['exhausted'])],
    ['TRANS-IAP-ISOLATION', new Set(['failed'])],
    ['TRANS-IAP-RECOVERY', new Set(['recovered', 'denied'])],
  ]);
  const tables = await Promise.all(rules.lifecycle_tables.map((path) => readJson(path)));

  for (const table of tables) {
    for (const row of table.transitions.filter(({allowed}) => allowed)) {
      assert.equal(
        row.emitted_records.includes('AdapterRunReceipt'),
        terminalStates.get(table.table_id).has(row.terminal_state),
        `${table.table_id}:${row.from_state}:${row.command_or_event}`,
      );
    }
  }
});

test('remote and local envelopes retain their required execution capabilities', async () => {
  const remote = await scenario('remote-valid-proposal-advice');
  remote.attempts[0].envelope.capabilities = ['capability:produce-proposal'];
  remote.attempts[0].isolation.effective_capabilities = ['capability:produce-proposal'];
  const local = await scenario('local-valid-abstention-advice');
  local.attempts[0].envelope.capabilities = [];
  local.attempts[0].isolation.effective_capabilities = [];

  const results = await Promise.all([remote, local]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.capability_denied'));
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('receipts bind observed timestamps and explicit provider request identity', async () => {
  const remote = await scenario('remote-valid-proposal-advice');
  const local = await scenario('local-valid-abstention-advice');
  const [remoteResult, localResult] = await Promise.all([remote, local]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));
  const [remoteReceipt] = parseReceiptStrings(remoteResult.receipts);
  const [localReceipt] = parseReceiptStrings(localResult.receipts);

  assert.match(remoteReceipt.observed_started_at, /^2026-08-20T/);
  assert.match(remoteReceipt.observed_completed_at, /^2026-08-20T/);
  assert.match(remoteReceipt.provider_request_id, /^provider-request:/);
  assert.equal(localReceipt.provider_request_id, null);
});
