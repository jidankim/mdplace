import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {
  policyNarrowingViolation,
  processingPolicyDigest,
  recoveryJournalDigest,
  sha256Json,
  sourceProfileApprovalDigest,
  sourceProfileDigest,
  valuesAreSubset,
} from './processing-policy-core.mjs';

function receipt(document, decision, code, policy, profile = null) {
  return canonicalJson({
    schema_id: 'mdplace.processing-policy-receipt/v1',
    receipt_id: `receipt:${document.scenario_id.toLowerCase()}`,
    scenario_id: document.scenario_id,
    operation: document.operation,
    decision,
    code,
    policy_ref: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_sha256: processingPolicyDigest(policy),
    },
    source_profile_ref: profile === null ? null : {
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      profile_sha256: sourceProfileDigest(profile),
    },
  });
}

function observed(document, {verdict, code = null, output, operations, terminal, illegal = false, effects = ['none']}) {
  const profile = document.source_profile === null ? null : document.source_profile;
  return {
    verdict,
    codes: code === null ? [] : [code],
    outputs: [output],
    operations,
    receipts: [receipt(document, verdict === 'pass' ? 'allowed' : 'denied', code, document.policy, profile)],
    filesystem_effects: effects,
    terminal_state: terminal,
    illegal_transition: illegal,
  };
}

function denied(document, code, operation = 'processing_decision', illegal = false) {
  const intake = operation === 'intake_decision';
  const recovery = operation === 'recovery';
  return observed(document, {
    verdict: 'fail', code, output: intake ? 'intake denied' : recovery ? 'binding recovery denied' : 'processing denied',
    operations: intake
      ? ['validate Source Profile binding', 'apply default-deny Processing Policy']
      : ['validate processing request', 'apply default-deny Processing Policy'],
    terminal: intake ? document.lifecycle.source_profile_state : recovery ? 'recovery_required' : 'denied', illegal,
  });
}

async function schemaCode(packageRoot, path, value) {
  if (value === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, path, value));
  } catch {
    return 'schema.instance_missing';
  }
}

function fallbackMatches(request, policy) {
  if (request.fallback_position === 0) return true;
  const fallback = policy.grants.fallback_chain.find(({position}) => position === request.fallback_position);
  return fallback !== undefined && fallback.provider_id === request.provider_id &&
    fallback.purpose_id === request.purpose_id && fallback.destination_id === request.destination_id &&
    fallback.credential_ref === request.credential_ref;
}

function processingDenialCode(policy, request) {
  const policyDigest = processingPolicyDigest(policy);
  if (policy.lifecycle_state !== 'active') return 'policy.inactive';
  if (request.policy_binding.policy_id !== policy.policy_id ||
      request.policy_binding.policy_version !== policy.policy_version) return 'policy.version_mismatch';
  if (request.policy_binding.policy_sha256 !== policyDigest) return 'policy.digest_mismatch';
  if (policy.approval.approved !== true || policy.approval.role !== 'vault_owner' || policy.approval.delegated) {
    return 'policy.approval_denied';
  }
  if (!policy.grants.provider_ids.includes(request.provider_id)) return 'policy.provider_denied';
  if (!policy.grants.purpose_ids.includes(request.purpose_id)) return 'policy.purpose_denied';
  const fieldMap = new Map(policy.grants.fields.map((field) => [field.field_id, field]));
  if (request.field_ids.some((fieldId) => !fieldMap.has(fieldId))) return 'policy.field_denied';
  if (!valuesAreSubset(request.artifact_kinds, policy.grants.artifact_kinds)) return 'policy.artifact_denied';
  const destination = policy.grants.destinations.find(({destination_id: id}) => id === request.destination_id);
  if (destination === undefined || destination.provider_id !== request.provider_id) return 'policy.destination_denied';
  const boundary = policy.grants.credential_boundaries.find(({credential_ref: ref}) => ref === request.credential_ref);
  if (boundary === undefined || boundary.provider_id !== request.provider_id) return 'policy.credential_boundary_denied';
  if (!boundary.purpose_ids.includes(request.purpose_id)) return 'policy.credential_purpose_denied';
  if (Object.keys(policy.grants.budget).some((key) => request.budget[key] > policy.grants.budget[key])) return 'policy.budget_exceeded';
  if (Object.keys(policy.grants.retry).some((key) => request.retry[key] > policy.grants.retry[key])) return 'policy.retry_exceeded';
  if (!fallbackMatches(request, policy)) return 'policy.fallback_denied';
  if (!valuesAreSubset(request.capabilities, policy.grants.capabilities)) return 'policy.capability_denied';
  if (!valuesAreSubset(request.semantic_authority, policy.grants.semantic_authority)) return 'policy.semantic_authority_denied';
  if (!valuesAreSubset(request.automation_scope, policy.grants.automation_scope)) return 'policy.automation_scope_denied';
  const requiredRedactions = request.field_ids.map((fieldId) => fieldMap.get(fieldId).redaction_rule_id);
  if (!valuesAreSubset(requiredRedactions, request.redaction_receipt_ids)) return 'policy.redaction_unproven';
  const retention = policy.retention_facts.find(({retention_fact_id: id}) => id === destination.retention_fact_id);
  if (retention === undefined || retention.destination_id !== destination.destination_id ||
      !request.retention_fact_ids.includes(destination.retention_fact_id) ||
      (retention.status === 'unknown' && !retention.risk_acknowledged)) return 'policy.retention_unproven';
  if (request.untrusted_content.requested_actions.length > 0) return 'policy.hostile_content_capability_denied';
  return null;
}

