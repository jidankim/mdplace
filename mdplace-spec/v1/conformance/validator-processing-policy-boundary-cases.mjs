import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  approvalReceiptDigest,
  processingPolicyReceiptDigest,
  redactionReceiptDigest,
  sha256Text,
} from './processing-policy-core.mjs';
import {
  attemptAccountingViolation,
  processingAttemptReceiptDigest,
  processingAttemptRequestDigest,
} from './processing-policy-attempts.mjs';
import {observeProcessingPolicyScenario} from './processing-policy-observer.mjs';
import {observeProcessingPolicyLifecycleTransition} from './processing-policy-result.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./scenarios/core-processing-policy/${name}.json`, import.meta.url)));
}

test('fixtures expose the exact consent boundary and a real external compatibility claim', async () => {
  const processing = (await fixture('remote-processing-allowed')).subject.document;
  const intake = (await fixture('approved-source-profile-intake-allowed')).subject.document;
  const requestKeys = ['vault_id', 'adapter_id', 'consent_binding_id', 'field_grants', 'destination', 'credential_boundary',
    'payload', 'redaction_receipt_refs', 'retention_facts'];
  assert.ok(requestKeys.every((key) => Object.hasOwn(processing.request, key)));
  assert.equal(intake.compatibility_claim_ref, 'CLAIM-WEBCLIPPER-001');
});

test('exact request dimensions deny independently before any network effect', async () => {
  const reference = (await fixture('remote-processing-allowed')).subject;
  const cases = [
    ['policy.vault_mismatch', (document) => { document.request.vault_id = 'vault:another-vault'; }],
    ['policy.provider_denied', (document) => { document.request.adapter_id = 'adapter:unapproved'; }],
    ['policy.field_denied', (document) => { document.request.field_grants[0].data_class = 'data:private-frontmatter'; }],
    ['policy.destination_denied', (document) => { document.request.destination.endpoint = 'https://other.invalid/process'; }],
    ['policy.credential_boundary_denied', (document) => { document.request.credential_boundary.authentication_method = 'delegated_login'; }],
    ['policy.retry_exceeded', (document) => { document.request.payload.bytes += 'tampered'; }],
  ];
  for (const [code, mutate] of cases) {
    const subject = structuredClone(reference);
    mutate(subject.document);
    const observed = await observeProcessingPolicyScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, [code]);
    assert.deepEqual(observed.network_effects, ['none']);
  }
  const observed = await observeProcessingPolicyScenario(
    (await fixture('missing-retention-fact-denied')).subject,
    packageRoot,
  );
  assert.deepEqual(observed.codes, ['policy.retention_unproven']);
  assert.deepEqual(observed.network_effects, ['none']);
});

test('remote consent cannot authorize a local-only field', async () => {
  const subject = structuredClone((await fixture('remote-processing-allowed')).subject);
  subject.document.request.field_ids.push('field:filesystem-path');
  subject.document.request.field_grants.push(
    subject.document.policy.grants.fields.find(({field_id: id}) => id === 'field:filesystem-path'),
  );
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);
  assert.deepEqual(observed.codes, ['policy.field_denied']);
  assert.deepEqual(observed.network_effects, ['none']);

  const crossedLocality = structuredClone((await fixture('remote-processing-allowed')).subject);
  crossedLocality.document.policy.grants.destinations[0].locality = 'local';
  assert.deepEqual((await observeProcessingPolicyScenario(crossedLocality, packageRoot)).codes,
    ['schema.constraint']);
});

