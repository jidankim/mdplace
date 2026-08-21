import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {canonicalJson} from './semantic-kernel-core.mjs';
import {adapterReceiptDigest, createAdapterReceipt} from './intelligence-adapter-core.mjs';

export const codexDecisionInputs = [
  'https://github.com/jidankim/mdplace/issues/11#issuecomment-5118839348',
  'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093',
];

export const codexDecisionIds = ['DEC-011', 'DEC-008'];
export const codexAdapterRequirementIds = Array.from(
  {length: 8},
  (_, index) => `REQ-CODEX-${String(index + 1).padStart(3, '0')}`,
);
export const codexAdapterEvidenceEvaluatedAt = '2026-08-24T00:00:00.000Z';
export const codexAdapterCategories = [
  'positive',
  'negative',
  'exact_boundary',
  'over_boundary',
  'stale_state',
  'authority_denial',
  'illegal_transition',
  'crash_recovery',
];
export const codexAdapterEvidencePaths = [
  'normative/codex-intelligence-adapter-profile.md',
  'contracts/codex-intelligence-adapter/profile.json',
  'contracts/codex-intelligence-adapter/invocation-contract.json',
  'contracts/schemas/codex-invocation-contract.schema.json',
  'contracts/schemas/codex-adapter-proposal.schema.json',
  'contracts/codex-intelligence-adapter/approved-processing-envelope.json',
  'contracts/codex-intelligence-adapter/boundary.json',
  'contracts/codex-intelligence-adapter/authentication-prerequisite.json',
  'contracts/codex-intelligence-adapter/capability-proof.json',
  'contracts/codex-intelligence-adapter/network-proof.json',
  'contracts/codex-intelligence-adapter/fixture-manifest.json',
  'contracts/verdicts/codex-adapter-verdicts.json',
  'conformance/evidence/codex-adapter-evidence.json',
];

export function codexSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function codexAdapterEvidenceDigest(material) {
  return codexSha256(material
    .map(({ordinal, label, path, sha256}) => `${ordinal}\0${label}\0${path}\0${sha256}\n`)
    .join(''));
}

const proposalAuthority = {
  semantic: 'none', note_placement: 'none', taxonomy: 'none', filesystem: 'none',
  projection: 'none', destination_selection: 'none', tool_invocation: 'none', credential_access: 'none',
};

function proposalDocument(scenarioId, envelope, rationale) {
  return {
    schema_id: 'mdplace.intelligence-proposal/v1', proposal_id: `proposal:${scenarioId.toLowerCase()}`,
    proposal_version: '1.0.0', kind: 'abstention', envelope_id: envelope.envelope_id, attempt_id: envelope.attempt_id,
    bindings: {
      policy_id: envelope.bindings.policy.id, policy_version: envelope.bindings.policy.version, policy_sha256: envelope.bindings.policy.sha256,
      source_profile_id: envelope.bindings.source_profile.id, source_profile_version: envelope.bindings.source_profile.version, source_profile_sha256: envelope.bindings.source_profile.sha256,
      taxonomy_revision_id: envelope.bindings.taxonomy_revision.id, taxonomy_revision: envelope.bindings.taxonomy_revision.revision, taxonomy_revision_sha256: envelope.bindings.taxonomy_revision.sha256,
      adapter_id: envelope.bindings.adapter_id, provider_id: envelope.bindings.provider_id, model_id: envelope.bindings.model_id, model_version: envelope.bindings.model_version,
      adapter_contract_version: envelope.contracts.adapter_contract_version, prompt_contract_version: envelope.contracts.prompt_contract_version, proposal_schema_version: envelope.contracts.proposal_schema_version,
    },
    subject_note_id: envelope.bindings.source_note_id, subject_note_version_sha256: envelope.bindings.source_note_version_sha256,
    candidates: [], taxonomy_hypotheses: [], evidence_segment_ids: envelope.payload_segments.map(({segment_id: id}) => id),
    rationale, warnings: [], abstention_reason: 'insufficient_evidence', scores_calibration: 'uncalibrated', authority: proposalAuthority,
  };
}

export function codexProposalJson(scenarioId, envelope, targetBytes) {
  const document = proposalDocument(scenarioId, envelope, 'bounded inert advice');
  let output = canonicalJson(document);
  if (targetBytes !== undefined) {
    const difference = targetBytes - Buffer.byteLength(output);
    if (difference < 0) throw new Error(`Codex proposal target ${targetBytes} is below baseline`);
    document.rationale = `${document.rationale}${'x'.repeat(difference)}`;
    output = canonicalJson(document);
  }
  if (targetBytes !== undefined && Buffer.byteLength(output) !== targetBytes) throw new Error('Codex proposal byte target mismatch');
  return output;
}

