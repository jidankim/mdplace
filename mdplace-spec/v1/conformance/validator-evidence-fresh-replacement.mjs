import assert from 'node:assert/strict';
import test from 'node:test';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {writeJson, createFreshClaimChain, transitionAttempt, extensionId} from './validator-evidence-support.mjs';

test('fresh-evidence supply rejects reuse of the recorded invocation identity', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'reused-invocation', reuseInvocationId: true});
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

test('fresh-evidence supply accepts a new invocation with changed proof bytes', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot);
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

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});

test('fresh-evidence supply replaces every non-present mandatory evidence state', async () => {
  const cases = [
    {availability: 'missing', verdict: 'inconclusive', fromState: 'verdict_recorded'},
    {availability: 'stale', verdict: 'inconclusive', fromState: 'evidence_stale'},
    {availability: 'skipped', verdict: 'inconclusive', fromState: 'verdict_recorded'},
    {availability: 'unsupported', verdict: 'unsupported', fromState: 'verdict_recorded'},
  ];
  for (const {availability, verdict, fromState} of cases) {
    const packageRoot = await copyCommittedPackage();
    const chain = await createFreshClaimChain(packageRoot, {suffix: `${availability}-replacement`});
    const recordedClaim = structuredClone(chain.recordedClaim);
    recordedClaim.verdict = verdict;
    recordedClaim.evidence_bindings[0] = {
      ...recordedClaim.evidence_bindings[0],
      availability,
      evidence_ref: null,
      evidence_digest: null,
      verdict,
    };
    const recordedArtifact = await writeJson(
      packageRoot,
      `conformance/evidence/claims/recorded-${availability}.json`,
      recordedClaim,
    );
    const document = transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState,
      recordedClaim: {
        claim_id: recordedClaim.claim_id,
        path: recordedArtifact.path,
        sha256: recordedArtifact.sha256,
      },
      freshClaim: chain.freshClaimBinding,
    });

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      document,
    }, packageRoot);

    assert.equal(observed.verdict, 'pass', availability);
    assert.equal(observed.terminal_state, 'awaiting_evidence', availability);
  }
});

test('fresh-evidence supply carries current mandatory proof while replacing missing proof', async () => {
  const packageRoot = await copyCommittedPackage();
  const chain = await createFreshClaimChain(packageRoot, {suffix: 'mixed-state-replacement'});
  const recordedClaim = structuredClone(chain.recordedClaim);
  recordedClaim.evidence_requirements.push({evidence_kind: 'replacement_evidence', mandatory: true});
  recordedClaim.evidence_bindings.push({
    evidence_kind: 'replacement_evidence',
    mandatory: true,
    availability: 'missing',
    applicability: 'applicable',
    evidence_ref: null,
    evidence_digest: null,
    verdict: 'inconclusive',
  });
  recordedClaim.verdict = 'inconclusive';
  const recordedArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/recorded-mixed-state.json',
    recordedClaim,
  );
  const freshClaim = structuredClone(recordedClaim);
  freshClaim.evidence_bindings[1] = {
    ...freshClaim.evidence_bindings[1],
    availability: 'present',
    evidence_ref: chain.envelopeArtifact.path,
    evidence_digest: chain.envelopeArtifact.sha256,
    verdict: 'pass',
  };
  freshClaim.verdict = 'pass';
  const freshArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, freshClaim);
  const document = transitionAttempt({
    command: 'supply_fresh_evidence',
    fromState: 'verdict_recorded',
    recordedClaim: {
      claim_id: recordedClaim.claim_id,
      path: recordedArtifact.path,
      sha256: recordedArtifact.sha256,
    },
    freshClaim: {
      claim_id: freshClaim.claim_id,
      path: freshArtifact.path,
      sha256: freshArtifact.sha256,
    },
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'awaiting_evidence');
});