test('retry and fallback execution remains bound to the exact adapter chain and aggregate budget', async () => {
  const reference = (await fixture('remote-processing-allowed')).subject;
  const retry = structuredClone(reference);
  retry.document.request.attempt_chain[1].adapter_id = 'adapter:local-alpha';
  assert.deepEqual((await observeProcessingPolicyScenario(retry, packageRoot)).codes, ['policy.retry_exceeded']);

  const aggregate = structuredClone(reference);
  aggregate.document.request.retry.input_bytes = aggregate.document.policy.grants.retry.input_bytes + 1;
  assert.deepEqual((await observeProcessingPolicyScenario(aggregate, packageRoot)).codes, ['policy.retry_exceeded']);

  const underreported = structuredClone(reference);
  underreported.document.request.retry.input_bytes = 1;
  assert.deepEqual((await observeProcessingPolicyScenario(underreported, packageRoot)).codes, ['policy.retry_exceeded']);

  const untrustedAccounting = structuredClone(reference);
  untrustedAccounting.document.attempt_receipts[0].usage.input_bytes += 1;
  assert.deepEqual((await observeProcessingPolicyScenario(untrustedAccounting, packageRoot)).codes,
    ['policy.retry_exceeded']);

  const changedRequest = structuredClone(reference);
  changedRequest.document.request.automation_scope.push('alias_promotion');
  assert.deepEqual((await observeProcessingPolicyScenario(changedRequest, packageRoot)).codes,
    ['policy.retry_exceeded']);

  const overPerAttemptBudget = structuredClone(reference.document);
  overPerAttemptBudget.request.budget.output_bytes = overPerAttemptBudget.attempt_receipts[0].usage.output_bytes - 1;
  const requestDigest = processingAttemptRequestDigest(overPerAttemptBudget.request);
  for (const receipt of overPerAttemptBudget.attempt_receipts) {
    receipt.request_sha256 = requestDigest;
    receipt.receipt_sha256 = processingAttemptReceiptDigest(receipt);
    const attempt = overPerAttemptBudget.request.attempt_chain.find(({receipt_id: id}) => id === receipt.receipt_id);
    attempt.receipt_sha256 = receipt.receipt_sha256;
  }
  overPerAttemptBudget.trusted_context = {
    attempt_receipt_sha256s: overPerAttemptBudget.attempt_receipts.map(({receipt_sha256: digest}) => digest),
  };
  assert.equal(attemptAccountingViolation(overPerAttemptBudget), 'policy.retry_exceeded');

  const fallback = structuredClone((await fixture('exact-budget-allowed')).subject);
  fallback.document.request.attempt_chain.at(-1).consent_binding_id = 'consent:primary';
  assert.deepEqual((await observeProcessingPolicyScenario(fallback, packageRoot)).codes, ['policy.fallback_denied']);
});

test('unknown and provider-training terms require explicit risk acknowledgment', async () => {
  for (const dataUse of ['unknown', 'provider_training']) {
    const subject = structuredClone((await fixture('remote-processing-allowed')).subject);
    subject.document.request.retention_facts[0].data_use = dataUse;
    subject.document.request.retention_facts[0].risk_acknowledged = false;
    const observed = await observeProcessingPolicyScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, ['schema.constraint']);
    assert.deepEqual(observed.network_effects, ['none']);
  }
});

test('lifecycle denial declarations are executed through the public transition observer', async () => {
  const fixtureDocument = (await fixture('intake-before-binding-denied')).subject.document;
  const table = JSON.parse(await readFile(new URL(
    `../${fixtureDocument.lifecycle_denials[0].table_id === 'TRANS-PROCESSING-POLICY'
      ? 'contracts/transitions/processing-policy-lifecycle.json'
      : 'contracts/transitions/source-profile-lifecycle.json'}`,
    import.meta.url,
  )));
  const attempt = fixtureDocument.lifecycle_denials[0];
  assert.deepEqual(observeProcessingPolicyLifecycleTransition(table, attempt), attempt.expected);
  const delegated = structuredClone(attempt);
  delegated.actors[0].delegated = true;
  assert.deepEqual(observeProcessingPolicyLifecycleTransition(table, delegated).codes,
    ['policy.lifecycle_oracle_invalid']);
});

