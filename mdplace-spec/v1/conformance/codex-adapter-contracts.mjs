import {codexDecisionInputs} from './codex-adapter-core.mjs';
import {codexAdapterInterface, codexInvocationContract} from './codex-adapter-invocation.mjs';

export {codexInvocationContract};

export const codexAdapterProfile = {
  $schema: '../schemas/codex-intelligence-adapter-profile.schema.json',
  schema_id: 'mdplace.codex-intelligence-adapter-profile/v1',
  profile_id: 'codex-adapter',
  owner: 'codex-adapter',
  version: '1.0.0',
  protocol_ref: 'normative/intelligence-adapter-protocol.md',
  approved_processing_envelope_ref: 'contracts/codex-intelligence-adapter/approved-processing-envelope.json',
  decision_inputs: codexDecisionInputs,
  interface: codexAdapterInterface(),
  exact_destination: 'https://codex.openai.test/v1/execute',
  evidence_refs: {
    boundary: 'contracts/codex-intelligence-adapter/boundary.json',
    invocation_contract: 'contracts/codex-intelligence-adapter/invocation-contract.json',
    authentication_prerequisite: 'contracts/codex-intelligence-adapter/authentication-prerequisite.json',
    capability_proof: 'contracts/codex-intelligence-adapter/capability-proof.json',
    network_proof: 'contracts/codex-intelligence-adapter/network-proof.json',
  },
  ceilings: {
    input_bytes: 4096,
    jsonl_bytes: 8192,
    output_bytes: 3000,
    runtime_ms: 800,
    tokens: 2000,
    cost_microunits: 5000,
  },
  authority: {
    semantic: 'none', note_placement: 'none', taxonomy: 'none', projection: 'none',
    filesystem: 'none', tool: 'none', command: 'none', automation: 'none',
  },
  specification_only: true,
  live_codex_behavior_asserted: false,
  network_operation_performed: false,
};

export const codexApprovedProcessingEnvelope = {
  $schema: 'contracts/schemas/processing-envelope.schema.json', schema_id: 'mdplace.processing-envelope/v1',
  envelope_id: 'envelope:cdx-000', chain_id: 'adapter-chain:cdx-000', attempt_id: 'adapter-attempt:cdx-000',
  attempt_sequence: 0, authorization_id: 'adapter-authorization:remote-primary',
  bindings: {
    vault_id: 'vault:fixture-vault',
    policy: {id: 'policy:core-processing', version: '1.0.0', sha256: '27a755ff5a6d91ce1f925c31cbc094bd25f70b54793dee4a9a4a56e8d3d07766'},
    source_profile: {id: 'source-profile:web-clipper', version: '1.0.0', sha256: 'e8653b33e417207545e8e87e0e53443506e0cace32270ca4df5f10dc0bdde549'},
    taxonomy_revision: {id: 'taxonomy-revision:fixture-001', revision: 1, sha256: '6e77aeb5337715429270fd9c18cd01d388033efade5ce207b834516b2f96b1e6'},
    source_note_id: 'file:01J00000000000000000000000', source_note_version_sha256: 'b'.repeat(64),
    adapter_id: 'adapter:codex', provider_id: 'provider:codex', model_id: 'model:codex-fixture', model_version: '2026-08-01',
  },
  purpose_id: 'purpose:placement',
  destination: {destination_id: 'destination:codex-fixture', endpoint: 'https://codex.openai.test/v1/execute', locality: 'remote'},
  transmitted_fields: [{field_id: 'field:source-content', data_class: 'data:source-content', segment_id: 'segment:cdx-000', redaction_receipt_sha256: '4a1b52bf2f36e1bc834b20df223c921abb8ea01bb0d673bb08da5d4e6bfda807'}],
  transmitted_artifacts: ['artifact:intelligence-proposal'],
  redactions: [{rule_id: 'redaction:remove-secrets', receipt_sha256: '4a1b52bf2f36e1bc834b20df223c921abb8ea01bb0d673bb08da5d4e6bfda807', status: 'applied'}],
  capabilities: ['capability:produce-proposal'],
  retention_facts: [{retention_fact_id: 'retention:codex-fixture', status: 'unknown_acknowledged', max_days: 0, data_use: 'provider_training_unknown', region: 'unsupported', subprocessors: []}],
  retention_artifacts: ['artifact:intelligence-proposal'],
  credential_boundary: {credential_ref: 'credential-ref:codex-login', store: 'os_credential_store', authentication_method: 'local_process', provider_id: 'provider:codex', purpose_id: 'purpose:placement', adapter_visibility: 'none'},
  ceilings: {input_bytes: 4096, output_bytes: 3000, runtime_ms: 800, cost_microunits: 5000},
  contracts: {adapter_contract_version: '1.0.0', prompt_contract_version: '1.0.0', proposal_schema_id: 'mdplace.intelligence-proposal/v1', proposal_schema_version: '1.0.0'},
  payload_segments: [{segment_id: 'segment:cdx-000', field_id: 'field:source-content', utf8: '', byte_length: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}],
  cached_proposal_binding: null,
};

