import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {sha256} from './intelligence-adapter-core.mjs';

export const adapterOutcomePrecedence = Object.freeze([
  'adapter.policy_binding_denied',
  'adapter.source_profile_binding_denied',
  'adapter.provider_denied',
  'adapter.purpose_denied',
  'adapter.destination_denied',
  'adapter.field_denied',
  'adapter.artifact_denied',
  'adapter.redaction_unproven',
  'adapter.retention_unproven',
  'adapter.capability_denied',
  'adapter.credential_boundary_denied',
  'adapter.input_budget_exhausted',
  'adapter.isolation_failed',
  'adapter.canary_failed',
  'adapter.tool_request_denied',
  'adapter.secret_request_denied',
  'adapter.ambient_config_denied',
  'adapter.filesystem_authority_denied',
  'adapter.semantic_authority_denied',
  'adapter.placement_authority_denied',
  'adapter.timeout',
  'adapter.output_budget_exhausted',
  'adapter.cost_budget_exhausted',
  'adapter.malformed_output',
  'adapter.proposal_binding_denied',
  'adapter.cached_proposal_stale',
  'adapter.retry_exhausted',
  'adapter.fallback_exhausted',
  'adapter.recovery_unknown_completion',
]);

const outcomePrecedenceRank = new Map(adapterOutcomePrecedence.map((code, index) => [code, index]));

export function highestPrecedenceCode(codes) {
  return codes.filter((code) => code !== null)
    .reduce((highest, code) => highest === null || outcomePrecedenceRank.get(code) < outcomePrecedenceRank.get(highest)
      ? code
      : highest, null);
}

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

function isSubset(requested, approved, identity = (value) => value) {
  const requestedIdentities = requested.map(identity);
  const approvedIdentities = new Set(approved.map(identity));
  return new Set(requestedIdentities).size === requestedIdentities.length &&
    requestedIdentities.every((value) => approvedIdentities.has(value));
}

const remoteEndpointPattern = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/;
const localEndpointPattern = /^local:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/;

function destinationTransportIsValid(destination) {
  try {
    const rawPattern = destination.locality === 'remote'
      ? remoteEndpointPattern
      : destination.locality === 'local' ? localEndpointPattern : null;
    if (rawPattern === null || !rawPattern.test(destination.endpoint)) return false;
    const endpoint = new URL(destination.endpoint);
    const lastAuthorityLabel = endpoint.hostname.split('.').at(-1);
    const parsedEndpoint = `${endpoint.protocol}//${endpoint.hostname}${endpoint.pathname}`;
    const rawRoundTrips = destination.endpoint === parsedEndpoint ||
      (endpoint.pathname === '/' && destination.endpoint === `${endpoint.protocol}//${endpoint.hostname}`);
    const authorityIsSafe = endpoint.hostname.length > 0 && endpoint.hostname.length <= 253 &&
      /^[a-z][a-z0-9-]{0,62}$/.test(lastAuthorityLabel) && rawRoundTrips &&
      endpoint.username === '' && endpoint.password === '' &&
      endpoint.port === '' && endpoint.search === '' && endpoint.hash === '';
    const remoteAuthorityIsSafe = endpoint.hostname.includes('.') && !endpoint.hostname.endsWith('.localhost');
    if (destination.locality === 'remote') {
      return authorityIsSafe && remoteAuthorityIsSafe && endpoint.protocol === 'https:';
    }
    if (destination.locality === 'local') return authorityIsSafe && endpoint.protocol === 'local:';
    return false;
  } catch {
    return false;
  }
}

function segmentCodes(envelope) {
  const codes = [];
  const segments = new Map(envelope.payload_segments.map((segment) => [segment.segment_id, segment]));
  if (segments.size !== envelope.payload_segments.length || segments.size !== envelope.transmitted_fields.length) {
    codes.push('adapter.field_denied');
  }
  for (const segment of envelope.payload_segments) {
    if (Buffer.byteLength(segment.utf8) !== segment.byte_length || sha256(segment.utf8) !== segment.sha256) {
      codes.push('adapter.input_budget_exhausted');
    }
  }
  for (const field of envelope.transmitted_fields) {
    const segment = segments.get(field.segment_id);
    if (segment?.field_id !== field.field_id) codes.push('adapter.field_denied');
  }
  return codes;
}