async function observeProcessing(document, packageRoot) {
  const requestCode = await schemaCode(packageRoot, 'contracts/schemas/processing-request.schema.json', document.request);
  if (requestCode !== null) return denied(document, requestCode);
  const code = processingDenialCode(document.policy, document.request);
  if (code !== null) return denied(document, code);
  return observed(document, {
    verdict: 'pass', output: 'processing allowed',
    operations: ['validate processing request', 'apply default-deny Processing Policy'], terminal: 'allowed',
  });
}

function sourceProfileBindingCode(document, requireActive = true) {
  const {observed_binding: observed, policy, source_profile: profile} = document;
  if (requireActive && document.lifecycle.source_profile_state !== 'active') {
    return document.lifecycle.source_profile_state === 'stale' ? 'source_profile.stale' : 'source_profile.binding_required';
  }
  if (observed === null) return 'source_profile.readback_failed';
  if (profile.approval.approved !== true || profile.approval.role !== 'vault_owner' || profile.approval.delegated) {
    return 'source_profile.approval_denied';
  }
  if (profile.approval.profile_payload_sha256 !== sourceProfileApprovalDigest(profile)) return 'source_profile.approval_readback_failed';
  if (observed.profile_id !== profile.profile_id || observed.profile_version !== profile.profile_version) return 'source_profile.version_mismatch';
  if (observed.profile_sha256 !== sourceProfileDigest(profile) || observed.approval_receipt_id !== profile.approval.receipt_id) {
    return 'source_profile.readback_failed';
  }
  if (!isDeepStrictEqual(observed.capture_source, profile.capture_source) ||
      !isDeepStrictEqual(observed.candidate_schema, profile.candidate_schema)) return 'source_profile.source_binding_mismatch';
  if (!isDeepStrictEqual(observed.template, profile.template)) return 'source_profile.template_binding_mismatch';
  if (observed.url_retention_mode !== profile.url_retention_mode) return 'source_profile.url_retention_mode_mismatch';
  if (!isDeepStrictEqual(observed.capture_contract, profile.capture_contract)) return 'source_profile.capture_contract_mismatch';
  if (profile.processing_policy.policy_id !== policy.policy_id ||
      profile.processing_policy.policy_version !== policy.policy_version) return 'policy.version_mismatch';
  if (profile.processing_policy.policy_sha256 !== processingPolicyDigest(policy) ||
      !isDeepStrictEqual(observed.processing_policy, profile.processing_policy)) return 'policy.digest_mismatch';
  return null;
}