const requirementDefinitions = [
  ['Canonical Codex Intelligence Adapter vocabulary and stable identifiers are normative', ['Codex Intelligence Adapter', 'Intelligence Adapter', 'Processing Envelope', 'Conformance Profile']],
  ['The Codex boundary and lifecycle contracts are closed and complete', ['Codex Intelligence Adapter', 'Processing Envelope', 'Intelligence Proposal', 'Adapter Run Receipt']],
  ['Fixtures observe exact boundaries, denials, inert proposals, receipts, and recovery', ['Conformance Fixture', 'Intelligence Proposal', 'Adapter Run Receipt']],
  ['Capability, network, authentication, destination, and Processing Envelope proof precede transmission', ['Codex Intelligence Adapter', 'Processing Envelope', 'Processing Policy']],
  ['Codex output remains inert advice with zero tool or semantic authority', ['Codex Intelligence Adapter', 'Intelligence Proposal', 'Semantic Kernel', 'Vault Mutation Gate', 'Folder Projection']],
  ['One isolated claim row derives a non-elevating four-state verdict', ['Claim Manifest', 'Conformance Profile', 'Conformance Verdict']],
  ['Validator assertions bind every artifact to ordered accepted decisions and machine evidence', ['Traceability Record', 'Conformance Fixture', 'Adapter Run Receipt']],
  ['The Codex profile is specification and conformance only', ['Specification Package', 'Conformance Profile', 'Semantic Kernel', 'Vault Mutation Gate']],
];

function anchor(id, title) {
  return `normative/codex-intelligence-adapter-profile.md#${`${id}: ${title}`.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-')}`;
}

