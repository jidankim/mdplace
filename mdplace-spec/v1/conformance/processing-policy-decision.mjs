import {isDeepStrictEqual} from 'node:util';

import {
  approvalReceiptDigest,
  processingPolicyApprovalDigest,
  processingPolicyDigest,
  redactionReceiptDigest,
  sha256Text,
  sourceProfileApprovalDigest,
  sourceProfileDigest,
  valuesHaveUniqueKey,
  valuesAreSubset,
} from './processing-policy-core.mjs';

function policyCollectionCode(policy) {
  if (!valuesHaveUniqueKey(policy.grants.fields, 'field_id')) return 'policy.field_denied';
  if (!valuesHaveUniqueKey(policy.grants.destinations, 'destination_id') ||
      !valuesHaveUniqueKey(policy.grants.consent_bindings, 'consent_binding_id')) {
    return 'policy.destination_denied';
  }
  if (!valuesHaveUniqueKey(policy.grants.credential_boundaries, 'credential_ref')) {
    return 'policy.credential_boundary_denied';
  }
  if (!valuesHaveUniqueKey(policy.redaction_obligations, 'redaction_rule_id')) {
    return 'policy.redaction_unproven';
  }
  if (!valuesHaveUniqueKey(policy.retention_facts, 'retention_fact_id')) return 'policy.retention_unproven';
  return null;
}

function consentBindingCode(policy, request) {
  const scope = policy.grants.consent_bindings.find(({consent_binding_id: id}) =>
    id === request.consent_binding_id);
  if (scope === undefined || scope.adapter_id !== request.adapter_id ||
      scope.provider_id !== request.provider_id || scope.purpose_id !== request.purpose_id ||
      scope.destination_id !== request.destination_id || scope.credential_ref !== request.credential_ref ||
      scope.retention_fact_id !== request.destination.retention_fact_id) return 'policy.destination_denied';
  if (!valuesAreSubset(request.field_ids, scope.field_ids) ||
      !valuesAreSubset(request.artifact_kinds, scope.artifact_kinds)) return 'policy.destination_denied';
  return null;
}

function fallbackMatches(request, policy) {
  if (request.fallback_position === 0) return true;
  const fallback = policy.grants.fallback_chain.find(({position}) => position === request.fallback_position);
  return fallback !== undefined && fallback.provider_id === request.provider_id &&
    fallback.purpose_id === request.purpose_id && fallback.destination_id === request.destination_id &&
    fallback.credential_ref === request.credential_ref;
}

function redactionsProven(document, policyDigest) {
  const {request} = document;
  const receiptsById = new Map(document.redaction_receipts.map((value) => [value.receipt_id, value]));
  return request.field_grants.every((field) => {
    const ref = request.redaction_receipt_refs.find(({receipt_id: id}) =>
      id === `redaction-receipt:${field.field_id.slice('field:'.length)}`);
    const proof = ref === undefined ? undefined : receiptsById.get(ref.receipt_id);
    return proof !== undefined && document.trusted_context.redaction_receipt_sha256s.includes(ref.receipt_sha256) &&
      ref.receipt_sha256 === redactionReceiptDigest(proof) &&
      proof.receipt_sha256 === ref.receipt_sha256 && proof.request_id === request.request_id &&
      isDeepStrictEqual(proof.policy_ref, request.policy_binding) && proof.policy_ref.policy_sha256 === policyDigest &&
      proof.payload_sha256 === request.payload.sha256 && isDeepStrictEqual(proof.field_grant, field) &&
      proof.outcome === 'applied' && proof.issuer === 'mdplace_local_redactor' &&
      proof.identity_assurance === 'trusted_local_redactor' &&
      proof.verification_method === 'local_redaction_digest_readback';
  });
}