async function observeIntake(document, packageRoot) {
  if (document.source_profile === null) return denied(document, 'source_profile.binding_required', 'intake_decision', true);
  const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', document.source_profile);
  if (profileCode !== null) return denied(document, profileCode, 'intake_decision');
  const bindingCode = sourceProfileBindingCode(document);
  if (bindingCode !== null) return denied(document, bindingCode, 'intake_decision', bindingCode === 'source_profile.binding_required');
  const requestCode = await schemaCode(packageRoot, 'contracts/schemas/processing-request.schema.json', document.request);
  if (requestCode !== null) return denied(document, requestCode, 'intake_decision');
  const policyCode = processingDenialCode(document.policy, document.request);
  if (policyCode !== null) return denied(document, policyCode, 'intake_decision');
  return observed(document, {
    verdict: 'pass', output: 'intake allowed',
    operations: ['validate Source Profile binding', 'apply default-deny Processing Policy'], terminal: 'active',
  });
}

async function observePolicyPair(document, packageRoot) {
  const childCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy.schema.json', document.descendant_policy);
  if (childCode !== null) return denied(document, childCode, 'policy_pair');
  const violation = policyNarrowingViolation(document.policy, document.descendant_policy);
  if (violation !== null) return denied(document, violation, 'policy_pair');
  return observed(document, {
    verdict: 'pass', output: 'policy narrowing accepted',
    operations: ['validate parent policy binding', 'compare every permission dimension'], terminal: 'active',
  });
}

function observeRecovery(document) {
  const recovery = document.recovery;
  const {crash_point: point} = recovery;
  if (document.lifecycle.source_profile_state !== 'recovery_required') {
    return denied(document, 'source_profile.recovery_not_required', 'recovery', true);
  }
  const beforeApproval = point === 'before_approval_receipt_publish';
  const afterBinding = point === 'after_binding_publish';
  const profile = document.source_profile;
  const journalMatches = recovery.journal_sha256 === recoveryJournalDigest(recovery) && profile !== null &&
    recovery.source_profile_sha256 === sourceProfileDigest(profile);
  if (!journalMatches) return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
  if (beforeApproval) {
    if (recovery.approval_payload_sha256 !== null || recovery.approval_receipt_id !== null ||
        recovery.observed_binding_sha256 !== null) {
      return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
    }
  } else {
    const approvalMatches = profile.approval.approved === true && profile.approval.role === 'vault_owner' &&
      profile.approval.delegated === false &&
      recovery.approval_payload_sha256 === sourceProfileApprovalDigest(profile) &&
      recovery.approval_receipt_id === profile.approval.receipt_id &&
      document.observed_binding !== null &&
      recovery.observed_binding_sha256 === sha256Json(document.observed_binding) &&
      sourceProfileBindingCode(document, false) === null;
    if (!approvalMatches) return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
  }
  return observed(document, {
    verdict: 'pass', output: beforeApproval
      ? 'binding recovery returned unbound'
      : afterBinding ? 'published binding recovery preserved idempotently' : 'binding recovery completed',
    operations: beforeApproval
      ? ['read binding journal', 'discard unapproved Source Profile']
      : afterBinding
        ? ['read binding journal', 'validate approval receipt', 'read back published Source Profile binding']
        : ['read binding journal', 'validate approval receipt', 'read back exact Source Profile binding'],
    terminal: beforeApproval ? 'unbound' : 'active',
    effects: beforeApproval
      ? ['discard unapproved binding staging']
      : afterBinding ? ['preserve approved binding'] : ['publish or preserve approved binding'],
  });
}

export async function observeProcessingPolicyScenario(subject, packageRoot) {
  const scenarioCode = await schemaCode(packageRoot, subject.schema, subject.document);
  if (scenarioCode !== null) {
    const document = subject.document;
    return denied(document, scenarioCode, document.operation ?? 'processing_decision');
  }
  const policyCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy.schema.json', subject.document.policy);
  if (policyCode !== null) return denied(subject.document, policyCode, subject.document.operation);
  switch (subject.document.operation) {
    case 'processing_decision': return observeProcessing(subject.document, packageRoot);
    case 'intake_decision': return observeIntake(subject.document, packageRoot);
    case 'policy_pair': return observePolicyPair(subject.document, packageRoot);
    case 'recover_binding': return observeRecovery(subject.document);
    default: throw new Error('scenario schema allowed an unknown operation');
  }
}
