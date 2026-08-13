import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {policyNarrowingViolation, processingPolicyDigest} from './processing-policy-core.mjs';
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

  const retentionSubject = structuredClone(reference.subject);
  retentionSubject.document.policy.grants.destinations[0].retention_fact_id = 'retention:unbound';
  retentionSubject.document.request.policy_binding.policy_sha256 = processingPolicyDigest(retentionSubject.document.policy);
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
