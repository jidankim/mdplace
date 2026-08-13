import {canonicalJson} from './semantic-kernel-core.mjs';
import {
  processingPolicyDigest,
  processingPolicyReceiptDigest,
  sha256Json,
  sourceProfileDigest,
} from './processing-policy-core.mjs';

function receipt(document, decision, code, policy, profile = null) {
  const request = document.request !== null && typeof document.request === 'object' ? document.request : null;
  const policyValid = policy !== null && typeof policy === 'object' &&
    typeof policy.policy_id === 'string' && typeof policy.policy_version === 'string';
  const policyReference = policyValid
    ? {policy_id: policy.policy_id, policy_version: policy.policy_version, policy_sha256: processingPolicyDigest(policy)}
    : {policy_id: 'policy:invalid', policy_version: '1.0.0', policy_sha256: sha256Json(policy ?? null)};
  const consentBinding = policyValid && request !== null
    ? policy.grants?.consent_bindings?.find(({consent_binding_id: id}) => id === request.consent_binding_id) ?? null
    : null;
  const profileReference = profile !== null && typeof profile.profile_id === 'string' &&
    typeof profile.profile_version === 'string'
    ? {profile_id: profile.profile_id, profile_version: profile.profile_version, profile_sha256: sourceProfileDigest(profile)}
    : null;
  const scenarioId = typeof document.scenario_id === 'string' && /^CPP-[0-9]{3}$/.test(document.scenario_id)
    ? document.scenario_id
    : 'CPP-000';
  const value = {
    schema_id: 'mdplace.processing-policy-receipt/v1',
    receipt_id: `receipt:${scenarioId.toLowerCase()}`,
    scenario_id: scenarioId,
    request_id: typeof request?.request_id === 'string' ? request.request_id : null,
    request_sha256: request === null ? null : sha256Json(request),
    payload_sha256: typeof request?.payload?.sha256 === 'string' ? request.payload.sha256 : null,
    consent_binding_id: typeof request?.consent_binding_id === 'string' ? request.consent_binding_id : null,
    consent_binding_sha256: consentBinding === null ? null : sha256Json(consentBinding),
    operation: ['processing_decision', 'intake_decision', 'policy_pair', 'recover_binding'].includes(document.operation)
      ? document.operation
      : 'processing_decision',
    decision,
    code,
    policy_ref: policyReference,
    source_profile_ref: profileReference,
    network_effect: 'none',
  };
  return canonicalJson({...value, receipt_sha256: processingPolicyReceiptDigest(value)});
}

export function processingPolicyObserved(
  document,
  {verdict, code = null, output, operations, terminal, illegal = false, effects = ['none']},
) {
  const profile = document.source_profile ?? null;
  return {
    verdict,
    codes: code === null ? [] : [code],
    outputs: [output],
    operations,
    receipts: [receipt(document, verdict === 'pass' ? 'allowed' : 'denied', code, document.policy, profile)],
    filesystem_effects: effects,
    network_effects: ['none'],
    terminal_state: terminal,
    illegal_transition: illegal,
  };
}

export function processingPolicyDenied(document, code, operation = 'processing_decision', illegal = false) {
  const intake = operation === 'intake_decision';
  const recovery = operation === 'recovery';
  const staleBinding = code.startsWith('source_profile.') &&
    (code.includes('mismatch') || code.includes('readback'));
  return processingPolicyObserved(document, {
    verdict: 'fail', code, output: intake ? 'intake denied' : recovery ? 'binding recovery denied' : 'processing denied',
    operations: intake
      ? ['validate Source Profile binding', 'apply default-deny Processing Policy']
      : ['validate processing request', 'apply default-deny Processing Policy'],
    terminal: intake ? staleBinding ? 'stale' : document.lifecycle?.source_profile_state ?? 'unbound'
      : recovery ? 'recovery_required' : 'denied', illegal,
  });
}
