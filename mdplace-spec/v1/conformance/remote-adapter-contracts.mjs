export const remoteAdapterProfile = {
  $schema: '../schemas/remote-intelligence-adapter-profile.schema.json',
  schema_id: 'mdplace.remote-intelligence-adapter-profile/v1',
  profile_id: 'remote-adapter',
  owner: 'remote-adapter',
  version: '1.0.0',
  protocol_ref: 'normative/intelligence-adapter-protocol.md',
  approved_processing_policy_ref: 'contracts/intelligence-adapter/approved-context.json#/policy_binding',
  decision: 'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093',
  locality: 'remote',
  lifecycle: 'isolated_ephemeral_advisory',
  provider: {
    provider_id: 'provider:remote-alpha',
    destination_id: 'destination:remote-alpha',
    endpoint: 'https://api.remote-alpha.test/v1/process',
  },
  ceilings: {
    input_bytes: 4096,
    output_bytes: 3000,
    runtime_ms: 800,
    cost_microunits: 5000,
    attempts: 3,
    retries: 1,
    fallbacks: 1,
  },
  evidence_refs: {
    credential_boundary: 'contracts/remote-intelligence-adapter/credential-boundary-evidence.json',
    retention: 'contracts/remote-intelligence-adapter/retention-evidence.json',
  },
  authority: {
    semantic: 'none',
    note_placement: 'none',
    taxonomy: 'none',
    projection: 'none',
    filesystem: 'none',
    tool: 'none',
    automation: 'none',
  },
  output_schemas: [
    'contracts/schemas/intelligence-proposal.schema.json',
    'contracts/schemas/adapter-run-receipt.schema.json',
  ],
  specification_only: true,
  network_operation_performed: false,
};

const definitions = [
  ['Canonical Remote Intelligence Adapter vocabulary and stable identifiers are normative', ['Remote Intelligence Adapter', 'Intelligence Adapter', 'Processing Policy', 'Conformance Profile']],
  ['The profile claim and all lifecycle tables are closed', ['Claim Manifest', 'Conformance Verdict', 'Intelligence Adapter Attempt']],
  ['Fixtures observe the public remote profile boundary', ['Conformance Fixture', 'Processing Envelope', 'Adapter Run Receipt']],
  ['Permitted egress and every pre-egress denial are byte exact', ['Intelligence Adapter Attempt', 'Processing Envelope', 'Adapter Run Receipt']],
  ['Credential evidence proves only the normative prerequisite boundary', ['Processing Policy', 'Processing Envelope', 'Remote Intelligence Adapter']],
  ['Provider facts remain disclosed, unsupported, or inconclusive', ['Processing Policy', 'Conformance Verdict', 'Remote Intelligence Adapter']],
  ['The independent verdict derives from one exact evidence digest', ['Claim Manifest', 'Conformance Profile', 'Conformance Verdict']],
  ['The Remote Intelligence Adapter is advisory-only', ['Remote Intelligence Adapter', 'Intelligence Proposal', 'Semantic Kernel', 'Vault Mutation Gate']],
  ['Traceability preserves the accepted decision input', ['Traceability Record', 'Conformance Fixture']],
  ['The profile is specification and conformance only', ['Specification Package', 'Conformance Profile', 'Semantic Kernel', 'Vault Mutation Gate']],
];

function anchor(id, title) {
  return `normative/remote-intelligence-adapter-profile.md#${`${id}: ${title}`.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-')}`;
}

export const remoteAdapterRequirements = definitions.map(([title, canonicalTerms], index) => {
  const id = `REQ-RAP-${String(index + 1).padStart(3, '0')}`;
  return {
    id,
    title,
    normative_anchor: anchor(id, title),
    decision_urls: ['https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093'],
    canonical_terms: canonicalTerms,
    acceptance_gate: `Remote Intelligence Adapter profile gate ${index + 1} is satisfied by closed observable conformance evidence.`,
    scope: 'remote-intelligence-adapter',
  };
});

