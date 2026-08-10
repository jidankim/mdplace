import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {createFreshClaimChain, createFreshRecoveryReport, transitionAttempt, digest, extensionId, validatorVersion, committedPackageRoot} from './validator-evidence-support.mjs';

test('record-verdict requires an artifact-bound fresh-supply report', async () => {
  const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'awaiting_evidence',
    command: 'record_verdict',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: true,
    recorded_claim: null,
    recovery_report: null,
    fresh_claim: {claim_id: 'CLAIM-RECOVERY-001', path: claimPath, sha256: digest(claimContent)},
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_report_required'));
});

test('record-verdict accepts the claim bound by a validated fresh-supply report', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'recordable-fresh-evidence'});
  const recovery = await createFreshRecoveryReport(packageRoot, chain, 'recordable-fresh-evidence');
  const document = transitionAttempt({
    command: 'record_verdict',
    fromState: 'awaiting_evidence',
    freshClaim: chain.freshClaimBinding,
    recoveryReport: recovery.binding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'verdict_recorded');
});

test('recovery rejects omission from the transitive binding set', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.recomputed_bindings = recovery.recomputed_bindings.slice(0, 1);

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_binding_set_mismatch'));
});
