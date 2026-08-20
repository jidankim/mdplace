import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {adapterReceiptDigest} from './intelligence-adapter-core.mjs';
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
  attempt.envelope.capabilities = ['capability:produce-proposal'];
  attempt.isolation.effective_capabilities = structuredClone(attempt.envelope.capabilities);
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