function approvalEvidenceCode(document, subjectKind, subject) {
  const approval = subject.approval;
  const payloadDigest = subjectKind === 'processing_policy'
    ? processingPolicyApprovalDigest(subject)
    : sourceProfileApprovalDigest(subject);
  const declaredPayloadDigest = subjectKind === 'processing_policy'
    ? approval.policy_payload_sha256
    : approval.profile_payload_sha256;
  if (approval.approved !== true || approval.role !== 'vault_owner' || approval.delegated ||
      approval.principal_id !== document.trusted_context.owner_principal_id) return 'approval_denied';
  const trustedBindings = subjectKind === 'processing_policy'
    ? document.trusted_context.policy_bindings
    : document.trusted_context.source_profile_bindings;
  const subjectDigest = subjectKind === 'processing_policy'
    ? processingPolicyDigest(subject)
    : sourceProfileDigest(subject);
  const lifecycleState = subjectKind === 'processing_policy'
    ? document.lifecycle.policy_state
    : document.lifecycle.source_profile_state;
  const current = trustedBindings.filter((binding) => binding.lifecycle_state === lifecycleState &&
    binding[subjectKind === 'processing_policy' ? 'policy_id' : 'profile_id'] ===
      (subjectKind === 'processing_policy' ? subject.policy_id : subject.profile_id) &&
    binding[subjectKind === 'processing_policy' ? 'policy_version' : 'profile_version'] ===
      (subjectKind === 'processing_policy' ? subject.policy_version : subject.profile_version) &&
    binding[subjectKind === 'processing_policy' ? 'policy_sha256' : 'profile_sha256'] === subjectDigest);
  if (current.length !== 1) return 'approval_readback_failed';
  const receipt = document.approval_receipts.find(({receipt_id: id}) => id === approval.receipt_id);
  const subjectId = subjectKind === 'processing_policy' ? subject.policy_id : subject.profile_id;
  const subjectVersion = subjectKind === 'processing_policy' ? subject.policy_version : subject.profile_version;
  if (declaredPayloadDigest !== payloadDigest || receipt === undefined ||
      receipt.receipt_sha256 !== approval.receipt_sha256 ||
      receipt.receipt_sha256 !== approvalReceiptDigest(receipt) ||
      !document.trusted_context.approval_receipt_sha256s.includes(receipt.receipt_sha256) ||
      receipt.subject_kind !== subjectKind || receipt.subject_id !== subjectId ||
      receipt.subject_version !== subjectVersion || receipt.vault_id !== subject.vault_id ||
      receipt.subject_payload_sha256 !== payloadDigest || receipt.approved !== approval.approved ||
      receipt.principal_id !== approval.principal_id || receipt.role !== approval.role ||
      receipt.identity_assurance !== 'canonical_authenticated_human' ||
      receipt.verification_method !== 'authenticated_foreground_approval' ||
      receipt.delegated !== approval.delegated) return 'approval_readback_failed';
  return null;
}

export function approvalReadbackCode(document, subjectKind, subject) {
  return approvalEvidenceCode(document, subjectKind, subject);
}

export function processingDenialCode(document) {
  const {policy, request} = document;
  const policyDigest = processingPolicyDigest(policy);
  if (policy.lifecycle_state !== 'active' || document.lifecycle.policy_state !== 'active') return 'policy.inactive';
  if (request.policy_binding.policy_id !== policy.policy_id ||
      request.policy_binding.policy_version !== policy.policy_version) return 'policy.version_mismatch';
  if (request.policy_binding.policy_sha256 !== policyDigest) return 'policy.digest_mismatch';
  if (policy.vault_id !== document.trusted_context.vault_id || request.vault_id !== policy.vault_id) {
    return 'policy.vault_mismatch';
  }
  const policyApprovalCode = approvalEvidenceCode(document, 'processing_policy', policy);
  if (policyApprovalCode !== null) return `policy.${policyApprovalCode}`;
  const collectionCode = policyCollectionCode(policy);
  if (collectionCode !== null) return collectionCode;
  if (!policy.grants.adapter_ids.includes(request.adapter_id) ||
      !policy.grants.provider_ids.includes(request.provider_id)) return 'policy.provider_denied';
  if (!policy.grants.purpose_ids.includes(request.purpose_id)) return 'policy.purpose_denied';
  const fieldMap = new Map(policy.grants.fields.map((field) => [field.field_id, field]));
  if ((Buffer.byteLength(request.payload.bytes, 'utf8') > 0 && request.field_ids.length === 0) ||
      request.field_ids.some((fieldId) => !fieldMap.has(fieldId))) return 'policy.field_denied';
  if (!isDeepStrictEqual(request.field_grants, request.field_ids.map((fieldId) => fieldMap.get(fieldId)))) {
    return 'policy.field_denied';
  }
  if (!valuesAreSubset(request.artifact_kinds, policy.grants.artifact_kinds)) return 'policy.artifact_denied';
  const destination = policy.grants.destinations.find(({destination_id: id}) => id === request.destination_id);
  if (destination === undefined || destination.provider_id !== request.provider_id ||
      !isDeepStrictEqual(request.destination, destination)) return 'policy.destination_denied';
  const boundary = policy.grants.credential_boundaries.find(({credential_ref: ref}) => ref === request.credential_ref);
  if (boundary === undefined || boundary.provider_id !== request.provider_id ||
      !isDeepStrictEqual(request.credential_boundary, boundary)) return 'policy.credential_boundary_denied';
  if (!boundary.purpose_ids.includes(request.purpose_id)) return 'policy.credential_purpose_denied';
  const consentCode = consentBindingCode(policy, request);
  if (consentCode !== null) return consentCode;
  if (Buffer.byteLength(request.payload.bytes, 'utf8') > request.budget.input_bytes ||
      Object.keys(policy.grants.budget).some((key) => request.budget[key] > policy.grants.budget[key])) {
    return 'policy.budget_exceeded';
  }
  if (Object.keys(policy.grants.retry).some((key) => request.retry[key] > policy.grants.retry[key])) {
    return 'policy.retry_exceeded';
  }
  if (!fallbackMatches(request, policy)) return 'policy.fallback_denied';
  if (!valuesAreSubset(request.capabilities, policy.grants.capabilities)) return 'policy.capability_denied';
  if (!valuesAreSubset(request.semantic_authority, policy.grants.semantic_authority)) {
    return 'policy.semantic_authority_denied';
  }
  if (!valuesAreSubset(request.automation_scope, policy.grants.automation_scope)) {
    return 'policy.automation_scope_denied';
  }
  if (request.payload.sha256 !== sha256Text(request.payload.bytes)) return 'policy.payload_binding_invalid';
  if (!valuesAreSubset(request.field_grants.map(({redaction_rule_id: id}) => id), request.redaction_receipt_ids) ||
      !redactionsProven(document, policyDigest)) return 'policy.redaction_unproven';
  const retention = policy.retention_facts.find(({retention_fact_id: id}) => id === destination.retention_fact_id);
  if (retention === undefined || retention.destination_id !== destination.destination_id ||
      !request.retention_fact_ids.includes(destination.retention_fact_id) ||
      !isDeepStrictEqual(request.retention_facts, [retention]) ||
      (retention.status === 'unknown' && !retention.risk_acknowledged)) return 'policy.retention_unproven';
  if (request.untrusted_content.requested_actions.length > 0) return 'policy.hostile_content_capability_denied';
  return null;
}

