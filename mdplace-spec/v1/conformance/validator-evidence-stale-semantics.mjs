import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {writeJson, createFreshClaimChain, addFreshInput, createFreshRecoveryReport, transitionAttempt, extensionId} from './validator-evidence-support.mjs';

test('fresh recovery binds prior verdict to the recorded Claim Manifest', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'prior-verdict-mismatch'});
  const recovery = await createFreshRecoveryReport(packageRoot, chain, 'prior-verdict-mismatch');
  recovery.report.prior_verdict = 'unsupported';
  const reportArtifact = await writeJson(packageRoot, recovery.binding.path, recovery.report);
  recovery.binding.sha256 = reportArtifact.sha256;

  const reportObservation = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery.report,
  }, packageRoot);
  const transitionObservation = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document: transitionAttempt({
      command: 'record_verdict',
      fromState: 'awaiting_evidence',
      freshClaim: chain.freshClaimBinding,
      recoveryReport: recovery.binding,
    }),
  }, packageRoot);

  assert.equal(reportObservation.verdict, 'fail');
  assert.ok(reportObservation.codes.includes('evidence.recovery_claim_verdict_mismatch'));
  assert.equal(transitionObservation.verdict, 'fail');
  assert.ok(transitionObservation.codes.includes('evidence.recovery_report_invalid'));
  assert.ok(transitionObservation.codes.includes('evidence.recovery_claim_verdict_mismatch'));
});

test('fresh-evidence supply rejects replay when stale recorded proof cannot be reopened', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'unreadable-stale-proof', substantive: false});
  await writeFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'not valid JSON\n',
  );
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'evidence_stale',
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

test('fresh-evidence supply can replace a semantically stale recorded claim chain', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'stale-replacement'});
  const recordedEnvelopePath = 'conformance/evidence/envelopes/validator-evidence-reference.json';
  const recordedEnvelope = await readFile(`${packageRoot}/${recordedEnvelopePath}`, 'utf8');
  await writeFile(`${packageRoot}/${recordedEnvelopePath}`, `${recordedEnvelope}\n`);
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'evidence_stale',
    recordedClaim: chain.recordedClaimBinding,
    freshClaim: chain.freshClaimBinding,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});

test('fresh-evidence supply rejects recorded container bytes relabeled as new input', async () => {
  for (const kind of ['claim', 'envelope', 'invocation']) {
    const packageRoot = await copyCommittedPackage();
    const chain = await createFreshClaimChain(packageRoot, {suffix: `recorded-${kind}-input`, substantive: false});
    const recordedEnvelopeBinding = {
      kind: 'envelope',
      path: chain.recordedClaim.evidence_bindings[0].evidence_ref,
      sha256: chain.recordedClaim.evidence_bindings[0].evidence_digest,
    };
    const recordedEnvelope = JSON.parse(await readFile(
      `${packageRoot}/${recordedEnvelopeBinding.path}`,
      'utf8',
    ));
    const bindings = {
      claim: {...chain.recordedClaimBinding, kind: 'claim'},
      envelope: recordedEnvelopeBinding,
      invocation: {...recordedEnvelope.invocation, kind: 'invocation'},
    };
    await addFreshInput(packageRoot, chain, bindings[kind]);

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document: transitionAttempt({
        command: 'supply_fresh_evidence',
        fromState: 'verdict_recorded',
        recordedClaim: chain.recordedClaimBinding,
        freshClaim: chain.freshClaimBinding,
      }),
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', kind);
    assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'), kind);
  }
});

test('stale state suppresses only recorded digest-binding errors', async () => {
  const cases = [
    {
      code: 'evidence.validator_version_mismatch',
      mutate(claim) {
        claim.validator_version = '1.0.0';
      },
    },
    {
      code: 'claim.verdict_mismatch',
      mutate(claim) {
        claim.verdict = 'fail';
      },
    },
  ];
  for (const {code, mutate} of cases) {
    const packageRoot = await copyCommittedPackage();
    const suffix = code.replace(/[^a-z0-9]+/g, '-');
    const chain = await createFreshClaimChain(packageRoot, {suffix});
    mutate(chain.recordedClaim);
    const recordedClaimArtifact = await writeJson(
      packageRoot,
      chain.recordedClaimBinding.path,
      chain.recordedClaim,
    );
    chain.recordedClaimBinding.sha256 = recordedClaimArtifact.sha256;

    const transitionObservation = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document: transitionAttempt({
        command: 'supply_fresh_evidence',
        fromState: 'evidence_stale',
        recordedClaim: chain.recordedClaimBinding,
        freshClaim: chain.freshClaimBinding,
      }),
    }, packageRoot);

    const recovery = await createFreshRecoveryReport(packageRoot, chain, `recorded-${suffix}`);
    const recordedBinding = recovery.report.recomputed_bindings.find(
      ({path}) => path === chain.recordedClaimBinding.path,
    );
    recordedBinding.expected_sha256 = recordedClaimArtifact.sha256;
    recordedBinding.observed_sha256 = recordedClaimArtifact.sha256;
    recordedBinding.matches = true;
    const reportObservation = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-recovery-report.schema.json',
      document: recovery.report,
    }, packageRoot);

    assert.equal(transitionObservation.verdict, 'fail', `transition: ${code}`);
    assert.ok(transitionObservation.codes.includes(code), `transition: ${code}`);
    assert.equal(reportObservation.verdict, 'fail', `recovery: ${code}`);
    assert.ok(reportObservation.codes.includes(code), `recovery: ${code}`);
  }
});
