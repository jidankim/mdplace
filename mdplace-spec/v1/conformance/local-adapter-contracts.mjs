export const localAdapterProfile = {
  $schema: '../schemas/local-intelligence-adapter-profile.schema.json',
  schema_id: 'mdplace.local-intelligence-adapter-profile/v1',
  profile_id: 'local-adapter', owner: 'local-adapter', version: '1.0.0',
  protocol_ref: 'normative/intelligence-adapter-protocol.md',
  approved_processing_policy_ref: 'contracts/intelligence-adapter/approved-context.json#/policy_binding',
  decision: 'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093',
  locality: 'local', lifecycle: 'isolated_ephemeral_advisory',
  execution_scope: {
    endpoint: 'local://isolated-child', network_access: 'denied', filesystem_access: 'none',
    ambient_configuration: 'unreadable', tools: 'none', credentials: 'none',
  },
  capabilities: ['emit_schema_validated_proposal', 'emit_schema_validated_receipt'],
  authority: {
    semantic: 'none', note_placement: 'none', taxonomy: 'none', projection: 'none',
    filesystem: 'none', network: 'none', tool: 'none', automation: 'none',
  },
  output_schemas: [
    'contracts/schemas/intelligence-proposal.schema.json',
    'contracts/schemas/adapter-run-receipt.schema.json',
  ],
  specification_only: true,
};

const requirementDefinitions = [
  ['Canonical Local Intelligence Adapter vocabulary and stable identifiers are normative', ['Local Intelligence Adapter', 'Intelligence Adapter', 'Processing Policy', 'Conformance Profile']],
  ['The Local Intelligence Adapter profile closes capability and isolation evidence', ['Local Intelligence Adapter', 'Intelligence Adapter Attempt', 'Adapter Isolation Canary']],
  ['Only validated proposal and receipt evidence may leave an attempt', ['Intelligence Proposal', 'Adapter Run Receipt']],
  ['Every undeclared authority is denied', ['Intelligence Adapter', 'Processing Policy', 'Semantic Kernel', 'Folder Projection']],
  ['Local execution cases are deterministic and bounded', ['Conformance Fixture', 'Intelligence Adapter Attempt']],
  ['Capability, isolation, verdict, failure, and recovery transitions are complete', ['Intelligence Adapter Attempt', 'Conformance Verdict']],
  ['The independent claim row binds one exact evidence digest', ['Claim Manifest', 'Conformance Profile', 'Conformance Verdict']],
  ['Recovery revalidates parsed evidence before reading a verdict', ['Claim Manifest', 'Conformance Verdict']],
  ['Traceability preserves the accepted decision input', ['Traceability Record', 'Conformance Fixture']],
  ['The profile is specification and conformance only', ['Specification Package', 'Conformance Profile', 'Semantic Kernel', 'Vault Mutation Gate']],
];

function anchor(id, title) {
  return `normative/local-intelligence-adapter-profile.md#${`${id}: ${title}`.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-').replace(/-+/g, '-')}`;
}

export const localAdapterRequirements = requirementDefinitions.map(([title, canonicalTerms], index) => {
  const id = `REQ-LIA-${String(index + 1).padStart(3, '0')}`;
  return {
    id, title, normative_anchor: anchor(id, title),
    decision_urls: ['https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093'],
    canonical_terms: canonicalTerms,
    acceptance_gate: `Local Intelligence Adapter profile gate ${index + 1} is satisfied by closed observable conformance evidence.`,
    scope: 'local-intelligence-adapter',
  };
});

