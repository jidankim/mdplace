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

export function observeProcessingPolicyLifecycleTransition(table, attempt) {
  const rows = table?.transitions?.filter((row) => row.transition_id === attempt.transition_id &&
    row.from_state === attempt.from_state && row.command_or_event === attempt.command_or_event) ?? [];
  const row = rows.length === 1 ? rows[0] : null;
  const invalid = () => ({
    verdict: 'fail', codes: ['policy.lifecycle_oracle_invalid'], outputs: ['lifecycle transition denied'],
    operations: ['validate lifecycle transition'], receipts: [], filesystem_effects: ['none'],
    network_effects: ['none'], terminal_state: attempt.from_state, illegal_transition: true,
  });
  if (row === null || row.allowed) return invalid();
  const authority = row.actor_authority;
  const actors = Array.isArray(attempt.actors) ? attempt.actors : [];
  const eligible = actors.filter(({delegated, roles}) => !delegated &&
    roles.some((role) => authority.roles.includes(role)));
  const references = Array.isArray(attempt.base_references) ? attempt.base_references : [];
  const referenceKeys = references.map(({key}) => key);
  const expectedIdempotencyKey = `lifecycle:${sha256Json({
    table_id: table.table_id, transition_id: row.transition_id, base_references: references,
  })}`;
  if ((authority.delegation === 'forbidden' && actors.some(({delegated}) => delegated)) ||
      new Set(eligible.map(({principal_id: id}) => id)).size < authority.quorum ||
      authority.roles.some((role) => !eligible.some(({roles}) => roles.includes(role))) ||
      (authority.distinct_actors && new Set(eligible.map(({principal_id: id}) => id)).size !== eligible.length) ||
      new Set(referenceKeys).size !== referenceKeys.length ||
      !row.base_references.every((key) => referenceKeys.includes(key)) ||
      referenceKeys.length !== row.base_references.length || attempt.idempotency_key !== expectedIdempotencyKey) {
    return invalid();
  }
  return {
    verdict: 'fail', codes: [row.failure_result.code], outputs: ['lifecycle transition denied'],
    operations: ['validate lifecycle transition'], receipts: row.failure_result.emitted_records,
    filesystem_effects: row.failure_result.filesystem_effects, network_effects: ['none'],
    terminal_state: row.failure_result.state_effect === 'unchanged'
      ? row.from_state
      : row.failure_result.state_effect,
    illegal_transition: true,
  };
}