test('standing consent remains exact, current, and request-bound', async () => {
  const reference = (await fixture('remote-processing-allowed')).subject;
  const revoked = structuredClone(reference);
  revoked.document.lifecycle.policy_state = 'revoked';
  assert.deepEqual((await observeProcessingPolicyScenario(revoked, packageRoot)).codes, ['policy.inactive']);

  const missingScope = structuredClone(reference);
  missingScope.document.request.consent_binding_id = 'consent:missing';
  assert.deepEqual((await observeProcessingPolicyScenario(missingScope, packageRoot)).codes,
    ['policy.destination_denied']);

  const changedRequest = structuredClone(reference);
  changedRequest.document.request.request_id = 'request:changed';
  for (const receipt of changedRequest.document.redaction_receipts) {
    receipt.request_id = changedRequest.document.request.request_id;
    receipt.receipt_sha256 = redactionReceiptDigest(receipt);
  }
  changedRequest.document.request.redaction_receipt_refs = changedRequest.document.redaction_receipts
    .map(({receipt_id, receipt_sha256}) => ({receipt_id, receipt_sha256}));
  const changedObserved = await observeProcessingPolicyScenario(changedRequest, packageRoot);
  const originalObserved = await observeProcessingPolicyScenario(reference, packageRoot);
  const changedReceipt = JSON.parse(changedObserved.receipts[0]);
  const originalReceipt = JSON.parse(originalObserved.receipts[0]);
  assert.notEqual(changedObserved.receipts[0], originalObserved.receipts[0]);
  assert.equal(changedReceipt.request_id, 'request:changed');
  assert.notEqual(changedReceipt.request_sha256, originalReceipt.request_sha256);
  assert.equal(changedReceipt.receipt_sha256, processingPolicyReceiptDigest(changedReceipt));
});

test('actual payload bytes and ambiguous receipt identifiers fail closed', async () => {
  const reference = (await fixture('remote-processing-allowed')).subject;
  const oversized = structuredClone(reference);
  oversized.document.request.payload.bytes = 'x'.repeat(oversized.document.request.budget.input_bytes + 1);
  oversized.document.request.payload.sha256 = sha256Text(oversized.document.request.payload.bytes);
  assert.deepEqual((await observeProcessingPolicyScenario(oversized, packageRoot)).codes,
    ['policy.budget_exceeded']);

  const duplicate = structuredClone(reference);
  const ambiguous = structuredClone(duplicate.document.approval_receipts[0]);
  ambiguous.role = 'capture_adapter';
  ambiguous.receipt_sha256 = approvalReceiptDigest(ambiguous);
  duplicate.document.approval_receipts.push(ambiguous);
  assert.deepEqual((await observeProcessingPolicyScenario(duplicate, packageRoot)).codes,
    ['policy.approval_readback_failed']);
});

test('descendant approval and malformed public boundaries cannot authorize or throw', async () => {
  const pair = (await fixture('policy-preservation-canary')).subject;
  const unapproved = structuredClone(pair);
  unapproved.document.descendant_policy.approval.approved = false;
  assert.deepEqual((await observeProcessingPolicyScenario(unapproved, packageRoot)).codes,
    ['policy.approval_denied']);

  const recovery = (await fixture('crash-after-binding-publish-recovery')).subject;
  const missingRecovery = structuredClone(recovery);
  missingRecovery.document.recovery = null;
  const missingObserved = await observeProcessingPolicyScenario(missingRecovery, packageRoot);
  assert.deepEqual(missingObserved.codes, ['source_profile.recovery_evidence_invalid']);
  assert.equal(missingObserved.terminal_state, 'recovery_required');

  const nullObserved = await observeProcessingPolicyScenario({
    kind: 'processing_policy', schema: 'contracts/schemas/processing-policy-scenario.schema.json', document: null,
  }, packageRoot);
  assert.deepEqual(nullObserved.codes, ['schema.instance_missing']);
});

test('one normative fixture covers every illegal lifecycle row and recovery denial class', async () => {
  const lifecycle = (await fixture('intake-before-binding-denied')).subject.document.lifecycle_denials;
  const recovery = (await fixture('crash-after-binding-publish-recovery')).subject.document.recovery_denials;
  assert.equal(lifecycle.length, 22);
  assert.equal(new Set(lifecycle.map(({transition_id: id}) => id)).size, 22);
  assert.deepEqual(recovery.map(({case_id: id}) => id).sort(), [
    'ambiguous_approval_receipt', 'mismatched_binding', 'missing_recovery', 'torn_journal',
  ]);
  assert.ok(recovery.every(({expected}) => expected.verdict === 'fail' &&
    expected.terminal_state === 'recovery_required' && expected.network_effects[0] === 'none'));
});
