import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  adapterEvidenceClaims,
  adapterReceiptDigest,
  canonicalDigest,
  parseReceiptStrings,
  sha256,
} from './intelligence-adapter-core.mjs';
import {checkIntelligenceAdapterProtocol} from './intelligence-adapter-checks.mjs';
import {observeIntelligenceAdapterScenario} from './intelligence-adapter-observer.mjs';
import {forbiddenActionCode, preflightCode} from './intelligence-adapter-validation.mjs';
import {validateJsonSchema} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8'));
}

async function scenario(caseId) {
  const fixture = await readJson(`conformance/scenarios/intelligence-adapter/${caseId}.json`);
  return structuredClone(fixture.subject.document);
}

async function readRootJson(root, relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function writeRootJson(root, relativePath, document) {
  await writeFile(join(root, relativePath), `${JSON.stringify(document, null, 2)}\n`);
}

async function adapterProtocolCheck(root) {
  const [manifest, conformance, traceability] = await Promise.all([
    readRootJson(root, 'package-manifest.yaml'),
    readRootJson(root, 'conformance/manifest.yaml'),
    readRootJson(root, 'traceability.yaml'),
  ]);
  return checkIntelligenceAdapterProtocol(root, manifest, conformance, traceability);
}

async function afterReceiptRecovery(caseId, targetIndex) {
  const document = await scenario(caseId);
  const executed = await observeIntelligenceAdapterScenario(document, packageRoot);
  const targetAttempt = document.attempts[targetIndex];
  const targetBytes = canonicalJson(targetAttempt.envelope);
  document.operation = 'recover';
  document.recovery = {
    crash_point: 'after_receipt',
    target_attempt_id: targetAttempt.envelope.attempt_id,
    target_attempt_sequence: targetIndex,
    transmission_observed: true,
    prior_transmission: {
      destination: targetAttempt.envelope.destination.endpoint,
      sha256: sha256(targetBytes),
      byte_length: Buffer.byteLength(targetBytes),
    },
    prior_receipts: [parseReceiptStrings(executed.receipts)[targetIndex]],
  };
  return document;
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

test('generated normative digest uses stable code-unit path ordering', async () => {
  const manifest = await readJson('package-manifest.yaml');
  const expected = sha256([...manifest.artifacts]
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(({path, sha256: digest}) => `${path}\0${digest}\n`)
    .join(''));

  assert.equal(manifest.normative_digest, expected);
});

test('protocol evidence recomputes claim indexes and every recovery report fact', async () => {
  const trustedEvidence = await readJson('conformance/evidence/intelligence-adapter-evidence.json');
  const [recoveryRoot, claimRoot] = await Promise.all([copyCommittedPackage(), copyCommittedPackage()]);
  const recoveryPath = 'conformance/evidence/intelligence-adapter-recovery-report.json';
  const evidencePath = 'conformance/evidence/intelligence-adapter-evidence.json';
  const recoveryReport = await readRootJson(recoveryRoot, recoveryPath);
  const [firstRecovery] = recoveryReport.cases;
  recoveryReport.cases = [
    {...firstRecovery},
    {...firstRecovery, crash_point: 'after_receipt', terminal_state: 'recovered', transmitted_bytes: 999},
    {...firstRecovery, crash_point: 'after_transmission_before_receipt', terminal_state: 'recovery_required', transmitted_bytes: 1},
  ];
  const evidence = await readRootJson(claimRoot, evidencePath);
  for (const claim of [
    'isolation_fixture_ids',
    'canary_fixture_ids',
    'instrumented_double_fixture_ids',
    'retry_fixture_ids',
    'fallback_fixture_ids',
    'inert_output_fixture_ids',
  ]) evidence.claims[claim] = ['FIX-IAP-POS-001'];
  await Promise.all([
    writeRootJson(recoveryRoot, recoveryPath, recoveryReport),
    writeRootJson(claimRoot, evidencePath, evidence),
  ]);
  const [recoveryCheck, claimCheck] = await Promise.all([
    adapterProtocolCheck(recoveryRoot),
    adapterProtocolCheck(claimRoot),
  ]);

  assert.ok(recoveryCheck.codes.includes('adapter.recovery_evidence_invalid'));
  assert.ok(claimCheck.codes.includes('adapter.evidence_claim_invalid'));
  assert.ok(trustedEvidence.claims.retry_fixture_ids.includes('FIX-IAP-POS-004'));
  assert.ok(trustedEvidence.claims.retry_fixture_ids.includes('FIX-IAP-NEG-007'));
  assert.ok(!trustedEvidence.claims.retry_fixture_ids.includes('FIX-IAP-ILLEGAL-001'));
  for (const fixtureId of [
    'FIX-IAP-POS-001',
    'FIX-IAP-POS-002',
    'FIX-IAP-POS-003',
    'FIX-IAP-POS-004',
    'FIX-IAP-NEG-013',
    'FIX-IAP-NEG-014',
    'FIX-IAP-REC-002',
  ]) assert.ok(trustedEvidence.claims.isolation_fixture_ids.includes(fixtureId));
});

test('receipt-chain and transmission-observation claims are independently recomputable', async () => {
  const document = await scenario('authorized-local-fallback-succeeds');
  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);
  const receipts = parseReceiptStrings(observed.receipts);
  const record = {fixtureId: 'FIX-IAP-POS-004', document, observed, receipts};

  const complete = adapterEvidenceClaims([record]);
  assert.equal(complete.exact_transmission_observed, true);
  assert.equal(complete.all_outcomes_receipted, true);

  const missingReceipt = structuredClone(record);
  missingReceipt.receipts = missingReceipt.receipts.filter(({attempt_sequence: sequence}) => sequence !== 1);
  const missingReceiptClaims = adapterEvidenceClaims([missingReceipt]);
  assert.equal(missingReceiptClaims.exact_transmission_observed, true);
  assert.equal(missingReceiptClaims.all_outcomes_receipted, false);

  const missingObservation = structuredClone(record);
  missingObservation.observed.observations = missingObservation.observed.observations.filter((value) =>
    JSON.parse(value).attempt_id !== document.attempts[1].envelope.attempt_id);
  const missingObservationClaims = adapterEvidenceClaims([missingObservation]);
  assert.equal(missingObservationClaims.exact_transmission_observed, false);
  assert.equal(missingObservationClaims.all_outcomes_receipted, true);

  const reorderedReceipts = structuredClone(record);
  reorderedReceipts.receipts.reverse();
  const reorderedReceiptClaims = adapterEvidenceClaims([reorderedReceipts]);
  assert.equal(reorderedReceiptClaims.exact_transmission_observed, true);
  assert.equal(reorderedReceiptClaims.all_outcomes_receipted, false);

  const reorderedObservations = structuredClone(record);
  reorderedObservations.observed.observations.reverse();
  const reorderedObservationClaims = adapterEvidenceClaims([reorderedObservations]);
  assert.equal(reorderedObservationClaims.exact_transmission_observed, false);
  assert.equal(reorderedObservationClaims.all_outcomes_receipted, true);
});

test('protocol checks fail closed on malformed lifecycle and scenario documents', async () => {
  const [lifecycleRoot, scenarioRoot] = await Promise.all([copyCommittedPackage(), copyCommittedPackage()]);
  const rules = await readRootJson(lifecycleRoot, 'contracts/intelligence-adapter/protocol-rules.json');
  const lifecyclePath = rules.lifecycle_tables[0];
  const lifecycle = await readRootJson(lifecycleRoot, lifecyclePath);
  delete lifecycle.transitions[0].failure_result;

  const scenarioPath = 'conformance/scenarios/intelligence-adapter/crash-after-receipt-preserves-receipt.json';
  const malformedScenario = await readRootJson(scenarioRoot, scenarioPath);
  malformedScenario.subject.document.recovery = null;
  await Promise.all([
    writeRootJson(lifecycleRoot, lifecyclePath, lifecycle),
    writeRootJson(scenarioRoot, scenarioPath, malformedScenario),
  ]);

  const [lifecycleCheck, scenarioCheck] = await Promise.all([
    adapterProtocolCheck(lifecycleRoot),
    adapterProtocolCheck(scenarioRoot),
  ]);

  assert.equal(lifecycleCheck.verdict, 'fail');
  assert.ok(lifecycleCheck.codes.includes('adapter.lifecycle_incomplete'));
  assert.equal(scenarioCheck.verdict, 'fail');
  assert.ok(scenarioCheck.codes.includes('schema.constraint'));
});

test('expected envelope schema errors suppress only the declared boundary', async () => {
  const root = await copyCommittedPackage();
  const scenarioPath = 'conformance/scenarios/intelligence-adapter/missing-retention-facts-denied.json';
  const fixture = await readRootJson(root, scenarioPath);
  fixture.subject.document.attempts[0].envelope.unexpected = true;
  await writeRootJson(root, scenarioPath, fixture);

  const check = await adapterProtocolCheck(root);

  assert.equal(check.verdict, 'fail');
  assert.ok(check.codes.includes('schema.unknown_field'));
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

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.malformed_output',
    'adapter.recovery_unknown_completion',
  ]);
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('observed timing is canonical and exactly reconciled with measured runtime', async () => {
  const malformed = await scenario('remote-valid-proposal-advice');
  malformed.attempts[0].double.observed_started_at = 'not-a-time';
  malformed.attempts[0].double.observed_completed_at = 'also-not-a-time';
  const calendarInvalid = await scenario('remote-valid-proposal-advice');
  calendarInvalid.attempts[0].double.observed_started_at = '2026-02-31T00:00:00.000Z';
  calendarInvalid.attempts[0].double.observed_completed_at = '2026-02-31T00:00:00.500Z';
  const inconsistent = await scenario('remote-valid-proposal-advice');
  inconsistent.attempts[0].double.observed_completed_at = inconsistent.attempts[0].double.observed_started_at;

  const results = await Promise.all([malformed, calendarInvalid, inconsistent]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.ok(results.every(({codes}) => codes[0] === 'adapter.malformed_output'));
  assert.equal(results[0].receipts.length, 0);
  assert.equal(results[1].receipts.length, 0);
  assert.deepEqual(results[0].network_effects, ['none']);
  assert.deepEqual(results[1].network_effects, ['none']);
  const [receipt] = parseReceiptStrings(results[2].receipts);
  assert.equal(Date.parse(receipt.observed_completed_at) - Date.parse(receipt.observed_started_at),
    receipt.budget.runtime_ms);
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');
  const receiptSchema = await readJson('contracts/schemas/adapter-run-receipt.schema.json');
  assert.equal(typeof scenarioSchema.$defs.timestamp.pattern, 'string');
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
  const validRemote = await scenario('remote-valid-proposal-advice');
  const validContext = await readJson('contracts/intelligence-adapter/approved-context.json');
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
  const malformedEndpoints = [
    'https://localhost/path',
    'https://api.localhost/path',
    'https://singlelabel/path',
    'https:///missing-host',
    'https://:443/path',
    'https://host:abc/path',
    'https://[broken/path',
    'https://percent%zz.test/path',
    'https://host.test/path?',
    'https://host.test/path#',
    'https://@host.test/path',
    'https://2130706433/path',
    'https://127.1/path',
    'https://0x7f000001/path',
    'https://017700000001/path',
    'https://a.0/path',
    `https://host.${'a'.repeat(64)}/path`,
    'https://host.test/a/../b',
    'https://HOST.test/path',
  ];

  assert.equal(validateJsonSchema(envelopeSchema, validRemote.attempts[0].envelope).length, 0);
  assert.equal(validateJsonSchema(contextSchema, validContext).length, 0);
  assert.ok(validateJsonSchema(envelopeSchema, remote.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(envelopeSchema, local.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(contextSchema, context).length > 0);
  assert.ok(validateJsonSchema(envelopeSchema, credentialDocument.attempts[0].envelope).length > 0);
  assert.ok(validateJsonSchema(contextSchema, credentialContext).length > 0);
  assert.equal(preflightCode(credentialDocument.attempts[0], credentialContext), 'adapter.destination_denied');
  for (const endpoint of malformedEndpoints) {
    const endpointContext = await readJson('contracts/intelligence-adapter/approved-context.json');
    const endpointDocument = await scenario('remote-valid-proposal-advice');
    const authorization = endpointContext.attempt_authorizations
      .find(({authorization_id: id}) => id === endpointDocument.attempts[0].envelope.authorization_id);
    authorization.destination.endpoint = endpoint;
    endpointDocument.attempts[0].envelope.destination.endpoint = endpoint;
    endpointDocument.attempts[0].isolation.network_scope = [endpoint];
    assert.ok(validateJsonSchema(envelopeSchema, endpointDocument.attempts[0].envelope).length > 0, endpoint);
    assert.ok(validateJsonSchema(contextSchema, endpointContext).length > 0, endpoint);
    assert.equal(preflightCode(endpointDocument.attempts[0], endpointContext), 'adapter.destination_denied', endpoint);
  }
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
  const fieldAndSegmentIntegrity = await scenario('remote-valid-proposal-advice');
  fieldAndSegmentIntegrity.attempts[0].envelope.transmitted_fields[0].segment_id =
    fieldAndSegmentIntegrity.attempts[0].envelope.payload_segments[1].segment_id;
  fieldAndSegmentIntegrity.attempts[0].envelope.payload_segments[0].sha256 = 'b'.repeat(64);
  const malformedKindAndBinding = await scenario('remote-valid-proposal-advice');
  const malformedBindingProposal = JSON.parse(malformedKindAndBinding.attempts[0].double.raw_output);
  malformedBindingProposal.kind = 'abstention';
  malformedBindingProposal.bindings.policy_sha256 = 'b'.repeat(64);
  malformedKindAndBinding.attempts[0].double.raw_output = JSON.stringify(malformedBindingProposal);
  const timingAndFilesystem = await scenario('remote-valid-proposal-advice');
  timingAndFilesystem.attempts[0].double.observed_completed_at =
    timingAndFilesystem.attempts[0].double.observed_started_at;
  const filesystemProposal = JSON.parse(timingAndFilesystem.attempts[0].double.raw_output);
  filesystemProposal.authority.filesystem = 'write';
  timingAndFilesystem.attempts[0].double.raw_output = JSON.stringify(filesystemProposal);

  const results = await Promise.all([
    filesystemAndSemantic,
    staleCacheAndIsolation,
    stalePolicyAndChainOverflow,
    providerAndContract,
    fieldAndSegmentIntegrity,
    malformedKindAndBinding,
    timingAndFilesystem,
  ].map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.filesystem_authority_denied',
    'adapter.isolation_failed',
    'adapter.policy_binding_denied',
    'adapter.policy_binding_denied',
    'adapter.field_denied',
    'adapter.malformed_output',
    'adapter.filesystem_authority_denied',
  ]);
});

test('crash recovery applies earlier observed denials before unknown completion', async () => {
  const stalePolicy = await scenario('crash-after-transmission-requires-recovery');
  stalePolicy.attempts[0].envelope.bindings.policy.sha256 = 'b'.repeat(64);
  const staleBytes = canonicalJson(stalePolicy.attempts[0].envelope);
  stalePolicy.recovery.prior_transmission = {
    destination: stalePolicy.attempts[0].envelope.destination.endpoint,
    sha256: sha256(staleBytes),
    byte_length: Buffer.byteLength(staleBytes),
  };
  const toolRequest = await scenario('crash-after-transmission-requires-recovery');
  toolRequest.attempts[0].double.requested_actions = ['invoke_tool'];

  const results = await Promise.all([stalePolicy, toolRequest]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.policy_binding_denied',
    'adapter.tool_request_denied',
  ]);
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('after-receipt recovery targets an exact retry or fallback with cumulative chain state', async () => {
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');
  for (const [caseId, targetIndex] of [
    ['authorized-retry-succeeds', 1],
    ['authorized-local-fallback-succeeds', 2],
  ]) {
    const document = await afterReceiptRecovery(caseId, targetIndex);

    const observed = await observeIntelligenceAdapterScenario(document, packageRoot);
    assert.equal(validateJsonSchema(scenarioSchema, document).length, 0, caseId);
    assert.equal(observed.verdict, 'pass', caseId);
    assert.equal(observed.terminal_state, 'recovered', caseId);
    assert.deepEqual(observed.network_effects, ['none'], caseId);
  }
});

test('recovery preserves precedent failures from attempts before an exact retry or fallback target', async () => {
  const retryPolicy = await afterReceiptRecovery('authorized-retry-succeeds', 1);
  retryPolicy.attempts[0].envelope.bindings.policy.sha256 = 'b'.repeat(64);
  const retryAction = await afterReceiptRecovery('authorized-retry-succeeds', 1);
  retryAction.attempts[0].double.requested_actions = ['invoke_tool'];
  const fallbackPolicy = await afterReceiptRecovery('authorized-local-fallback-succeeds', 2);
  fallbackPolicy.attempts[0].envelope.bindings.policy.sha256 = 'b'.repeat(64);
  const fallbackAction = await afterReceiptRecovery('authorized-local-fallback-succeeds', 2);
  fallbackAction.attempts[1].double.requested_actions = ['invoke_tool'];

  const results = await Promise.all([retryPolicy, retryAction, fallbackPolicy, fallbackAction]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.policy_binding_denied',
    'adapter.tool_request_denied',
    'adapter.policy_binding_denied',
    'adapter.tool_request_denied',
  ]);
  assert.ok(results.every(({network_effects: effects}) => effects[0] === 'none'));
});

test('before-receipt crash shapes bind the exact retry or fallback target and evidence boundary', async () => {
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');
  for (const [caseId, targetIndex] of [
    ['authorized-retry-succeeds', 1],
    ['authorized-local-fallback-succeeds', 2],
  ]) {
    for (const crashPoint of ['before_transmission', 'after_transmission_before_receipt']) {
      const document = await scenario(caseId);
      const targetAttempt = document.attempts[targetIndex];
      const targetBytes = canonicalJson(targetAttempt.envelope);
      const afterTransmission = crashPoint === 'after_transmission_before_receipt';
      document.operation = 'recover';
      targetAttempt.double.behavior = afterTransmission ? 'crash_after_transmit' : 'crash_before_transmit';
      targetAttempt.double.raw_output = null;
      if (!afterTransmission) targetAttempt.double.provider_request_id = null;
      document.recovery = {
        crash_point: crashPoint,
        target_attempt_id: targetAttempt.envelope.attempt_id,
        target_attempt_sequence: targetIndex,
        transmission_observed: afterTransmission,
        prior_transmission: afterTransmission ? {
          destination: targetAttempt.envelope.destination.endpoint,
          sha256: sha256(targetBytes),
          byte_length: Buffer.byteLength(targetBytes),
        } : null,
        prior_receipts: [],
      };

      const observed = await observeIntelligenceAdapterScenario(document, packageRoot);
      assert.equal(validateJsonSchema(scenarioSchema, document).length, 0, `${caseId}:${crashPoint}`);
      assert.deepEqual(observed.codes, [afterTransmission
        ? 'adapter.recovery_unknown_completion'
        : 'adapter.recovery_before_transmission_denied']);
      assert.deepEqual(observed.network_effects, ['none']);

      const wrongCrashTarget = structuredClone(document);
      wrongCrashTarget.attempts[targetIndex].double.behavior = 'proposal';
      wrongCrashTarget.attempts[0].double.behavior = afterTransmission
        ? 'crash_after_transmit'
        : 'crash_before_transmit';
      assert.ok(validateJsonSchema(scenarioSchema, wrongCrashTarget).length > 0,
        `${caseId}:${crashPoint}:wrong-target`);
    }
  }
});

test('recovery evidence cardinality is closed for execution and every crash boundary', async () => {
  const scenarioSchema = await readJson('contracts/schemas/intelligence-adapter-scenario.schema.json');
  const executeWithRecovery = await scenario('remote-valid-proposal-advice');
  executeWithRecovery.recovery.transmission_observed = true;
  executeWithRecovery.recovery.prior_transmission = {
    destination: executeWithRecovery.attempts[0].envelope.destination.endpoint,
    sha256: 'a'.repeat(64),
    byte_length: 1,
  };
  const beforeWithTransmission = await scenario('crash-before-transmission-recovers-denied');
  beforeWithTransmission.recovery.transmission_observed = true;
  beforeWithTransmission.recovery.prior_transmission = {
    destination: beforeWithTransmission.attempts[0].envelope.destination.endpoint,
    sha256: 'a'.repeat(64),
    byte_length: 1,
  };
  const afterTransmissionWithReceipt = await scenario('crash-after-transmission-requires-recovery');
  afterTransmissionWithReceipt.recovery.prior_receipts = [{}];
  const afterReceiptWithoutReceipt = await scenario('crash-after-receipt-preserves-receipt');
  afterReceiptWithoutReceipt.recovery.prior_receipts = [];

  assert.ok([executeWithRecovery, beforeWithTransmission, afterTransmissionWithReceipt, afterReceiptWithoutReceipt]
    .every((document) => validateJsonSchema(scenarioSchema, document).length > 0));
});

test('recovery receipts retain the measurements that select timeout and cost outcomes', async () => {
  const timeout = await scenario('crash-after-transmission-requires-recovery');
  timeout.attempts[0].double.duration_ms = 2000;
  timeout.attempts[0].double.observed_completed_at = new Date(
    Date.parse(timeout.attempts[0].double.observed_started_at) + 2000,
  ).toISOString();
  const cost = await scenario('crash-after-transmission-requires-recovery');
  cost.attempts[0].double.cost_microunits = 10001;

  const results = await Promise.all([timeout, cost]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));
  const receipts = results.map(({receipts: values}) => parseReceiptStrings(values)[0]);

  assert.deepEqual(results.map(({codes}) => codes[0]), ['adapter.timeout', 'adapter.cost_budget_exhausted']);
  assert.equal(receipts[0].budget.runtime_ms, timeout.attempts[0].double.duration_ms);
  assert.equal(receipts[0].observed_completed_at, timeout.attempts[0].double.observed_completed_at);
  assert.equal(receipts[1].budget.cost_microunits, cost.attempts[0].double.cost_microunits);
  assert.equal(receipts[1].observed_completed_at, cost.attempts[0].double.observed_completed_at);
});

test('recovery mismatch receipts bind same-length raw response and validated proposal artifacts', async () => {
  const altered = await scenario('crash-after-receipt-preserves-receipt');
  const changed = await scenario('crash-after-receipt-preserves-receipt');
  altered.attempts[0].double.raw_output = altered.attempts[0].double.raw_output.replace('Bounded', 'Altered');
  changed.attempts[0].double.raw_output = changed.attempts[0].double.raw_output.replace('Bounded', 'Changed');

  const results = await Promise.all([altered, changed]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));
  const receipts = results.map(({receipts: values}) => parseReceiptStrings(values)[0]);
  const observations = results.map(({observations: values}) => JSON.parse(values[0]));

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.recovery_unknown_completion',
    'adapter.recovery_unknown_completion',
  ]);
  assert.equal(receipts[0].budget.output_bytes, receipts[1].budget.output_bytes);
  assert.notEqual(receipts[0].raw_response_sha256, receipts[1].raw_response_sha256);
  for (const [index, document] of [altered, changed].entries()) {
    const rawOutput = document.attempts[0].double.raw_output;
    assert.equal(receipts[index].raw_response_sha256, sha256(rawOutput));
    assert.equal(receipts[index].proposal_sha256, canonicalDigest(JSON.parse(rawOutput)));
    assert.equal(observations[index].raw_output_sha256, sha256(rawOutput));
  }
});

