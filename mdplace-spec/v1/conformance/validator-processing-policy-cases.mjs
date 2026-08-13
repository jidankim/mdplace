import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {
  approvalReceiptDigest,
  policyNarrowingViolation,
  processingPolicyApprovalDigest,
  processingPolicyDigest,
  sourceProfileApprovalDigest,
  sourceProfileDigest,
} from './processing-policy-core.mjs';
import {observeProcessingPolicyScenario} from './processing-policy-observer.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`./scenarios/core-processing-policy/${name}.json`, import.meta.url)));
}

test('CLI validates exactly 50 Core Processing Policy and Source Profile fixtures', () => {
  // Given the committed Specification Package with the issue #36 conformance pack.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and all observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const policyResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-CPP-'));

  // Then the dedicated contract check and exactly 50 owned fixtures pass.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(report.checks.some(({id, verdict}) => id === 'core-processing-policy-contract' && verdict === 'pass'));
  assert.equal(policyResults.length, 50);
  assert.ok(policyResults.every(({verdict}) => verdict === 'pass'));
});

test('processing remains default-deny for approval and retention binding mutations', async () => {
  const reference = await fixture('remote-processing-allowed');
  for (const mutate of [
    (policy) => { policy.approval.approved = false; },
    (policy) => { policy.approval.role = 'capture_adapter'; },
    (policy) => { policy.approval.delegated = true; },
  ]) {
    const subject = structuredClone(reference.subject);
    mutate(subject.document.policy);
    subject.document.request.policy_binding.policy_sha256 = processingPolicyDigest(subject.document.policy);
    const observed = await observeProcessingPolicyScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, ['policy.approval_denied']);
  }

  const retentionSubject = (await fixture('missing-retention-fact-denied')).subject;
  const retentionObserved = await observeProcessingPolicyScenario(retentionSubject, packageRoot);
  assert.deepEqual(retentionObserved.codes, ['policy.retention_unproven']);
});

test('Source Profile readback and descendant obligations reject independent widening', async () => {
  const intake = await fixture('approved-source-profile-intake-allowed');
  intake.subject.document.observed_binding.url_retention_mode = 'withheld';
  const intakeObserved = await observeProcessingPolicyScenario(intake.subject, packageRoot);
  assert.deepEqual(intakeObserved.codes, ['source_profile.url_retention_mode_mismatch']);

  const pair = await fixture('policy-preservation-canary');
  const {policy: parent} = pair.subject.document;
  const redactionChild = structuredClone(pair.subject.document.descendant_policy);
  redactionChild.redaction_obligations = redactionChild.redaction_obligations.slice(1);
  assert.equal(policyNarrowingViolation(parent, redactionChild), 'policy.widening_redaction');

  const retentionChild = structuredClone(pair.subject.document.descendant_policy);
  retentionChild.retention_facts[0].risk_acknowledged = false;
  assert.equal(policyNarrowingViolation(parent, retentionChild), 'policy.widening_retention');
});

test('binding recovery rejects torn journal, approval, and readback evidence', async () => {
  const beforeApproval = await fixture('crash-before-approval-recovery');
  assert.ok(beforeApproval.subject.document.approval_receipts.every(({subject_kind: kind}) =>
    kind !== 'source_profile'));
  const recovery = await fixture('crash-after-binding-publish-recovery');
  for (const mutate of [
    (document) => { document.recovery.journal_sha256 = 'a'.repeat(64); },
    (document) => { document.source_profile.approval.approved = false; },
    (document) => { document.observed_binding.profile_sha256 = 'a'.repeat(64); },
  ]) {
    const subject = structuredClone(recovery.subject);
    mutate(subject.document);
    const observed = await observeProcessingPolicyScenario(subject, packageRoot);
    assert.deepEqual(observed.codes, ['source_profile.recovery_evidence_invalid']);
    assert.equal(observed.terminal_state, 'recovery_required');
  }
});

test('processing denies a widened policy whose original approval is replayed', async () => {
  // Given an approved policy whose grants are widened after approval.
  const subject = structuredClone((await fixture('remote-processing-allowed')).subject);
  subject.document.policy.grants.provider_ids.push('provider:exfiltration');
  subject.document.policy.grants.purpose_ids.push('purpose:exfiltration');
  subject.document.policy.grants.destinations.push({
    destination_id: 'destination:exfiltration',
    provider_id: 'provider:exfiltration',
    locality: 'remote',
    endpoint: 'https://exfiltration.invalid/process',
    retention_fact_id: 'retention:exfiltration',
  });
  subject.document.policy.grants.credential_boundaries.push({
    credential_ref: 'credential-ref:exfiltration',
    store: 'os_credential_store',
    authentication_method: 'api_key',
    provider_id: 'provider:exfiltration',
    purpose_ids: ['purpose:exfiltration'],
  });
  subject.document.policy.retention_facts.push({
    retention_fact_id: 'retention:exfiltration',
    destination_id: 'destination:exfiltration',
    status: 'unknown',
    max_days: 36500,
    risk_acknowledged: true,
    data_use: 'provider_training',
    region: 'global',
    subprocessors: ['unknown'],
  });
  Object.assign(subject.document.request, {
    provider_id: 'provider:exfiltration',
    purpose_id: 'purpose:exfiltration',
    destination_id: 'destination:exfiltration',
    credential_ref: 'credential-ref:exfiltration',
    retention_fact_ids: ['retention:exfiltration'],
  });
  subject.document.request.policy_binding.policy_sha256 = processingPolicyDigest(subject.document.policy);

  // When the public observer evaluates the widened bytes with the unchanged approval.
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);

  // Then exact consent fails closed.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['policy.approval_readback_failed']);

  // Recomputing a self-asserted approval and receipt still cannot alter trusted local readback.
  subject.document.policy.approval.policy_payload_sha256 =
    processingPolicyApprovalDigest(subject.document.policy);
  const receipt = subject.document.approval_receipts.find(({subject_kind: kind}) => kind === 'processing_policy');
  receipt.subject_payload_sha256 = subject.document.policy.approval.policy_payload_sha256;
  receipt.receipt_sha256 = approvalReceiptDigest(receipt);
  subject.document.policy.approval.receipt_sha256 = receipt.receipt_sha256;
  subject.document.request.policy_binding.policy_sha256 = processingPolicyDigest(subject.document.policy);
  const forged = await observeProcessingPolicyScenario(subject, packageRoot);
  assert.deepEqual(forged.codes, ['policy.approval_readback_failed']);
});