export const codexAdapterRequirements = requirementDefinitions.map(([title, canonicalTerms], index) => {
  const id = `REQ-CODEX-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    title,
    normative_anchor: anchor(id, title),
    decision_urls: codexDecisionInputs,
    canonical_terms: canonicalTerms,
    acceptance_gate: `Codex Intelligence Adapter profile gate ${index + 1} is satisfied by closed observable conformance evidence.`,
    scope: 'codex-intelligence-adapter',
  };
});

export const codexAdapterVerdicts = {
  $schema: '../schemas/codex-adapter-verdict-table.schema.json',
  schema_id: 'mdplace.codex-adapter-verdict-table/v1',
  table_id: 'VERDICT-CODEX-ADAPTER-V1',
  profile_id: 'codex-adapter',
  precedence: ['fail', 'unsupported', 'inconclusive', 'pass'],
  rows: [
    {verdict: 'pass', meaning: 'Every mandatory Codex boundary and digest is current and passing.', required_fact_effect: 'satisfied', claim_effect: 'eligible_pass'},
    {verdict: 'fail', meaning: 'Observed behavior contradicts the approved Codex boundary or a bound artifact is invalid.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'unsupported', meaning: 'A mandatory Codex interface, capability, network, or authentication fact is unsupported.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'inconclusive', meaning: 'Available Codex evidence cannot determine a mandatory fact.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
  ],
};

const authority = (role) => ({roles: [role], quorum: 1, distinct_actors: false, delegation: 'forbidden'});
const tableDefinitions = [
  ['capability-proof', 'CDXCAP', ['unproven', 'proven', 'stale'], ['authorize_adapter_attempt', 'record_adapter_outcome', 'mark_capability_stale'], {'unproven:authorize_adapter_attempt': 'proven', 'proven:record_adapter_outcome': 'proven', 'proven:mark_capability_stale': 'stale', 'stale:authorize_adapter_attempt': 'proven'}],
  ['network-proof', 'CDXNET', ['unproven', 'proven', 'denied'], ['authorize_remote_egress', 'transmit_remote_payload', 'deny_remote_egress'], {'unproven:authorize_remote_egress': 'proven', 'unproven:deny_remote_egress': 'denied', 'proven:transmit_remote_payload': 'proven', 'proven:deny_remote_egress': 'denied', 'denied:deny_remote_egress': 'denied'}],
  ['authentication-prerequisite', 'CDXAUT', ['unknown', 'satisfied', 'denied'], ['authorize_adapter_attempt', 'record_adapter_outcome', 'deny_adapter_attempt'], {'unknown:authorize_adapter_attempt': 'satisfied', 'unknown:deny_adapter_attempt': 'denied', 'satisfied:record_adapter_outcome': 'satisfied', 'satisfied:deny_adapter_attempt': 'denied', 'denied:deny_adapter_attempt': 'denied'}],
  ['proposal-validation', 'CDXPRO', ['raw', 'validated', 'rejected'], ['record_adapter_outcome', 'deny_adapter_attempt'], {'raw:record_adapter_outcome': 'validated', 'raw:deny_adapter_attempt': 'rejected', 'validated:record_adapter_outcome': 'validated', 'validated:deny_adapter_attempt': 'rejected', 'rejected:deny_adapter_attempt': 'rejected'}],
  ['denial', 'CDXDEN', ['evaluating', 'denied'], ['authorize_adapter_attempt', 'deny_adapter_attempt'], {'evaluating:authorize_adapter_attempt': 'evaluating', 'evaluating:deny_adapter_attempt': 'denied', 'denied:deny_adapter_attempt': 'denied'}],
  ['failure', 'CDXFAIL', ['ready', 'running', 'failed'], ['start_adapter_attempt', 'record_adapter_outcome', 'deny_adapter_attempt'], {'ready:start_adapter_attempt': 'running', 'running:record_adapter_outcome': 'ready', 'running:deny_adapter_attempt': 'failed', 'failed:start_adapter_attempt': 'running'}],
  ['recovery', 'CDXREC', ['interrupted', 'revalidating', 'recovered', 'blocked'], ['inspect_adapter_recovery', 'recover_adapter_receipt', 'deny_adapter_recovery'], {'interrupted:inspect_adapter_recovery': 'revalidating', 'revalidating:recover_adapter_receipt': 'recovered', 'revalidating:deny_adapter_recovery': 'blocked'}],
];

const commandRole = (command) => {
  if (command === 'mark_capability_stale') return 'conformance_validator';
  if (command.startsWith('inspect_') || command.startsWith('recover_') || command === 'deny_adapter_recovery') return 'foreground_recovery';
  return 'mdplace_agent';
};

export function codexAdapterTransitionTables() {
  return tableDefinitions.map(([name, prefix, states, commands, allowed]) => ({
    path: `contracts/transitions/codex-adapter-${name}-lifecycle.json`,
    document: {
      $schema: '../schemas/transition-table.schema.json',
      schema_id: 'mdplace.transition-table/v1',
      table_id: `TRANS-${prefix}`,
      lifecycle: `Codex Intelligence Adapter ${name}`,
      version: '1.0.0',
      states,
      commands,
      transitions: states.flatMap((state) => commands.map((command, pairIndex) => {
        const target = allowed[`${state}:${command}`];
        const permitted = target !== undefined;
        return {
          transition_id: `TR-${prefix}-${String(states.indexOf(state) * commands.length + pairIndex + 1).padStart(3, '0')}`,
          command_or_event: command,
          from_state: state,
          allowed: permitted,
          actor_authority: authority(commandRole(command)),
          preconditions: ['exact Codex boundary, capability, network, authentication, and Processing Envelope bindings are current'],
          base_references: ['boundary_sha256', 'capability_proof_sha256', 'network_proof_sha256', 'authentication_prerequisite_sha256', 'processing_envelope_sha256'],
          emitted_records: [permitted ? 'CodexAdapterTransitionObserved' : 'CodexAdapterDenied'],
          filesystem_effects: ['none'],
          idempotency: {key_fields: ['scenario_id'], retry_result: 'return the digest-identical receipt'},
          terminal_state: target ?? state,
          failure_result: {code: 'codex.illegal_transition', state_effect: 'unchanged', emitted_records: ['CodexAdapterDenied'], filesystem_effects: ['none']},
          recovery: 'Revalidate the exact parsed boundary and Claim Manifest before another transition.',
        };
      })),
    },
  }));
}
