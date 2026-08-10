import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {
  addFreshInput,
  digest,
  extensionId,
  transitionAttempt,
  writeJson,
} from './validator-evidence-support.mjs';

const claimPath = 'conformance/evidence/claims/recovery-snapshot.json';
const envelopePath = 'conformance/evidence/envelopes/validator-evidence-reference.json';
const invocationPath = 'conformance/evidence/invocations/validator-evidence-reference.json';
const reportPath = 'conformance/evidence/evidence-recovery-report.json';

async function subjectArtifact(packageRoot, kind) {
  const reportContent = await readFile(`${packageRoot}/${reportPath}`);
  const report = JSON.parse(reportContent.toString('utf8'));
  if (kind === 'recovery') {
    return {
      subject: {
        kind: 'recovery_report',
        subject_id: 'recovery:nested-report',
        path: reportPath,
        schema: 'contracts/schemas/evidence-recovery-report.schema.json',
        sha256: digest(reportContent),
      },
      descendant: report.claim,
    };
  }
  const transition = {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: '1.1.0',
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'verdict_recorded',
    command: 'readback',
    actor_authority: {
      roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden',
    },
    fresh_evidence_supplied: false,
    recorded_claim: null,
    recovery_report: {report_id: report.report_id, path: reportPath, sha256: digest(reportContent)},
    fresh_claim: null,
  };
  const artifact = await writeJson(packageRoot, 'conformance/evidence/nested-transition-attempt.json', transition);
  return {
    subject: {
      kind: 'transition_attempt',
      subject_id: 'transition:nested-readback',
      path: artifact.path,
      schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
      sha256: artifact.sha256,
    },
    descendant: transition.recovery_report,
  };
}

async function outerClaimChain(packageRoot, suffix, subject) {
  const invocation = JSON.parse(await readFile(`${packageRoot}/${invocationPath}`, 'utf8'));
  invocation.invocation_id = `invocation:${suffix}`;
  invocation.subject = subject;
  const invocationArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/invocations/${suffix}.json`,
    invocation,
  );

  const envelope = JSON.parse(await readFile(`${packageRoot}/${envelopePath}`, 'utf8'));
  envelope.envelope_id = `evidence:${suffix}`;
  envelope.invocation = {
    invocation_id: invocation.invocation_id,
    path: invocationArtifact.path,
    sha256: invocationArtifact.sha256,
  };
  const envelopeSubject = structuredClone(subject);
  delete envelopeSubject.path;
  envelope.subject = envelopeSubject;
  envelope.receipts[0].receipt_id = `receipt:${suffix}`;
  const envelopeArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/envelopes/${suffix}.json`,
    envelope,
  );

  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  const claimSubject = structuredClone(envelopeSubject);
  delete claimSubject.schema;
  claim.subject = claimSubject;
  claim.evidence_bindings[0].evidence_ref = envelopeArtifact.path;
  claim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
  const claimArtifact = await writeJson(packageRoot, `conformance/evidence/claims/${suffix}.json`, claim);
  return {
    claim,
    claimBinding: {claim_id: claim.claim_id, path: claimArtifact.path, sha256: claimArtifact.sha256},
    envelope,
    envelopeArtifact,
    invocation,
    invocationArtifact,
  };
}

async function recoveryForOuterClaim(packageRoot, chain, subject) {
  const recovery = JSON.parse(await readFile(`${packageRoot}/${reportPath}`, 'utf8'));
  recovery.claim = structuredClone(chain.claimBinding);
  recovery.recomputed_bindings = recovery.recomputed_bindings.map((binding) => {
    if (binding.path === claimPath) {
      return {path: chain.claimBinding.path, expected_sha256: chain.claimBinding.sha256,
        observed_sha256: chain.claimBinding.sha256, matches: true};
    }
    if (binding.path === envelopePath) {
      return {path: chain.envelopeArtifact.path, expected_sha256: chain.envelopeArtifact.sha256,
        observed_sha256: chain.envelopeArtifact.sha256, matches: true};
    }
    if (binding.path === invocationPath) {
      return {path: chain.invocationArtifact.path, expected_sha256: chain.invocationArtifact.sha256,
        observed_sha256: chain.invocationArtifact.sha256, matches: true};
    }
    return binding;
  });
  recovery.recomputed_bindings.push({
    path: subject.path,
    expected_sha256: subject.sha256,
    observed_sha256: subject.sha256,
    matches: true,
  });
  return recovery;
}

test('recovery bindings descend through Recovery Report and Transition Attempt subjects', async () => {
  for (const kind of ['recovery', 'transition']) {
    const packageRoot = await copyCommittedPackage();
    const nested = await subjectArtifact(packageRoot, kind);
    const chain = await outerClaimChain(packageRoot, `outer-${kind}-subject`, nested.subject);
    const recovery = await recoveryForOuterClaim(packageRoot, chain, nested.subject);

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-recovery-report.schema.json',
      document: recovery,
    }, packageRoot);

    assert.equal(observed.verdict, 'fail', kind);
    assert.ok(observed.codes.includes('evidence.recovery_binding_set_mismatch'), kind);
  }
});

test('fresh evidence rejects a digest nested below a recorded Recovery Report subject', async () => {
  const packageRoot = await copyCommittedPackage();
  const nested = await subjectArtifact(packageRoot, 'recovery');
  const recorded = await outerClaimChain(packageRoot, 'recorded-recovery-subject', nested.subject);
  const fresh = await outerClaimChain(packageRoot, 'fresh-recovery-subject', nested.subject);
  const chain = {
    freshClaim: fresh.claim,
    freshClaimBinding: fresh.claimBinding,
    envelopeArtifact: fresh.envelopeArtifact,
    invocationArtifact: fresh.invocationArtifact,
  };
  await addFreshInput(packageRoot, chain, {...nested.descendant, kind: 'nested_claim'});

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document: transitionAttempt({
      command: 'supply_fresh_evidence',
      fromState: 'verdict_recorded',
      recordedClaim: recorded.claimBinding,
      freshClaim: chain.freshClaimBinding,
    }),
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(
    observed.codes.includes('evidence.fresh_evidence_replayed'),
    `unexpected codes: ${observed.codes.join(', ')}`,
  );
});