export function sourceProfileBindingCode(document, requireActive = true) {
  const {observed_binding: observed, policy, source_profile: profile} = document;
  if (policy.lifecycle_state !== 'active' || document.lifecycle.policy_state !== 'active') return 'policy.inactive';
  if (requireActive && document.lifecycle.source_profile_state !== 'active') {
    return document.lifecycle.source_profile_state === 'stale'
      ? 'source_profile.stale'
      : 'source_profile.binding_required';
  }
  if (observed === null) return 'source_profile.readback_failed';
  if (profile.vault_id !== policy.vault_id || observed.vault_id !== profile.vault_id ||
      profile.vault_id !== document.trusted_context.vault_id) return 'source_profile.vault_mismatch';
  const policyApprovalCode = approvalEvidenceCode(document, 'processing_policy', policy);
  if (policyApprovalCode !== null) return `policy.${policyApprovalCode}`;
  const profileApprovalCode = approvalEvidenceCode(document, 'source_profile', profile);
  if (profileApprovalCode !== null) return `source_profile.${profileApprovalCode}`;
  if (observed.profile_id !== profile.profile_id || observed.profile_version !== profile.profile_version) {
    return 'source_profile.version_mismatch';
  }
  if (observed.profile_sha256 !== sourceProfileDigest(profile) ||
      observed.approval_receipt_id !== profile.approval.receipt_id ||
      observed.approval_receipt_sha256 !== profile.approval.receipt_sha256 ||
      observed.approval_payload_sha256 !== profile.approval.profile_payload_sha256) {
    return 'source_profile.readback_failed';
  }
  if (!isDeepStrictEqual(observed.capture_source, profile.capture_source) ||
      !isDeepStrictEqual(observed.candidate_schema, profile.candidate_schema)) {
    return 'source_profile.source_binding_mismatch';
  }
  if (!isDeepStrictEqual(observed.template, profile.template)) return 'source_profile.template_binding_mismatch';
  if (observed.url_retention_mode !== profile.url_retention_mode) return 'source_profile.url_retention_mode_mismatch';
  if (!isDeepStrictEqual(observed.capture_contract, profile.capture_contract)) {
    return 'source_profile.capture_contract_mismatch';
  }
  if (profile.processing_policy.policy_id !== policy.policy_id ||
      profile.processing_policy.policy_version !== policy.policy_version) return 'policy.version_mismatch';
  if (profile.processing_policy.policy_sha256 !== processingPolicyDigest(policy) ||
      !isDeepStrictEqual(observed.processing_policy, profile.processing_policy)) return 'policy.digest_mismatch';
  return null;
}