export const remoteAdapterVerdicts = {
  $schema: '../schemas/remote-adapter-verdict-table.schema.json',
  schema_id: 'mdplace.remote-adapter-verdict-table/v1',
  table_id: 'VERDICT-REMOTE-ADAPTER-V1',
  profile_id: 'remote-adapter',
  precedence: ['fail', 'unsupported', 'inconclusive', 'pass'],
  rows: [
    {verdict: 'pass', meaning: 'Every mandatory Remote Intelligence Adapter boundary and digest is current and passing.', required_fact_effect: 'satisfied', claim_effect: 'eligible_pass'},
    {verdict: 'fail', meaning: 'Observed behavior contradicts the closed remote profile or a bound artifact is invalid.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'unsupported', meaning: 'A mandatory Remote Intelligence Adapter capability or provider fact cannot be evaluated.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'inconclusive', meaning: 'Available Remote Intelligence Adapter evidence cannot determine a mandatory fact.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
  ],
};

const authorities = {
  authorize_remote_egress: 'mdplace_agent',
  transmit_remote_payload: 'mdplace_agent',
  deny_remote_egress: 'mdplace_agent',
  record_remote_failure: 'mdplace_agent',
  authorize_remote_retry: 'mdplace_agent',
  exhaust_remote_retry: 'mdplace_agent',
  authorize_remote_fallback: 'mdplace_agent',
  exhaust_remote_fallback: 'mdplace_agent',
  inspect_remote_recovery: 'foreground_recovery',
  recover_remote_receipt: 'foreground_recovery',
  deny_remote_recovery: 'foreground_recovery',
  record_pass: 'conformance_validator',
  record_fail: 'conformance_validator',
  record_unsupported: 'conformance_validator',
  record_inconclusive: 'conformance_validator',
  mark_stale: 'conformance_validator',
};

const tables = [
  ['permitted-egress', 'RAPEG', ['pending', 'authorized', 'transmitted'], ['authorize_remote_egress', 'transmit_remote_payload', 'deny_remote_egress'], {'pending:authorize_remote_egress': 'authorized', 'pending:deny_remote_egress': 'pending', 'authorized:transmit_remote_payload': 'transmitted', 'authorized:deny_remote_egress': 'pending'}],
  ['denial', 'RAPDEN', ['evaluating', 'denied'], ['authorize_remote_egress', 'deny_remote_egress'], {'evaluating:authorize_remote_egress': 'evaluating', 'evaluating:deny_remote_egress': 'denied', 'denied:deny_remote_egress': 'denied'}],
  ['failure', 'RAPFAIL', ['ready', 'running', 'failed'], ['authorize_remote_egress', 'record_remote_failure'], {'ready:authorize_remote_egress': 'running', 'running:record_remote_failure': 'failed', 'failed:authorize_remote_egress': 'running'}],
  ['retry', 'RAPRET', ['unavailable', 'authorized', 'exhausted'], ['authorize_remote_retry', 'transmit_remote_payload', 'exhaust_remote_retry'], {'unavailable:authorize_remote_retry': 'authorized', 'authorized:transmit_remote_payload': 'unavailable', 'authorized:exhaust_remote_retry': 'exhausted', 'exhausted:exhaust_remote_retry': 'exhausted'}],
  ['fallback', 'RAPFAL', ['unavailable', 'authorized', 'exhausted'], ['authorize_remote_fallback', 'transmit_remote_payload', 'exhaust_remote_fallback'], {'unavailable:authorize_remote_fallback': 'authorized', 'authorized:transmit_remote_payload': 'unavailable', 'authorized:exhaust_remote_fallback': 'exhausted', 'exhausted:exhaust_remote_fallback': 'exhausted'}],
  ['recovery', 'RAPREC', ['interrupted', 'revalidating', 'recovered', 'blocked'], ['inspect_remote_recovery', 'recover_remote_receipt', 'deny_remote_recovery'], {'interrupted:inspect_remote_recovery': 'revalidating', 'revalidating:recover_remote_receipt': 'recovered', 'revalidating:deny_remote_recovery': 'blocked'}],
  ['verdict', 'RAPVER', ['pending', 'pass', 'fail', 'unsupported', 'inconclusive'], ['record_pass', 'record_fail', 'record_unsupported', 'record_inconclusive', 'mark_stale'], {'pending:record_pass': 'pass', 'pending:record_fail': 'fail', 'pending:record_unsupported': 'unsupported', 'pending:record_inconclusive': 'inconclusive', 'pass:mark_stale': 'inconclusive', 'fail:mark_stale': 'fail', 'unsupported:mark_stale': 'unsupported', 'inconclusive:mark_stale': 'inconclusive'}],
];

export function remoteAdapterTransitionTables() {
  return tables.map(([name, prefix, states, commands, allowed]) => ({
    path: `contracts/transitions/remote-adapter-${name}-lifecycle.json`,
    document: {
      $schema: '../schemas/transition-table.schema.json',
      schema_id: 'mdplace.transition-table/v1',
      table_id: `TRANS-RAP-${name.toUpperCase()}`,
      lifecycle: `Remote Intelligence Adapter ${name}`,
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
          actor_authority: {roles: [authorities[command]], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
          preconditions: ['exact Remote Intelligence Adapter profile and evidence bindings are current'],
          base_references: ['profile_sha256', 'credential_boundary_evidence_sha256', 'retention_evidence_sha256'],
          emitted_records: [permitted ? 'RemoteAdapterTransitionObserved' : 'RemoteAdapterDenied'],
          filesystem_effects: ['none'],
          idempotency: {key_fields: ['scenario_id'], retry_result: 'return the digest-identical receipt'},
          terminal_state: target ?? state,
          failure_result: {code: 'remote.illegal_transition', state_effect: 'unchanged', emitted_records: ['RemoteAdapterDenied'], filesystem_effects: ['none']},
          recovery: 'Revalidate exact parsed evidence and the Claim Manifest before another transition.',
        };
      })),
    },
  }));
}
