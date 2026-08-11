import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {writeJson, createFreshClaimChain, transitionAttempt, digest, extensionId, validatorVersion} from './validator-evidence-support.mjs';

test('mark-stale accepts an accurate digest-bound stale Recovery Report', async () => {
  const packageRoot = await copyCommittedPackage();
  const recordedClaimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const staleClaimPath = 'conformance/evidence/claims/stale-recovery-snapshot.json';
  const staleClaim = JSON.parse(await readFile(`${packageRoot}/${recordedClaimPath}`, 'utf8'));
  staleClaim.evidence_bindings[0].evidence_digest = 'a'.repeat(64);
  const staleClaimContent = `${JSON.stringify(staleClaim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${staleClaimPath}`, staleClaimContent);
  const report = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  report.report_id = 'evidence-recovery:stale-readback';
  report.claim.path = staleClaimPath;
  report.claim.sha256 = digest(staleClaimContent);
  report.recomputed_bindings[0] = {
    path: staleClaimPath,
    expected_sha256: digest(staleClaimContent),
    observed_sha256: digest(staleClaimContent),
    matches: true,
  };
  const envelopeBinding = report.recomputed_bindings.find(({path}) =>
    path === 'conformance/evidence/envelopes/validator-evidence-reference.json');
  envelopeBinding.expected_sha256 = 'a'.repeat(64);
  envelopeBinding.matches = false;
  report.operations = ['reopen declared artifact', 'recompute sha256', 'mark evidence stale'];
  report.terminal_state = 'evidence_stale';
  report.effective_verdict = 'inconclusive';
  const reportPath = 'conformance/evidence/evidence-stale-recovery-report.json';
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(`${packageRoot}/${reportPath}`, reportContent);
  const document = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'mark_stale',
    actor_authority: {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: {report_id: report.report_id, path: reportPath, sha256: digest(reportContent)},
    fresh_claim: null,
  };

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});

test('fresh-evidence supply rejects identifier-only churn', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'identifier-churn', substantive: false});
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});

test('fresh-evidence supply rejects unauthenticated receipt-only churn', async () => {
  for (const [receiptMutation, expectedCode] of [
    ['type', 'schema.constraint'],
    ['digest', 'evidence.receipt_digest_mismatch'],
  ]) {
    const packageRoot = await copyCommittedPackage();
    const suffix = `receipt-${receiptMutation}-churn`;
    const chain = await createFreshClaimChain(packageRoot, {suffix, substantive: false});
    const envelope = JSON.parse(await readFile(`${packageRoot}/${chain.envelopeArtifact.path}`, 'utf8'));
    if (receiptMutation === 'type') envelope.receipts[0].receipt_type = 'AlternateReceipt';
    else envelope.receipts[0].sha256 = 'a'.repeat(64);
    const envelopeArtifact = await writeJson(packageRoot, chain.envelopeArtifact.path, envelope);
    chain.freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
    const claimArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, chain.freshClaim);
    chain.freshClaimBinding.sha256 = claimArtifact.sha256;
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState: 'verdict_recorded',
      recordedClaim: chain.recordedClaimBinding,
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', receiptMutation);
    assert.ok(observed.codes.includes(expectedCode), receiptMutation);
  }
});

test('fresh-evidence supply rejects digest-list churn without new proof bytes', async () => {
  const mutations = [
    {
      name: 'remove',
      apply(envelope) {
        envelope.artifact_digests.pop();
      },
    },
    {
      name: 'reorder',
      apply(envelope) {
        envelope.artifact_digests = envelope.artifact_digests.reverse()
          .map((entry, ordinal) => ({...entry, ordinal}));
      },
    },
    {
      name: 'duplicate bytes',
      async apply(envelope, packageRoot) {
        const copiedPath = 'conformance/evidence/copied-contract.md';
        await writeFile(
          `${packageRoot}/${copiedPath}`,
          await readFile(`${packageRoot}/${envelope.artifact_digests[0].path}`),
        );
        envelope.artifact_digests.push({
          ...envelope.artifact_digests[0],
          ordinal: envelope.artifact_digests.length,
          label: 'copied_contract',
          path: copiedPath,
        });
      },
    },
    {
      name: 'role',
      apply(envelope) {
        const output = envelope.output_digests[0];
        const artifact = envelope.artifact_digests[0];
        envelope.output_digests[0] = {...artifact, ordinal: 0};
        envelope.artifact_digests[0] = {...output, ordinal: 0};
      },
    },
  ];
  for (const mutation of mutations) {
    const packageRoot = await copyCommittedPackage();
    const suffix = `digest-${mutation.name.replace(' ', '-')}-churn`;
    const chain = await createFreshClaimChain(packageRoot, {suffix, substantive: false});
    const envelope = JSON.parse(await readFile(`${packageRoot}/${chain.envelopeArtifact.path}`, 'utf8'));
    await mutation.apply(envelope, packageRoot);
    const envelopeArtifact = await writeJson(packageRoot, chain.envelopeArtifact.path, envelope);
    chain.freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
    const claimArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, chain.freshClaim);
    chain.freshClaimBinding.sha256 = claimArtifact.sha256;
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState: 'verdict_recorded',
      recordedClaim: chain.recordedClaimBinding,
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', mutation.name);
    const expectedCode = mutation.name === 'remove'
      ? 'evidence.receipt_unbound'
      : 'evidence.fresh_evidence_replayed';
    assert.ok(observed.codes.includes(expectedCode), mutation.name);
  }
});