test('output budgets deny oversized bytes before proposal parsing in execution and recovery', async () => {
  const execution = await scenario('remote-valid-proposal-advice');
  execution.attempts[0].envelope.ceilings.output_bytes = 100;
  const recovery = await scenario('crash-after-receipt-preserves-receipt');
  recovery.attempts[0].envelope.ceilings.output_bytes = 100;
  const recoveryBytes = canonicalJson(recovery.attempts[0].envelope);
  recovery.recovery.prior_transmission = {
    destination: recovery.attempts[0].envelope.destination.endpoint,
    sha256: sha256(recoveryBytes),
    byte_length: Buffer.byteLength(recoveryBytes),
  };

  const results = await Promise.all([execution, recovery]
    .map((document) => observeIntelligenceAdapterScenario(document, packageRoot)));
  const receipts = results.map(({receipts: values}) => parseReceiptStrings(values)[0]);

  assert.deepEqual(results.map(({codes}) => codes[0]), [
    'adapter.output_budget_exhausted',
    'adapter.output_budget_exhausted',
  ]);
  for (const [index, document] of [execution, recovery].entries()) {
    const rawOutput = document.attempts[0].double.raw_output;
    assert.equal(receipts[index].raw_response_sha256, sha256(rawOutput));
    assert.equal(receipts[index].proposal_sha256, null);
    assert.ok(!results[index].operations.some((operation) => operation.startsWith('validate inert Intelligence Proposal')));
  }
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

test('unknown adapter actions fail closed before transmission', async () => {
  const document = await scenario('remote-valid-proposal-advice');
  document.attempts[0].double.requested_actions = ['open_network_socket'];

  const observed = await observeIntelligenceAdapterScenario(document, packageRoot);

  assert.equal(forbiddenActionCode(['open_network_socket']), 'adapter.tool_request_denied');
  assert.deepEqual(observed.codes, ['adapter.tool_request_denied']);
  assert.deepEqual(observed.network_effects, ['none']);
  assert.ok(!observed.operations.some((operation) => operation.startsWith('transmit exact')));
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
  assert.equal(rules.outcome_precedence.find(({order}) => order === 7)?.condition,
    'transmitted artifact not approved');
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