function cachedProposalCode(envelope) {
  const cached = envelope.cached_proposal_binding;
  if (cached === null) return null;
  const expected = {
    policy_sha256: envelope.bindings.policy.sha256,
    source_profile_sha256: envelope.bindings.source_profile.sha256,
    taxonomy_revision_id: envelope.bindings.taxonomy_revision.id,
    taxonomy_revision: envelope.bindings.taxonomy_revision.revision,
    taxonomy_revision_sha256: envelope.bindings.taxonomy_revision.sha256,
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
  const codes = [];
  if (context.policy_binding.lifecycle_state !== 'active' || !context.policy_binding.approved ||
      !equal(envelope.bindings.policy, versionBinding(context.policy_binding))) {
    codes.push('adapter.policy_binding_denied');
  }
  if (context.source_profile_binding.lifecycle_state !== 'active' || !context.source_profile_binding.approved ||
      !equal(envelope.bindings.source_profile, versionBinding(context.source_profile_binding))) {
    codes.push('adapter.source_profile_binding_denied');
  }
  const taxonomyRevision = context.taxonomy_revision_binding;
  if (!equal(envelope.bindings.taxonomy_revision, {
    id: taxonomyRevision.revision_id,
    revision: taxonomyRevision.revision,
    sha256: taxonomyRevision.sha256,
  })) codes.push('adapter.policy_binding_denied');
  if (envelope.bindings.vault_id !== context.vault_id || envelope.bindings.adapter_id !== authorization.adapter_id ||
      attempt.attempt_class !== authorization.attempt_class || envelope.attempt_sequence !== authorization.position) {
    codes.push('adapter.policy_binding_denied');
  }
  if (!equal(envelope.contracts, context.contracts) || !ceilingsNarrower(envelope.ceilings, authorization.ceilings)) {
    codes.push('adapter.policy_binding_denied');
  }
  if (envelope.bindings.provider_id !== authorization.provider_id) codes.push('adapter.provider_denied');
  if (envelope.bindings.model_id !== authorization.model_id ||
      envelope.bindings.model_version !== authorization.model_version) codes.push('adapter.provider_denied');
  if (envelope.purpose_id !== authorization.purpose_id) codes.push('adapter.purpose_denied');
  if (!destinationTransportIsValid(envelope.destination) ||
      !destinationTransportIsValid(authorization.destination) ||
      !equal(envelope.destination, authorization.destination)) codes.push('adapter.destination_denied');
  if (!isSubset(envelope.transmitted_fields.map(({field_id: id}) => id), authorization.field_ids)) {
    codes.push('adapter.field_denied');
  }
  if (!isSubset(envelope.transmitted_artifacts, authorization.artifact_kinds)) codes.push('adapter.artifact_denied');
  const redactions = envelope.redactions.map(({rule_id, receipt_sha256}) => ({rule_id, receipt_sha256}));
  if (!isSubset(redactions, authorization.redactions, canonicalJson)) codes.push('adapter.redaction_unproven');
  const redactionReceipts = new Set(envelope.redactions.map(({receipt_sha256: digest}) => digest));
  if (envelope.transmitted_fields.some(({redaction_receipt_sha256: digest}) => !redactionReceipts.has(digest))) {
    codes.push('adapter.redaction_unproven');
  }
  for (const field of envelope.transmitted_fields) {
    const obligations = authorization.field_redaction_bindings
      .filter(({field_id: fieldId}) => fieldId === field.field_id);
    if (obligations.length !== 1 || field.data_class !== obligations[0].data_class ||
        field.redaction_receipt_sha256 !== obligations[0].receipt_sha256 ||
        !envelope.redactions.some(({rule_id: ruleId, receipt_sha256: digest}) =>
          ruleId === obligations[0].rule_id && digest === obligations[0].receipt_sha256)) {
      codes.push('adapter.redaction_unproven');
    }
  }
  if (envelope.retention_facts.length === 0 ||
      !isSubset(envelope.retention_facts, authorization.retention_facts, canonicalJson) ||
      !isSubset(envelope.retention_artifacts, authorization.retention_artifacts)) {
    codes.push('adapter.retention_unproven');
  }
  const requiredCapabilities = envelope.destination.locality === 'remote'
    ? ['capability:produce-proposal', 'capability:fixed-destination-network']
    : ['capability:produce-proposal'];
  if (!isSubset(envelope.capabilities, authorization.capabilities) ||
      requiredCapabilities.some((capability) => !envelope.capabilities.includes(capability))) {
    codes.push('adapter.capability_denied');
  }
  if (!equal(envelope.credential_boundary, authorization.credential_boundary)) {
    codes.push('adapter.credential_boundary_denied');
  }
  codes.push(...segmentCodes(envelope));
  if (Buffer.byteLength(canonicalJson(envelope)) > envelope.ceilings.input_bytes) {
    codes.push('adapter.input_budget_exhausted');
  }
  const cached = cachedProposalCode(envelope);
  if (cached !== null) codes.push(cached);

  const isolation = attempt.isolation;
  const expectedNetwork = envelope.destination.locality === 'remote' ? [envelope.destination.endpoint] : [];
  const expectedCanary = {
    canary_id: `canary:${envelope.attempt_id.slice('adapter-attempt:'.length)}`,
    challenge: 'return inert-canary without actions',
    expected: 'inert-canary',
  };
  if (!isolation.ephemeral || !isolation.fresh_process || isolation.filesystem !== 'none' || isolation.tools !== 'none' ||
      isolation.ambient_configuration !== 'unreadable' || isolation.credential_visibility !== 'none' ||
      !equal(isolation.network_scope, expectedNetwork) || !equal(isolation.effective_capabilities, envelope.capabilities)) {
    codes.push('adapter.isolation_failed');
  }
  if (isolation.canary.canary_id !== expectedCanary.canary_id ||
      isolation.canary.challenge !== expectedCanary.challenge || isolation.canary.expected !== expectedCanary.expected ||
      !isolation.canary.passed || isolation.canary.observed !== expectedCanary.expected) {
    codes.push('adapter.canary_failed');
  }
  return highestPrecedenceCode(codes);
}

const actionCodes = new Map([
  ['invoke_tool', 'adapter.tool_request_denied'],
  ['request_secret', 'adapter.secret_request_denied'],
  ['read_ambient_config', 'adapter.ambient_config_denied'],
  ['write_file', 'adapter.filesystem_authority_denied'],
  ['establish_semantic_truth', 'adapter.semantic_authority_denied'],
  ['choose_note_placement', 'adapter.placement_authority_denied'],
]);

export function unknownActionCode(actions) {
  return Array.isArray(actions) && actions.every((action) => actionCodes.has(action))
    ? null
    : 'adapter.tool_request_denied';
}

export function forbiddenActionCode(actions) {
  const knownCodes = Array.isArray(actions) ? actions.map((action) => actionCodes.get(action) ?? null) : [];
  return highestPrecedenceCode([unknownActionCode(actions), ...knownCodes]);
}

function proposalBinding(envelope) {
  return {
    policy_id: envelope.bindings.policy.id,
    policy_version: envelope.bindings.policy.version,
    policy_sha256: envelope.bindings.policy.sha256,
    source_profile_id: envelope.bindings.source_profile.id,
    source_profile_version: envelope.bindings.source_profile.version,
    source_profile_sha256: envelope.bindings.source_profile.sha256,
    taxonomy_revision_id: envelope.bindings.taxonomy_revision.id,
    taxonomy_revision: envelope.bindings.taxonomy_revision.revision,
    taxonomy_revision_sha256: envelope.bindings.taxonomy_revision.sha256,
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
  const codes = [];
  const authority = proposal?.authority;
  if (authority !== null && typeof authority === 'object') {
    if ((Object.hasOwn(authority, 'filesystem') && authority.filesystem !== 'none') ||
        (Object.hasOwn(authority, 'projection') && authority.projection !== 'none')) {
      codes.push('adapter.filesystem_authority_denied');
    }
    if (Object.hasOwn(authority, 'semantic') && authority.semantic !== 'none') {
      codes.push('adapter.semantic_authority_denied');
    }
    if ((Object.hasOwn(authority, 'note_placement') && authority.note_placement !== 'none') ||
        (Object.hasOwn(authority, 'taxonomy') && authority.taxonomy !== 'none')) {
      codes.push('adapter.placement_authority_denied');
    }
  }
  const errors = await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/intelligence-proposal.schema.json', proposal);
  if (schemaErrorCode(errors) !== null) codes.push('adapter.malformed_output');
  if (proposal !== null && typeof proposal === 'object' &&
      (proposal.envelope_id !== envelope.envelope_id || proposal.attempt_id !== envelope.attempt_id ||
        proposal.subject_note_id !== envelope.bindings.source_note_id ||
        proposal.subject_note_version_sha256 !== envelope.bindings.source_note_version_sha256 ||
        !equal(proposal.bindings, proposalBinding(envelope)))) {
    codes.push('adapter.proposal_binding_denied');
  }
  const segments = new Set(envelope.payload_segments.map(({segment_id: id}) => id));
  const candidates = Array.isArray(proposal?.candidates) ? proposal.candidates : [];
  const hypotheses = Array.isArray(proposal?.taxonomy_hypotheses) ? proposal.taxonomy_hypotheses : [];
  const evidence = Array.isArray(proposal?.evidence_segment_ids) ? proposal.evidence_segment_ids : [];
  const references = [evidence, ...candidates.map((item) => item?.evidence_segment_ids ?? []),
    ...hypotheses.map((item) => item?.evidence_segment_ids ?? [])].flat();
  if (references.some((id) => !segments.has(id))) codes.push('adapter.proposal_binding_denied');
  const validKind = (proposal?.kind === 'placement_candidates' && candidates.length > 0 &&
      hypotheses.length === 0 && proposal.abstention_reason === null) ||
    (proposal?.kind === 'taxonomy_hypothesis' && candidates.length === 0 &&
      hypotheses.length > 0 && proposal.abstention_reason === null) ||
    (proposal?.kind === 'abstention' && candidates.length === 0 &&
      hypotheses.length === 0 && typeof proposal.abstention_reason === 'string');
  if (!validKind) codes.push('adapter.malformed_output');
  const code = highestPrecedenceCode(codes);
  return code === null ? {proposal, code: null} : {proposal: null, code};
}