export const localAdapterVerdicts = {
  $schema: '../schemas/local-adapter-verdict-table.schema.json',
  schema_id: 'mdplace.local-adapter-verdict-table/v1',
  table_id: 'VERDICT-LOCAL-ADAPTER-V1', profile_id: 'local-adapter',
  precedence: ['fail', 'unsupported', 'inconclusive', 'pass'],
  rows: [
    {verdict: 'pass', meaning: 'Every required Local Intelligence Adapter fact and digest is current and passing.', required_fact_effect: 'satisfied', claim_effect: 'eligible_pass'},
    {verdict: 'fail', meaning: 'Observed behavior contradicts the closed profile or a bound artifact is invalid.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'unsupported', meaning: 'A required Local Intelligence Adapter capability cannot be evaluated.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
    {verdict: 'inconclusive', meaning: 'Available Local Intelligence Adapter evidence cannot determine a required fact.', required_fact_effect: 'non_pass', claim_effect: 'deny_pass'},
  ],
};

const authorities = {
  authorize_adapter_attempt: 'mdplace_agent', record_adapter_outcome: 'mdplace_agent',
  start_adapter_attempt: 'mdplace_agent', mark_capability_stale: 'conformance_validator',
  verify_adapter_isolation: 'mdplace_agent', deny_adapter_attempt: 'mdplace_agent',
  record_pass: 'conformance_validator', record_fail: 'conformance_validator',
  record_unsupported: 'conformance_validator', record_inconclusive: 'conformance_validator',
  mark_stale: 'conformance_validator',
  inspect_adapter_recovery: 'foreground_recovery', recover_adapter_receipt: 'foreground_recovery',
  deny_adapter_recovery: 'foreground_recovery',
};

const tableDefinitions = [
  ['capability', 'LIACAP', ['unverified', 'verified', 'stale'], ['authorize_adapter_attempt', 'record_adapter_outcome', 'mark_capability_stale'], {'unverified:authorize_adapter_attempt': 'verified', 'verified:record_adapter_outcome': 'verified', 'verified:mark_capability_stale': 'stale', 'stale:authorize_adapter_attempt': 'verified'}],
  ['isolation', 'LIAISO', ['unverified', 'verified', 'failed'], ['verify_adapter_isolation', 'deny_adapter_attempt'], {'unverified:verify_adapter_isolation': 'verified', 'unverified:deny_adapter_attempt': 'failed', 'verified:deny_adapter_attempt': 'failed', 'failed:verify_adapter_isolation': 'verified', 'failed:deny_adapter_attempt': 'failed'}],
  ['verdict', 'LIAVER', ['pending', 'pass', 'fail', 'unsupported', 'inconclusive'], ['record_pass', 'record_fail', 'record_unsupported', 'record_inconclusive', 'mark_stale'], {'pending:record_pass': 'pass', 'pending:record_fail': 'fail', 'pending:record_unsupported': 'unsupported', 'pending:record_inconclusive': 'inconclusive', 'pass:mark_stale': 'inconclusive', 'fail:mark_stale': 'fail', 'unsupported:mark_stale': 'unsupported', 'inconclusive:mark_stale': 'inconclusive'}],
  ['failure', 'LIAFAIL', ['ready', 'running', 'failed'], ['start_adapter_attempt', 'record_adapter_outcome', 'deny_adapter_attempt'], {'ready:start_adapter_attempt': 'running', 'running:record_adapter_outcome': 'ready', 'running:deny_adapter_attempt': 'failed', 'failed:start_adapter_attempt': 'running'}],
  ['recovery', 'LIAREC', ['interrupted', 'revalidating', 'recovered', 'blocked'], ['inspect_adapter_recovery', 'recover_adapter_receipt', 'deny_adapter_recovery'], {'interrupted:inspect_adapter_recovery': 'revalidating', 'revalidating:recover_adapter_receipt': 'recovered', 'revalidating:deny_adapter_recovery': 'blocked'}],
];

export function localAdapterTransitionTables() {
  return tableDefinitions.map(([name, prefix, states, commands, allowed]) => ({
    path: `contracts/transitions/local-adapter-${name}-lifecycle.json`,
    document: {
      $schema: '../schemas/transition-table.schema.json', schema_id: 'mdplace.transition-table/v1',
      table_id: `TRANS-LIA-${name.toUpperCase()}`, lifecycle: `Local Intelligence Adapter ${name}`, version: '1.0.0',
      states, commands,
      transitions: states.flatMap((state) => commands.map((command, pairIndex) => {
        const target = allowed[`${state}:${command}`];
        const permitted = target !== undefined;
        return {
          transition_id: `TR-${prefix}-${String(states.indexOf(state) * commands.length + pairIndex + 1).padStart(3, '0')}`,
          command_or_event: command, from_state: state, allowed: permitted,
          actor_authority: {roles: [authorities[command]], quorum: 1, distinct_actors: false, delegation: 'forbidden'},
          preconditions: ['exact Local Intelligence Adapter profile and evidence bindings are current'],
          base_references: ['profile_sha256', 'capability_evidence_sha256', 'isolation_evidence_sha256'],
          emitted_records: [permitted ? 'LocalIntelligenceAdapterTransitionObserved' : 'LocalIntelligenceAdapterDenied'],
          filesystem_effects: ['none'],
          idempotency: {key_fields: ['scenario_id'], retry_result: 'return the digest-identical receipt'},
          terminal_state: target ?? state,
          failure_result: {code: 'local.illegal_transition', state_effect: 'unchanged', emitted_records: ['LocalIntelligenceAdapterDenied'], filesystem_effects: ['none']},
          recovery: 'Revalidate exact parsed evidence and the Claim Manifest before another transition.',
        };
      })),
    },
  }));
}
