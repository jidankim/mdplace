import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {adapterReceiptDigest, parseReceiptStrings} from './intelligence-adapter-core.mjs';
import {observeIntelligenceAdapterScenario} from './intelligence-adapter-observer.mjs';
import {forbiddenActionCode} from './intelligence-adapter-validation.mjs';

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