export function codexAttemptObservation(scenarioId, runtimeMs, transmittedBytes, isolated, approvedDestination) {
  const observedStartedAt = '2026-08-23T00:01:00.000Z';
  return {
    observed_started_at: observedStartedAt,
    observed_completed_at: new Date(Date.parse(observedStartedAt) + runtimeMs).toISOString(),
    provider_request_id: transmittedBytes === 0 ? null : `provider-request:${scenarioId.toLowerCase()}`,
    isolation: {
      ephemeral: isolated, fresh_process: isolated, filesystem: isolated ? 'none' : 'present',
      tools: isolated ? 'none' : 'present', ambient_configuration: isolated ? 'unreadable' : 'readable',
      credential_visibility: 'none', network_scope: [approvedDestination],
      effective_capabilities: ['capability:produce-proposal'],
      canary: {
        canary_id: `canary:${scenarioId.toLowerCase()}`, challenge: 'return inert-canary without actions',
        expected: 'inert-canary', observed: isolated ? 'inert-canary' : 'unavailable', passed: isolated,
      },
    },
  };
}

function denialFor(document, code, transmittedBytes, transmittedSha256, destination, boundary) {
  return {
    schema_id: 'mdplace.codex-adapter-denial/v1', denial_id: `codex-denial:${document.scenario_id.toLowerCase()}`,
    profile_id: 'codex-adapter', scenario_id: document.scenario_id, code, boundary,
    transmitted_bytes: transmittedBytes, transmitted_sha256: transmittedSha256, destination,
    semantic_effects: [], filesystem_effects: [], tool_invocations: [],
  };
}

export function codexReceiptReason(code) {
  if (code === null) return 'adapter.proposal_accepted_as_advice';
  if (code === 'codex.input_limit_exceeded') return 'adapter.input_budget_exhausted';
  if (code === 'codex.isolation_unavailable') return 'adapter.isolation_failed';
  if (code === 'codex.isolation_canary_failed') return 'adapter.canary_failed';
  if (code === 'codex.tool_request_denied' || code === 'codex.command_request_denied') return 'adapter.tool_request_denied';
  if (code === 'codex.secret_request_denied') return 'adapter.secret_request_denied';
  if (code === 'codex.filesystem_authority_denied') return 'adapter.filesystem_authority_denied';
  if (code === 'codex.note_placement_authority_denied') return 'adapter.placement_authority_denied';
  if (code.includes('authority_denied') || code.includes('authority_request')) return 'adapter.semantic_authority_denied';
  if (code === 'codex.runtime_limit_exceeded') return 'adapter.timeout';
  if (['codex.output_limit_exceeded', 'codex.jsonl_limit_exceeded', 'codex.token_limit_exceeded'].includes(code)) return 'adapter.output_budget_exhausted';
  if (code === 'codex.cost_limit_exceeded') return 'adapter.cost_budget_exhausted';
  if (code === 'codex.malformed_output' || code === 'codex.output_measurement_mismatch') return 'adapter.malformed_output';
  if (code === 'codex.proposal_validation_failed') return 'adapter.proposal_binding_denied';
  if (code === 'codex.unapproved_fallback') return 'adapter.fallback_exhausted';
  if (code === 'codex.illegal_transition') return 'adapter.illegal_transition';
  if (code.includes('crash') || code.includes('recovery_')) return 'adapter.recovery_unknown_completion';
  if (code.includes('unapproved_provider')) return 'adapter.provider_denied';
  if (code.includes('unapproved_purpose')) return 'adapter.purpose_denied';
  if (code.includes('destination') || code.includes('network_proof')) return 'adapter.destination_denied';
  if (code.includes('unapproved_artifact')) return 'adapter.artifact_denied';
  if (code.includes('redaction_')) return 'adapter.redaction_unproven';
  if (code.includes('retention_')) return 'adapter.retention_unproven';
  if (code.includes('capability_proof')) return 'adapter.capability_denied';
  if (code.includes('authentication')) return 'adapter.credential_boundary_denied';
  if (code.includes('payload') || code.includes('transmitted_')) return 'adapter.field_denied';
  return 'adapter.policy_binding_denied';
}

