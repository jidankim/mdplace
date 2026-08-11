import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export const extensionId = 'mdplace.validator-extension/evidence/v1';
export const validatorVersion = '1.1.0';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const committedPackageRoot = fileURLToPath(new URL('../', import.meta.url));

export async function writeJson(packageRoot, path, document) {
  const content = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(`${packageRoot}/${path}`, content);
  return {document, path, content, sha256: digest(content)};
}

export async function createFreshClaimChain(packageRoot, {
  suffix = 'fresh-validator-evidence',
  reuseInvocationId = false,
  substantive = true,
} = {}) {
  const recordedClaimPath = 'conformance/evidence/claims/recovery-snapshot.json';
  const recordedClaimContent = await readFile(`${packageRoot}/${recordedClaimPath}`);
  const recordedClaim = JSON.parse(recordedClaimContent.toString('utf8'));
  const invocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  if (!reuseInvocationId) invocation.invocation_id = `invocation:${suffix}`;
  let freshArtifact = null;
  if (substantive) {
    freshArtifact = await writeJson(packageRoot, `conformance/evidence/${suffix}-observation.json`, {
      observation: suffix,
    });
    invocation.input_digests.push({
      ordinal: invocation.input_digests.length,
      label: 'fresh_observation',
      path: freshArtifact.path,
      sha256: freshArtifact.sha256,
    });
  }
  const invocationArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/invocations/${suffix}.json`,
    invocation,
  );
  const envelope = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/envelopes/validator-evidence-reference.json`,
    'utf8',
  ));
  envelope.envelope_id = `evidence:${suffix}`;
  envelope.invocation = {
    invocation_id: invocation.invocation_id,
    path: invocationArtifact.path,
    sha256: invocationArtifact.sha256,
  };
  envelope.receipts[0].receipt_id = `receipt:${suffix}`;
  if (freshArtifact !== null) {
    envelope.input_digests.push({...invocation.input_digests.at(-1)});
  }
  const envelopeArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/envelopes/${suffix}.json`,
    envelope,
  );
  const freshClaim = structuredClone(recordedClaim);
  freshClaim.evidence_bindings[0].evidence_ref = envelopeArtifact.path;
  freshClaim.evidence_bindings[0].evidence_digest = envelopeArtifact.sha256;
  const claimArtifact = await writeJson(
    packageRoot,
    `conformance/evidence/claims/${suffix}.json`,
    freshClaim,
  );
  return {
    recordedClaim,
    recordedClaimBinding: {
      claim_id: recordedClaim.claim_id,
      path: recordedClaimPath,
      sha256: digest(recordedClaimContent),
    },
    freshClaim,
    freshClaimBinding: {
      claim_id: freshClaim.claim_id,
      path: claimArtifact.path,
      sha256: claimArtifact.sha256,
    },
    invocationArtifact,
    envelopeArtifact,
    freshArtifact,
  };
}

export async function addFreshInput(packageRoot, chain, binding) {
  const invocation = JSON.parse(await readFile(`${packageRoot}/${chain.invocationArtifact.path}`, 'utf8'));
  const input = {
    ordinal: invocation.input_digests.length,
    label: `recorded_${binding.kind}`,
    path: binding.path,
    sha256: binding.sha256,
  };
  invocation.input_digests.push(input);
  chain.invocationArtifact = await writeJson(packageRoot, chain.invocationArtifact.path, invocation);

  const envelope = JSON.parse(await readFile(`${packageRoot}/${chain.envelopeArtifact.path}`, 'utf8'));
  envelope.input_digests.push(input);
  envelope.invocation.sha256 = chain.invocationArtifact.sha256;
  chain.envelopeArtifact = await writeJson(packageRoot, chain.envelopeArtifact.path, envelope);

  chain.freshClaim.evidence_bindings[0].evidence_digest = chain.envelopeArtifact.sha256;
  const claimArtifact = await writeJson(packageRoot, chain.freshClaimBinding.path, chain.freshClaim);
  chain.freshClaimBinding.sha256 = claimArtifact.sha256;
}

export async function createFreshRecoveryReport(packageRoot, chain, suffix = 'fresh-supply') {
  const report = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  report.report_id = `evidence-recovery:${suffix}`;
  report.claim = structuredClone(chain.freshClaimBinding);
  report.recorded_claim = structuredClone(chain.recordedClaimBinding);
  report.prior_verdict = chain.recordedClaim.verdict;
  report.fresh_evidence_supplied = true;
  for (const artifact of [chain.freshClaimBinding, chain.envelopeArtifact, chain.invocationArtifact, chain.freshArtifact]) {
    if (artifact === null) continue;
    report.recomputed_bindings.push({
      path: artifact.path,
      expected_sha256: artifact.sha256,
      observed_sha256: artifact.sha256,
      matches: true,
    });
  }
  report.operations = ['reopen declared artifact', 'recompute sha256', 'accept fresh required evidence'];
  report.terminal_state = 'awaiting_evidence';
  report.effective_verdict = chain.freshClaim.verdict;
  const artifact = await writeJson(packageRoot, `conformance/evidence/${suffix}-report.json`, report);
  return {
    report,
    binding: {report_id: report.report_id, path: artifact.path, sha256: artifact.sha256},
  };
}

export function transitionAttempt({command, fromState, freshClaim, recordedClaim = null, recoveryReport = null}) {
  return {
    $schema: '../../contracts/schemas/evidence-transition-attempt.schema.json',
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: fromState,
    command,
    actor_authority: command === 'record_verdict'
      ? {roles: ['conformance_validator'], quorum: 1, distinct_actors: false, delegation: 'forbidden'}
      : {roles: ['evidence_supplier'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
    fresh_evidence_supplied: true,
    recorded_claim: recordedClaim,
    recovery_report: recoveryReport,
    fresh_claim: freshClaim,
  };
}

export function schemaFor(document) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:mdplace:test:${document.schema_id}`,
    type: 'object',
    additionalProperties: false,
    required: Object.keys(document),
    properties: Object.fromEntries(Object.keys(document).map((key) => [key, {}])),
  };
}

export function expected({verdict, codes, output, operations, terminalState, illegalTransition = false}) {
  return {
    verdict,
    codes,
    outputs: [output],
    operations,
    receipts: ['EvidenceValidationReceipt'],
    filesystem_effects: ['none'],
    terminal_state: terminalState,
    illegal_transition: illegalTransition,
  };
}
