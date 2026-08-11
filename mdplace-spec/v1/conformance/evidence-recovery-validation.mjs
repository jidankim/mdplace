import {createHash} from 'node:crypto';

import {readPackageFile} from './safe-path.mjs';
import {bindingMatches, descendValidation, isRecord, readJson} from './evidence-core.mjs';
import {
  expectedRecoveryBindings,
  freshClaimIsNew,
  hasFreshMandatoryEvidence,
  recordedClaimCodes,
  validateClaimBinding,
} from './evidence-freshness.mjs';

export async function recoveryCodes(document, packageRoot, context, observeNested) {
  const codes = [];
  let stale = false;
  const claimResult = await validateClaimBinding(
    document.claim,
    document.claim_id,
    packageRoot,
    context,
    observeNested,
    {allowDigestMismatch: true, retainSemanticFailure: true},
  );
  if (claimResult.document === null) codes.push(...claimResult.codes);
  if (claimResult.document !== null && claimResult.digestMatches === false) stale = true;
  if (document.fresh_evidence_supplied === false && !stale && claimResult.document !== null &&
      claimResult.document.claim_id === document.claim_id &&
      claimResult.document.verdict !== document.prior_verdict) {
    codes.push('evidence.recovery_claim_verdict_mismatch');
  }
  let recordedClaimResult = null;
  if (document.fresh_evidence_supplied === true) {
    if (isRecord(document.recorded_claim)) {
      recordedClaimResult = await validateClaimBinding(
        document.recorded_claim,
        document.claim_id,
        packageRoot,
        context,
        observeNested,
        {retainSemanticFailure: true},
      );
    }
    if (recordedClaimResult !== null && recordedClaimResult.document !== null &&
        recordedClaimResult.document.verdict !== document.prior_verdict) {
      codes.push('evidence.recovery_claim_verdict_mismatch');
    }
    if (claimResult.digestMatches !== true || claimResult.codes.length > 0 ||
        !hasFreshMandatoryEvidence(claimResult.document) ||
        claimResult.document?.verdict !== document.effective_verdict ||
        recordedClaimResult?.document === null || recordedClaimResult === null) {
      codes.push('evidence.fresh_evidence_required');
    } else if (!await freshClaimIsNew(
      document.recorded_claim,
      recordedClaimResult.document,
      claimResult.document,
      packageRoot,
    )) {
      codes.push('evidence.fresh_evidence_replayed');
    }
  } else if (isRecord(document.recorded_claim)) {
    codes.push('evidence.fresh_evidence_inconsistent');
  }
  const expectedBindings = await expectedRecoveryBindings(
    document.claim,
    packageRoot,
    recordedClaimResult?.document === null ? null : document.recorded_claim,
  );
  const recomputedBindings = Array.isArray(document.recomputed_bindings) ? document.recomputed_bindings : [];
  const suppliedBindings = new Map(recomputedBindings.map((binding) => [binding?.path, binding?.expected_sha256]));
  if (suppliedBindings.size !== recomputedBindings.length || expectedBindings.size !== suppliedBindings.size ||
      [...expectedBindings].some(([path, sha256]) => sha256 === null || suppliedBindings.get(path) !== sha256)) {
    codes.push('evidence.recovery_binding_set_mismatch');
  }
  for (const binding of recomputedBindings) {
    if (!isRecord(binding)) {
      codes.push('evidence.recovery_binding_mismatch');
      stale = true;
      continue;
    }
    const read = await readPackageFile(packageRoot, binding.path);
    const actual = read.status === 'present' ? createHash('sha256').update(read.content).digest('hex') : null;
    const actualMatch = actual !== null && actual === binding.expected_sha256;
    if (!actualMatch) stale = true;
    if (actual !== binding.observed_sha256 || binding.matches !== actualMatch) {
      codes.push('evidence.recovery_binding_mismatch');
    }
  }
  if (claimResult.codes.length > 0) codes.push(...recordedClaimCodes(claimResult.codes, stale));
  if (recordedClaimResult?.codes.length > 0) {
    codes.push(...recordedClaimCodes(recordedClaimResult.codes, stale));
  }
  if (document.fresh_evidence_supplied === false) {
    const expectedVerdict = stale && document.prior_verdict === 'pass' ? 'inconclusive' : document.prior_verdict;
    if (document.effective_verdict !== expectedVerdict &&
        !(stale && document.prior_verdict === 'pass' && document.effective_verdict === 'pass')) {
      codes.push('evidence.recovery_verdict_upgrade');
    }
  }
  if (stale && document.fresh_evidence_supplied === false) {
    if (document.effective_verdict === 'pass') codes.push('evidence.recovery_stale_pass');
    if (document.terminal_state !== 'evidence_stale') codes.push('evidence.recovery_state_invalid');
  } else if (!stale && document.fresh_evidence_supplied === false && document.terminal_state !== 'verdict_recorded') {
    codes.push('evidence.recovery_state_invalid');
  }
  if (document.fresh_evidence_supplied === true && document.terminal_state !== 'awaiting_evidence') {
    codes.push('evidence.recovery_state_invalid');
  }
  return codes;
}

export async function validateRecoveryReportBinding(binding, packageRoot, context, observeNested) {
  if (!isRecord(binding) || typeof binding.report_id !== 'string' ||
      typeof binding.path !== 'string' || typeof binding.sha256 !== 'string' ||
      !await bindingMatches(packageRoot, binding.path, binding.sha256)) {
    return {codes: ['evidence.recovery_report_binding_mismatch'], document: null};
  }
  const document = await readJson(packageRoot, binding.path);
  if (document === null || document.report_id !== binding.report_id) {
    return {codes: ['evidence.recovery_report_binding_mismatch'], document: null};
  }
  const nestedContext = descendValidation(context, binding);
  if (nestedContext === null) return {codes: ['evidence.validation_cycle'], document: null};
  const observed = await observeNested({
    extension_id: 'mdplace.validator-extension/evidence/v1',
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document,
  }, packageRoot, nestedContext);
  return {codes: observed.verdict === 'pass' ? [] : observed.codes, document, observed};
}
