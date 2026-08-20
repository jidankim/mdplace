import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {sha256} from './intelligence-adapter-core.mjs';

function equal(left, right) {
  return isDeepStrictEqual(left, right);
}

function versionBinding(contextBinding) {
  const id = contextBinding.policy_id ?? contextBinding.profile_id;
  const version = contextBinding.policy_version ?? contextBinding.profile_version;
  const digest = contextBinding.policy_sha256 ?? contextBinding.profile_sha256;
  return {id, version, sha256: digest};
}

function ceilingsNarrower(requested, approved) {
  return ['input_bytes', 'output_bytes', 'runtime_ms', 'cost_microunits']
    .every((field) => requested[field] <= approved[field]);
}

function segmentCode(envelope) {
  const segments = new Map(envelope.payload_segments.map((segment) => [segment.segment_id, segment]));
  if (segments.size !== envelope.payload_segments.length) return 'adapter.field_denied';
  for (const segment of envelope.payload_segments) {
    if (Buffer.byteLength(segment.utf8) !== segment.byte_length || sha256(segment.utf8) !== segment.sha256) {
      return 'adapter.input_budget_exhausted';
    }
  }
  for (const field of envelope.transmitted_fields) {
    const segment = segments.get(field.segment_id);
    if (segment?.field_id !== field.field_id) return 'adapter.field_denied';
  }
  return null;
}

function cachedProposalCode(envelope) {
  const cached = envelope.cached_proposal_binding;
  if (cached === null) return null;
  const expected = {
    policy_sha256: envelope.bindings.policy.sha256,
    source_profile_sha256: envelope.bindings.source_profile.sha256,
    source_note_version_sha256: envelope.bindings.source_note_version_sha256,
    adapter_contract_version: envelope.contracts.adapter_contract_version,
    prompt_contract_version: envelope.contracts.prompt_contract_version,
    proposal_schema_version: envelope.contracts.proposal_schema_version,
  };
  return Object.entries(expected).every(([key, value]) => cached[key] === value)
    ? null
    : 'adapter.cached_proposal_stale';
}

export function preflightCode(attempt, context) {
  const envelope = attempt.envelope;
  const matches = context.attempt_authorizations.filter(({authorization_id: id}) => id === envelope.authorization_id);
  if (matches.length !== 1) return 'adapter.policy_binding_denied';
  const authorization = matches[0];
  if (context.policy_binding.lifecycle_state !== 'active' || !context.policy_binding.approved ||
      !equal(envelope.bindings.policy, versionBinding(context.policy_binding))) {
    return 'adapter.policy_binding_denied';
  }
  if (context.source_profile_binding.lifecycle_state !== 'active' || !context.source_profile_binding.approved ||
      !equal(envelope.bindings.source_profile, versionBinding(context.source_profile_binding))) {
    return 'adapter.source_profile_binding_denied';
  }
  if (envelope.bindings.vault_id !== context.vault_id || envelope.bindings.adapter_id !== authorization.adapter_id ||
      attempt.attempt_class !== authorization.attempt_class || envelope.attempt_sequence !== authorization.position) {
    return 'adapter.policy_binding_denied';
  }
  if (envelope.bindings.provider_id !== authorization.provider_id) return 'adapter.provider_denied';
  if (envelope.purpose_id !== authorization.purpose_id) return 'adapter.purpose_denied';
  if (!equal(envelope.destination, authorization.destination)) return 'adapter.destination_denied';
  if (!equal(envelope.transmitted_fields.map(({field_id: id}) => id), authorization.field_ids)) return 'adapter.field_denied';
  if (!equal(envelope.transmitted_artifacts, authorization.artifact_kinds)) return 'adapter.artifact_denied';
  const redactions = envelope.redactions.map(({rule_id, receipt_sha256}) => ({rule_id, receipt_sha256}));
  if (!equal(redactions, authorization.redactions)) return 'adapter.redaction_unproven';
  const redactionReceipts = new Set(envelope.redactions.map(({receipt_sha256: digest}) => digest));
  if (envelope.transmitted_fields.some(({redaction_receipt_sha256: digest}) => !redactionReceipts.has(digest))) {
    return 'adapter.redaction_unproven';
  }
  if (!equal(envelope.retention_facts, authorization.retention_facts) ||
      !equal(envelope.retention_artifacts, authorization.retention_artifacts)) return 'adapter.retention_unproven';
  if (!equal(envelope.capabilities, authorization.capabilities)) return 'adapter.capability_denied';
  if (!equal(envelope.credential_boundary, authorization.credential_boundary)) return 'adapter.credential_boundary_denied';
  if (!equal(envelope.contracts, context.contracts) || !ceilingsNarrower(envelope.ceilings, authorization.ceilings)) {
    return 'adapter.policy_binding_denied';
  }
  const segments = segmentCode(envelope);
  if (segments !== null) return segments;
  if (Buffer.byteLength(canonicalJson(envelope)) > envelope.ceilings.input_bytes) return 'adapter.input_budget_exhausted';
  const cached = cachedProposalCode(envelope);
  if (cached !== null) return cached;

  const isolation = attempt.isolation;
  const expectedNetwork = envelope.destination.locality === 'remote' ? [envelope.destination.endpoint] : [];
  if (!isolation.ephemeral || !isolation.fresh_process || isolation.filesystem !== 'none' || isolation.tools !== 'none' ||
      isolation.ambient_configuration !== 'unreadable' || isolation.credential_visibility !== 'none' ||
      !equal(isolation.network_scope, expectedNetwork) || !equal(isolation.effective_capabilities, envelope.capabilities)) {
    return 'adapter.isolation_failed';
  }
  if (!isolation.canary.passed || isolation.canary.observed !== isolation.canary.expected) return 'adapter.canary_failed';
  return null;
}