function receiptOutcome(reason) {
  const outcomes = new Map([
    ['adapter.proposal_accepted_as_advice', 'accepted'], ['adapter.input_budget_exhausted', 'budget_exhausted'],
    ['adapter.isolation_failed', 'isolation_failure'], ['adapter.canary_failed', 'isolation_failure'], ['adapter.timeout', 'timeout'],
    ['adapter.output_budget_exhausted', 'budget_exhausted'], ['adapter.cost_budget_exhausted', 'budget_exhausted'],
    ['adapter.malformed_output', 'malformed_output'], ['adapter.fallback_exhausted', 'fallback_exhausted'],
    ['adapter.recovery_unknown_completion', 'recovery_required'],
  ]);
  return outcomes.get(reason) ?? 'denied';
}

export function codexReceiptArtifacts(document, code, preTransmission, receiptObservationValid = true) {
  const transmittedBytes = document.transmitted_bytes;
  const transmittedSha256 = transmittedBytes === 0 ? codexSha256(Buffer.alloc(0)) : document.transmitted_sha256;
  const destination = transmittedBytes === 0 ? null : document.requested_destination;
  const denial = code === null ? null : denialFor(
    document, code, transmittedBytes, transmittedSha256, destination,
    code.includes('crash') || document.operation === 'recover' ? 'recovery' : preTransmission ? 'pre_transmission' : 'post_response_validation',
  );
  if (!receiptObservationValid) return {receipt: null, denial};
  let envelope;
  try {
    envelope = JSON.parse(document.processing_envelope_json);
  } catch {
    return {receipt: null, denial};
  }
  const rawOutput = transmittedBytes === 0 ? null : document.raw_output;
  const proposal = code === null && typeof rawOutput === 'string' ? JSON.parse(rawOutput) : null;
  const reason = codexReceiptReason(code);
  try {
    const receipt = createAdapterReceipt({
      attempt: {
        attempt_class: 'primary', envelope,
        double: {
          observed_started_at: document.attempt_observation.observed_started_at,
          provider_request_id: document.attempt_observation.provider_request_id,
        },
      },
      transmission: {destination, sha256: transmittedSha256, byte_length: transmittedBytes},
      isolation: document.attempt_observation.isolation,
      budget: {
        input_bytes: transmittedBytes,
        output_bytes: typeof rawOutput === 'string' ? Buffer.byteLength(rawOutput) : 0,
        runtime_ms: document.runtime_ms,
        cost_microunits: document.cost_microunits,
      },
      rawOutput, proposal,
      outcome: receiptOutcome(reason), reason,
      observedCompletedAt: document.attempt_observation.observed_completed_at,
    });
    return {receipt, denial};
  } catch {
    return {receipt: null, denial};
  }
}

export function codexAdapterReceiptDigest(receipt) {
  return adapterReceiptDigest(receipt);
}

function receiptInputMatches(receipt, document) {
  try {
    const envelope = JSON.parse(document.processing_envelope_json);
    const observation = document.attempt_observation;
    return receipt.chain_id === envelope.chain_id && receipt.attempt_id === envelope.attempt_id &&
      receipt.attempt_sequence === envelope.attempt_sequence && receipt.authorization_id === envelope.authorization_id &&
      receipt.envelope_id === envelope.envelope_id && receipt.envelope_sha256 === document.processing_envelope_sha256 &&
      receipt.observed_started_at === observation.observed_started_at && receipt.observed_completed_at === observation.observed_completed_at &&
      isDeepStrictEqual(receipt.effective_capabilities, observation.isolation.effective_capabilities);
  } catch {
    return false;
  }
}

export function codexReceiptMatchesScenario(receipt, document) {
  const transmissionMatches = receipt.transmitted_bytes === 0
    ? receipt.transmission_sha256 === codexSha256(Buffer.alloc(0)) && receipt.observed_destination === null &&
      document.transmitted_bytes === 0 && document.transmitted_sha256 === codexSha256(Buffer.alloc(0))
    : isDeepStrictEqual(
      [receipt.transmitted_bytes, receipt.transmission_sha256, receipt.observed_destination],
      [document.transmitted_bytes, document.transmitted_sha256, document.requested_destination],
    );
  return receiptInputMatches(receipt, document) && transmissionMatches &&
    receipt.semantic_effects.length === 0 && receipt.filesystem_effects.length === 0 && receipt.tool_invocations.length === 0 &&
    receipt.receipt_sha256 === adapterReceiptDigest(receipt);
}