test('intake rejects a Source Profile approved for another vault', async () => {
  // Given an otherwise valid Source Profile whose vault binding is changed and internally rehashed.
  const subject = structuredClone((await fixture('approved-source-profile-intake-allowed')).subject);
  subject.document.source_profile.vault_id = 'vault:attacker-vault';
  subject.document.source_profile.approval.profile_payload_sha256 =
    sourceProfileApprovalDigest(subject.document.source_profile);
  subject.document.observed_binding.profile_sha256 = sourceProfileDigest(subject.document.source_profile);

  // When intake evaluates the profile against the original vault policy.
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);

  // Then the cross-vault binding is denied.
  assert.deepEqual(observed.codes, ['source_profile.vault_mismatch']);
});

test('processing rejects privileged capability names even when policy and request enumerate them', async () => {
  // Given a request and policy that both claim a shell capability.
  const subject = structuredClone((await fixture('remote-processing-allowed')).subject);
  subject.document.policy.grants.capabilities.push('capability:shell-execution');
  subject.document.request.capabilities.push('capability:shell-execution');
  subject.document.request.policy_binding.policy_sha256 = processingPolicyDigest(subject.document.policy);

  // When the public observer evaluates the request.
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);

  // Then privileged capability vocabulary cannot be authorized.
  assert.equal(observed.verdict, 'fail');
});

test('processing rejects redaction rule identifiers without bound receipt evidence', async () => {
  // Given the manifest-bound fixture with no trusted redaction receipt.
  const subject = (await fixture('missing-redaction-denied')).subject;

  // When the public observer evaluates those identifiers as redaction proof.
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);

  // Then identifiers alone are not trusted receipt evidence.
  assert.deepEqual(observed.codes, ['policy.redaction_unproven']);
});

test('descendant policies preserve field data classes and applicable retention obligations', async () => {
  // Given an otherwise preserving policy pair.
  const pair = await fixture('policy-preservation-canary');
  const {policy: parent} = pair.subject.document;
  const dataClassChild = structuredClone(pair.subject.document.descendant_policy);
  dataClassChild.grants.fields[0].data_class = 'data:private-frontmatter';
  const retentionChild = structuredClone(pair.subject.document.descendant_policy);
  retentionChild.retention_facts = [];

  // When each child is compared with its exact parent.
  const dataClassViolation = policyNarrowingViolation(parent, dataClassChild);
  const retentionViolation = policyNarrowingViolation(parent, retentionChild);

  // Then both independent widenings are rejected.
  assert.equal(dataClassViolation, 'policy.widening_disclosure');
  assert.equal(retentionViolation, 'policy.widening_retention');
});

test('malformed recovery Source Profile returns a structured denial instead of throwing', async () => {
  // Given a schema-valid scenario envelope whose recovery profile has no required fields.
  const subject = structuredClone((await fixture('crash-after-binding-publish-recovery')).subject);
  subject.document.source_profile = {};

  // When the public observer evaluates recovery.
  const observed = await observeProcessingPolicyScenario(subject, packageRoot);

  // Then boundary parsing fails closed without an exception.
  assert.deepEqual(observed.codes, ['schema.required_field']);
  assert.equal(observed.terminal_state, 'recovery_required');
});

test('Source Profile lifecycle explicitly models invalidation and both recovery outcomes', async () => {
  // Given the machine-readable Source Profile lifecycle.
  const table = JSON.parse(await readFile(new URL('../contracts/transitions/source-profile-lifecycle.json', import.meta.url)));
  const transition = (state, command) => table.transitions.find((row) =>
    row.from_state === state && row.command_or_event === command);

  // When the complete lifecycle commands are inspected.
  const activeInvalidation = transition('active', 'invalidate_source_profile');
  const unapprovedRecovery = transition('recovery_required', 'recover_unapproved_source_profile');
  const approvedRecovery = transition('recovery_required', 'recover_approved_source_profile');

  // Then invalidation reaches stale and recovery has no contradictory terminal state.
  assert.equal(activeInvalidation?.allowed, true);
  assert.equal(activeInvalidation?.terminal_state, 'stale');
  assert.equal(unapprovedRecovery?.terminal_state, 'unbound');
  assert.equal(approvedRecovery?.terminal_state, 'active');
});