const actionCodes = new Map([
  ['invoke_tool', 'adapter.tool_request_denied'],
  ['request_secret', 'adapter.secret_request_denied'],
  ['read_ambient_config', 'adapter.ambient_config_denied'],
  ['write_file', 'adapter.filesystem_authority_denied'],
  ['establish_semantic_truth', 'adapter.semantic_authority_denied'],
  ['choose_note_placement', 'adapter.placement_authority_denied'],
]);

export function forbiddenActionCode(actions) {
  return actions.length === 0 ? null : actionCodes.get(actions[0]) ?? 'adapter.tool_request_denied';
}

function proposalBinding(envelope) {
  return {
    policy_id: envelope.bindings.policy.id,
    policy_version: envelope.bindings.policy.version,
    policy_sha256: envelope.bindings.policy.sha256,
    source_profile_id: envelope.bindings.source_profile.id,
    source_profile_version: envelope.bindings.source_profile.version,
    source_profile_sha256: envelope.bindings.source_profile.sha256,
    adapter_id: envelope.bindings.adapter_id,
    provider_id: envelope.bindings.provider_id,
    model_id: envelope.bindings.model_id,
    model_version: envelope.bindings.model_version,
    adapter_contract_version: envelope.contracts.adapter_contract_version,
    prompt_contract_version: envelope.contracts.prompt_contract_version,
    proposal_schema_version: envelope.contracts.proposal_schema_version,
  };
}

export async function validateProposal(rawOutput, envelope, packageRoot) {
  let proposal;
  try {
    proposal = JSON.parse(rawOutput);
  } catch {
    return {proposal: null, code: 'adapter.malformed_output'};
  }
  if (proposal?.authority?.semantic !== 'none') return {proposal: null, code: 'adapter.semantic_authority_denied'};
  if (proposal?.authority?.filesystem !== 'none' || proposal?.authority?.projection !== 'none') {
    return {proposal: null, code: 'adapter.filesystem_authority_denied'};
  }
  if (proposal?.authority?.note_placement !== 'none' || proposal?.authority?.taxonomy !== 'none') {
    return {proposal: null, code: 'adapter.placement_authority_denied'};
  }
  const errors = await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/intelligence-proposal.schema.json', proposal);
  if (schemaErrorCode(errors) !== null) return {proposal: null, code: 'adapter.malformed_output'};
  if (proposal.envelope_id !== envelope.envelope_id || proposal.attempt_id !== envelope.attempt_id ||
      proposal.subject_note_id !== envelope.bindings.source_note_id ||
      proposal.subject_note_version_sha256 !== envelope.bindings.source_note_version_sha256 ||
      !equal(proposal.bindings, proposalBinding(envelope))) {
    return {proposal: null, code: 'adapter.proposal_binding_denied'};
  }
  const segments = new Set(envelope.payload_segments.map(({segment_id: id}) => id));
  const references = [proposal.evidence_segment_ids, ...proposal.candidates.map((item) => item.evidence_segment_ids),
    ...proposal.taxonomy_hypotheses.map((item) => item.evidence_segment_ids)].flat();
  if (references.some((id) => !segments.has(id))) return {proposal: null, code: 'adapter.proposal_binding_denied'};
  const validKind = (proposal.kind === 'placement_candidates' && proposal.candidates.length > 0 &&
      proposal.taxonomy_hypotheses.length === 0 && proposal.abstention_reason === null) ||
    (proposal.kind === 'taxonomy_hypothesis' && proposal.candidates.length === 0 &&
      proposal.taxonomy_hypotheses.length > 0 && proposal.abstention_reason === null) ||
    (proposal.kind === 'abstention' && proposal.candidates.length === 0 &&
      proposal.taxonomy_hypotheses.length === 0 && typeof proposal.abstention_reason === 'string');
  return validKind ? {proposal, code: null} : {proposal: null, code: 'adapter.malformed_output'};
}
