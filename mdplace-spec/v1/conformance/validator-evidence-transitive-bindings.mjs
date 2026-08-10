import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {writeJson, digest, extensionId, committedPackageRoot} from './validator-evidence-support.mjs';

test('recovery binding enumeration descends through invocation subjects', async () => {
  const packageRoot = await copyCommittedPackage();
  const baseInvocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  const nestedInvocation = structuredClone(baseInvocation);
  nestedInvocation.invocation_id = 'invocation:nested-recovery-subject';
  const nestedInvocationArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/invocations/nested-recovery-subject.json',
    nestedInvocation,
  );
  const baseEnvelope = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'utf8',
  ));
  const nestedEnvelope = structuredClone(baseEnvelope);
  nestedEnvelope.envelope_id = 'evidence:nested-recovery-subject';
  nestedEnvelope.invocation = {
    invocation_id: nestedInvocation.invocation_id,
    path: nestedInvocationArtifact.path,
    sha256: nestedInvocationArtifact.sha256,
  };
  nestedEnvelope.receipts[0].receipt_id = 'receipt:nested-recovery-subject';
  const nestedEnvelopeArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/envelopes/nested-recovery-subject.json',
    nestedEnvelope,
  );
  const nestedClaim = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/claims/recovery-snapshot.json`,
    'utf8',
  ));
  nestedClaim.claim_id = 'CLAIM-NESTED-001';
  nestedClaim.evidence_bindings[0].evidence_ref = nestedEnvelopeArtifact.path;
  nestedClaim.evidence_bindings[0].evidence_digest = nestedEnvelopeArtifact.sha256;
  const nestedClaimArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/nested-recovery-subject.json',
    nestedClaim,
  );
  const outerInvocation = structuredClone(baseInvocation);
  outerInvocation.invocation_id = 'invocation:outer-recovery-subject';
  outerInvocation.subject = {
    kind: 'claim_manifest',
    subject_id: 'claim:nested-recovery-subject',
    path: nestedClaimArtifact.path,
    schema: 'contracts/schemas/claim-manifest.schema.json',
    sha256: nestedClaimArtifact.sha256,
  };
  const outerInvocationArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/invocations/outer-recovery-subject.json',
    outerInvocation,
  );
  const outerEnvelope = structuredClone(baseEnvelope);
  outerEnvelope.envelope_id = 'evidence:outer-recovery-subject';
  outerEnvelope.invocation = {
    invocation_id: outerInvocation.invocation_id,
    path: outerInvocationArtifact.path,
    sha256: outerInvocationArtifact.sha256,
  };
  outerEnvelope.subject = {
    kind: outerInvocation.subject.kind,
    subject_id: outerInvocation.subject.subject_id,
    schema: outerInvocation.subject.schema,
    sha256: outerInvocation.subject.sha256,
  };
  outerEnvelope.receipts[0].receipt_id = 'receipt:outer-recovery-subject';
  const outerEnvelopeArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/envelopes/outer-recovery-subject.json',
    outerEnvelope,
  );
  const rootClaim = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/claims/recovery-snapshot.json`,
    'utf8',
  ));
  rootClaim.subject = {
    kind: outerEnvelope.subject.kind,
    subject_id: outerEnvelope.subject.subject_id,
    sha256: outerEnvelope.subject.sha256,
  };
  rootClaim.evidence_bindings[0].evidence_ref = outerEnvelopeArtifact.path;
  rootClaim.evidence_bindings[0].evidence_digest = outerEnvelopeArtifact.sha256;
  const rootClaimArtifact = await writeJson(
    packageRoot,
    'conformance/evidence/claims/outer-recovery-subject.json',
    rootClaim,
  );
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  recovery.claim = {
    claim_id: rootClaim.claim_id,
    path: rootClaimArtifact.path,
    sha256: rootClaimArtifact.sha256,
  };
  recovery.recomputed_bindings = recovery.recomputed_bindings.map((binding) => {
    if (binding.path === 'conformance/evidence/claims/recovery-snapshot.json') {
      return {path: rootClaimArtifact.path, expected_sha256: rootClaimArtifact.sha256,
        observed_sha256: rootClaimArtifact.sha256, matches: true};
    }
    if (binding.path === 'conformance/evidence/envelopes/validator-evidence-reference.json') {
      return {path: outerEnvelopeArtifact.path, expected_sha256: outerEnvelopeArtifact.sha256,
        observed_sha256: outerEnvelopeArtifact.sha256, matches: true};
    }
    if (binding.path === 'conformance/evidence/invocations/validator-evidence-reference.json') {
      return {path: outerInvocationArtifact.path, expected_sha256: outerInvocationArtifact.sha256,
        observed_sha256: outerInvocationArtifact.sha256, matches: true};
    }
    return binding;
  });
  recovery.recomputed_bindings.push({
    path: nestedClaimArtifact.path,
    expected_sha256: nestedClaimArtifact.sha256,
    observed_sha256: nestedClaimArtifact.sha256,
    matches: true,
  });

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_binding_set_mismatch'));
});

test('recovery cannot upgrade unsupported to pass without fresh evidence', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.prior_verdict = 'unsupported';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.recovery_verdict_upgrade'));
});

test('recovery rejects a freshness Boolean bound to incomplete mandatory evidence', async () => {
  const claimPath = 'conformance/claim-manifests/core.json';
  const claimContent = await readFile(new URL(`../${claimPath}`, import.meta.url));
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.claim_id = 'CLAIM-CORE-001';
  recovery.claim = {claim_id: recovery.claim_id, path: claimPath, sha256: digest(claimContent)};
  recovery.prior_verdict = 'inconclusive';
  recovery.fresh_evidence_supplied = true;
  recovery.recomputed_bindings = [{
    path: claimPath,
    expected_sha256: digest(claimContent),
    observed_sha256: digest(claimContent),
    matches: true,
  }];
  recovery.terminal_state = 'awaiting_evidence';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_required'));
});

test('recovery rejects unchanged recorded evidence presented as fresh', async () => {
  const recovery = JSON.parse(await readFile(
    new URL('../conformance/evidence/evidence-recovery-report.json', import.meta.url),
    'utf8',
  ));
  recovery.recorded_claim = structuredClone(recovery.claim);
  recovery.fresh_evidence_supplied = true;
  recovery.terminal_state = 'awaiting_evidence';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.fresh_evidence_replayed'));
});
