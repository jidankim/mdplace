import {readFileSync} from 'node:fs';

import {codexInterfaceSchema, codexInvocationContractSchema} from './codex-adapter-invocation.mjs';

const draft = 'https://json-schema.org/draft/2020-12/schema';
const digest = {type: 'string', pattern: '^[a-f0-9]{64}$'};
const stringList = {type: 'array', uniqueItems: true, items: {type: 'string'}};
const noneAuthority = {
  type: 'object', additionalProperties: false,
  required: ['semantic', 'note_placement', 'taxonomy', 'projection', 'filesystem', 'tool', 'command', 'automation'],
  properties: Object.fromEntries(
    ['semantic', 'note_placement', 'taxonomy', 'projection', 'filesystem', 'tool', 'command', 'automation']
      .map((key) => [key, {const: 'none'}]),
  ),
};
const status = {enum: ['current', 'missing', 'stale', 'ambiguous', 'unsupported', 'inconclusive', 'mismatch', 'excessive', 'failed']};

const profile = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-intelligence-adapter-profile:v1',
  title: 'mdplace Codex Intelligence Adapter profile', type: 'object', additionalProperties: false,
  required: ['$schema', 'schema_id', 'profile_id', 'owner', 'version', 'protocol_ref', 'approved_processing_envelope_ref', 'decision_inputs', 'interface', 'exact_destination', 'evidence_refs', 'ceilings', 'authority', 'specification_only', 'live_codex_behavior_asserted', 'network_operation_performed'],
  properties: {
    $schema: {const: '../schemas/codex-intelligence-adapter-profile.schema.json'},
    schema_id: {const: 'mdplace.codex-intelligence-adapter-profile/v1'},
    profile_id: {const: 'codex-adapter'}, owner: {const: 'codex-adapter'}, version: {const: '1.0.0'},
    protocol_ref: {const: 'normative/intelligence-adapter-protocol.md'},
    approved_processing_envelope_ref: {const: 'contracts/codex-intelligence-adapter/approved-processing-envelope.json'},
    decision_inputs: {type: 'array', prefixItems: [
      {const: 'https://github.com/jidankim/mdplace/issues/11#issuecomment-5118839348'},
      {const: 'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093'},
    ], minItems: 2, maxItems: 2},
    interface: {$ref: '#/$defs/interface'}, exact_destination: {const: 'https://codex.openai.test/v1/execute'},
    evidence_refs: {$ref: '#/$defs/evidenceRefs'}, ceilings: {$ref: '#/$defs/ceilings'}, authority: noneAuthority,
    specification_only: {const: true}, live_codex_behavior_asserted: {const: false}, network_operation_performed: {const: false},
  },
  $defs: {
    interface: codexInterfaceSchema,
    evidenceRefs: {type: 'object', additionalProperties: false, required: ['boundary', 'invocation_contract', 'authentication_prerequisite', 'capability_proof', 'network_proof'], properties: {
      boundary: {const: 'contracts/codex-intelligence-adapter/boundary.json'},
      invocation_contract: {const: 'contracts/codex-intelligence-adapter/invocation-contract.json'},
      authentication_prerequisite: {const: 'contracts/codex-intelligence-adapter/authentication-prerequisite.json'},
      capability_proof: {const: 'contracts/codex-intelligence-adapter/capability-proof.json'},
      network_proof: {const: 'contracts/codex-intelligence-adapter/network-proof.json'},
    }},
    ceilings: {type: 'object', additionalProperties: false, required: ['input_bytes', 'jsonl_bytes', 'output_bytes', 'runtime_ms', 'tokens', 'cost_microunits'], properties: {
      input_bytes: {const: 4096}, jsonl_bytes: {const: 8192}, output_bytes: {const: 3000}, runtime_ms: {const: 800}, tokens: {const: 2000}, cost_microunits: {const: 5000},
    }},
  },
};

const boundary = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-boundary:v1', title: 'mdplace Codex boundary',
  type: 'object', additionalProperties: false,
  required: ['$schema', 'schema_id', 'boundary_id', 'profile_id', 'status', 'interface', 'invocation_contract_sha256', 'output_schema_sha256', 'approved_processing_envelope_ref', 'approved_processing_envelope_sha256', 'processing_envelope_sha256', 'authentication_prerequisite_ref', 'authentication_prerequisite_sha256', 'capability_proof_ref', 'capability_proof_sha256', 'network_proof_ref', 'network_proof_sha256', 'exact_destination', 'transmitted_fields', 'payload_sha256', 'payload_bytes', 'isolation', 'observed_at', 'expires_at'],
  properties: {
    $schema: {const: '../schemas/codex-adapter-boundary.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-boundary/v1'},
    boundary_id: {const: 'codex-boundary:v1'}, profile_id: {const: 'codex-adapter'}, status,
    interface: profile.$defs.interface,
    invocation_contract_sha256: digest, output_schema_sha256: digest,
    approved_processing_envelope_ref: {const: 'contracts/codex-intelligence-adapter/approved-processing-envelope.json'}, approved_processing_envelope_sha256: digest,
    processing_envelope_sha256: digest,
    authentication_prerequisite_ref: {const: 'contracts/codex-intelligence-adapter/authentication-prerequisite.json'}, authentication_prerequisite_sha256: digest,
    capability_proof_ref: {const: 'contracts/codex-intelligence-adapter/capability-proof.json'}, capability_proof_sha256: digest,
    network_proof_ref: {const: 'contracts/codex-intelligence-adapter/network-proof.json'}, network_proof_sha256: digest,
    exact_destination: {const: 'https://codex.openai.test/v1/execute'},
    transmitted_fields: {type: 'array', minItems: 1, uniqueItems: true, items: {enum: ['field:source-content']}},
    payload_sha256: digest, payload_bytes: {type: 'integer', minimum: 1, maximum: 4096},
    isolation: {type: 'object', additionalProperties: false, required: ['fresh_process', 'scratch_only', 'vault_visible', 'ambient_configuration', 'tools', 'authority'], properties: {
      fresh_process: {const: true}, scratch_only: {const: true}, vault_visible: {const: false},
      ambient_configuration: {const: 'unreadable'}, tools: {type: 'array', maxItems: 0}, authority: noneAuthority,
    }},
    observed_at: {type: 'string', format: 'date-time'}, expires_at: {type: 'string', format: 'date-time'},
  },
};

const authentication = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-authentication-prerequisite:v1', title: 'mdplace Codex authentication prerequisite',
  type: 'object', additionalProperties: false,
  required: ['$schema', 'schema_id', 'prerequisite_id', 'profile_id', 'status', 'mechanism', 'opaque', 'satisfied', 'secret_observed', 'claims_established', 'observed_at', 'expires_at'],
  properties: {
    $schema: {const: '../schemas/codex-authentication-prerequisite.schema.json'}, schema_id: {const: 'mdplace.codex-authentication-prerequisite/v1'},
    prerequisite_id: {const: 'codex-authentication:v1'}, profile_id: {const: 'codex-adapter'}, status,
    mechanism: {const: 'documented_saved_codex_login'}, opaque: {const: true}, satisfied: {type: 'boolean'},
    secret_observed: {const: false}, claims_established: {type: 'array', maxItems: 0},
    observed_at: {type: 'string', format: 'date-time'}, expires_at: {type: 'string', format: 'date-time'},
  },
};

const capability = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-capability-proof:v1', title: 'mdplace Codex capability proof',
  type: 'object', additionalProperties: false,
  required: ['$schema', 'schema_id', 'proof_id', 'profile_id', 'status', 'cli_version', 'deny_set_sha256', 'enabled_non_capability_features', 'disabled_capability_features', 'inventories', 'effective_capabilities', 'proof_result', 'observed_at', 'expires_at'],
  properties: {
    $schema: {const: '../schemas/codex-capability-proof.schema.json'}, schema_id: {const: 'mdplace.codex-capability-proof/v1'},
    proof_id: {const: 'codex-capability-proof:v1'}, profile_id: {const: 'codex-adapter'}, status,
    cli_version: {const: '0.104.0'}, deny_set_sha256: digest,
    enabled_non_capability_features: {type: 'array', items: {enum: ['jsonl_output', 'schema_constrained_final']}, minItems: 2, maxItems: 2, uniqueItems: true},
    disabled_capability_features: {type: 'array', minItems: 12, maxItems: 12, uniqueItems: true, items: {enum: ['shell', 'unified_exec', 'browser', 'computer_use', 'image_generation', 'mcp', 'plugins', 'skills', 'hooks', 'multi_agent', 'web_search', 'workspace_dependencies']}},
    inventories: {type: 'object', additionalProperties: false, required: ['model_visible_tools', 'mcp_servers', 'apps', 'plugins', 'skills', 'instruction_roots', 'host_files'], properties: Object.fromEntries(
      ['model_visible_tools', 'mcp_servers', 'apps', 'plugins', 'skills', 'instruction_roots', 'host_files'].map((key) => [key, {type: 'array', maxItems: 0}]),
    )},
    effective_capabilities: {type: 'array', prefixItems: [{const: 'emit_jsonl'}, {const: 'emit_schema_validated_proposal'}], minItems: 2, maxItems: 2},
    proof_result: {const: 'exact'}, observed_at: {type: 'string', format: 'date-time'}, expires_at: {type: 'string', format: 'date-time'},
  },
};

const network = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-network-proof:v1', title: 'mdplace Codex network proof',
  type: 'object', additionalProperties: false,
  required: ['$schema', 'schema_id', 'proof_id', 'profile_id', 'status', 'boundary_id', 'allowed_destination', 'authentication_only_destinations', 'observed_payload_destinations', 'unauthorized_destination_bytes', 'proof_result', 'observed_at', 'expires_at'],
  properties: {
    $schema: {const: '../schemas/codex-network-proof.schema.json'}, schema_id: {const: 'mdplace.codex-network-proof/v1'},
    proof_id: {const: 'codex-network-proof:v1'}, profile_id: {const: 'codex-adapter'}, status,
    boundary_id: {const: 'network-boundary:codex-fixture-v1'}, allowed_destination: {const: 'https://codex.openai.test/v1/execute'},
    authentication_only_destinations: {type: 'array', prefixItems: [{const: 'https://auth.openai.test/login'}], minItems: 1, maxItems: 1},
    observed_payload_destinations: {type: 'array', minItems: 1, maxItems: 1, items: {const: 'https://codex.openai.test/v1/execute'}},
    unauthorized_destination_bytes: {const: 0}, proof_result: {const: 'exact'},
    observed_at: {type: 'string', format: 'date-time'}, expires_at: {type: 'string', format: 'date-time'},
  },
};

const proposal = {
  ...JSON.parse(readFileSync(new URL('../contracts/schemas/intelligence-proposal.schema.json', import.meta.url), 'utf8')),
  $id: 'urn:mdplace:schema:codex-adapter-proposal:v1',
  title: 'mdplace Codex Intelligence Proposal',
};

const denial = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-denial:v1', title: 'mdplace Codex denial evidence',
  type: 'object', additionalProperties: false,
  required: ['schema_id', 'denial_id', 'profile_id', 'scenario_id', 'code', 'boundary', 'transmitted_bytes', 'transmitted_sha256', 'destination', 'semantic_effects', 'filesystem_effects', 'tool_invocations'],
  properties: {
    schema_id: {const: 'mdplace.codex-adapter-denial/v1'}, denial_id: {type: 'string', pattern: '^codex-denial:cdx-[0-9]{3}$'},
    profile_id: {const: 'codex-adapter'}, scenario_id: {type: 'string', pattern: '^CDX-[0-9]{3}$'},
    code: {type: 'string', pattern: '^codex\\.[a-z0-9_]+$'}, boundary: {enum: ['pre_transmission', 'post_response_validation', 'recovery']},
    transmitted_bytes: {type: 'integer', minimum: 0}, transmitted_sha256: digest, destination: {type: ['string', 'null'], format: 'uri'},
    semantic_effects: {type: 'array', maxItems: 0}, filesystem_effects: {type: 'array', maxItems: 0}, tool_invocations: {type: 'array', maxItems: 0},
  },
};

const receipt = {
  ...JSON.parse(readFileSync(new URL('../contracts/schemas/adapter-run-receipt.schema.json', import.meta.url), 'utf8')),
  $id: 'urn:mdplace:schema:codex-adapter-receipt:v1',
  title: 'mdplace Codex Adapter Run Receipt',
};

const attemptObservation = {
  type: 'object', additionalProperties: false,
  required: ['observed_started_at', 'observed_completed_at', 'provider_request_id', 'isolation'],
  properties: {
    observed_started_at: {type: 'string', format: 'date-time'}, observed_completed_at: {type: 'string', format: 'date-time'},
    provider_request_id: {type: ['string', 'null'], pattern: '^provider-request:cdx-[0-9]{3}$'},
    isolation: {type: 'object', additionalProperties: false,
      required: ['ephemeral', 'fresh_process', 'filesystem', 'tools', 'ambient_configuration', 'credential_visibility', 'network_scope', 'effective_capabilities', 'canary'],
      properties: {
        ephemeral: {type: 'boolean'}, fresh_process: {type: 'boolean'}, filesystem: {enum: ['none', 'present']}, tools: {enum: ['none', 'present']},
        ambient_configuration: {enum: ['unreadable', 'readable']}, credential_visibility: {enum: ['none', 'visible']},
        network_scope: stringList, effective_capabilities: stringList,
        canary: {type: 'object', additionalProperties: false, required: ['canary_id', 'challenge', 'expected', 'observed', 'passed'], properties: {
          canary_id: {type: 'string', pattern: '^canary:cdx-[0-9]{3}$'}, challenge: {type: 'string', minLength: 1},
          expected: {type: 'string', minLength: 1}, observed: {type: 'string', minLength: 1}, passed: {type: 'boolean'},
        }},
      },
    },
  },
};

const scenario = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-scenario:v1', title: 'mdplace Codex conformance scenario',
  type: 'object', additionalProperties: false,
  required: ['schema_id', 'scenario_id', 'case_id', 'category', 'operation', 'evaluated_at', 'boundary_json', 'boundary_sha256', 'authentication_json', 'authentication_sha256', 'capability_json', 'capability_sha256', 'network_json', 'network_sha256', 'processing_envelope_json', 'processing_envelope_sha256', 'attempt_observation', 'payload_base64', 'payload_bytes', 'payload_sha256', 'requested_destination', 'transmitted_bytes', 'transmitted_sha256', 'raw_output', 'output_bytes', 'jsonl_bytes', 'runtime_ms', 'tokens', 'cost_microunits', 'ceilings', 'interface_mode', 'authentication_variant', 'capability_variant', 'network_variant', 'behavior', 'output_kind', 'claimed_authority', 'claimed_auth_fact', 'transition_ref'],
  properties: {
    schema_id: {const: 'mdplace.codex-adapter-scenario/v1'}, scenario_id: {type: 'string', pattern: '^CDX-[0-9]{3}$'},
    case_id: {type: 'string', pattern: '^[a-z][a-z0-9-]{2,96}$'}, category: {enum: ['positive', 'negative', 'exact_boundary', 'over_boundary', 'stale_state', 'authority_denial', 'illegal_transition', 'crash_recovery']},
    operation: {enum: ['execute', 'recover', 'transition']}, evaluated_at: {const: '2026-08-24T00:00:00.000Z'},
    boundary_json: {type: ['string', 'null']}, boundary_sha256: {type: ['string', 'null'], pattern: '^[a-f0-9]{64}$'},
    authentication_json: {type: ['string', 'null']}, authentication_sha256: {type: ['string', 'null'], pattern: '^[a-f0-9]{64}$'},
    capability_json: {type: ['string', 'null']}, capability_sha256: {type: ['string', 'null'], pattern: '^[a-f0-9]{64}$'},
    network_json: {type: ['string', 'null']}, network_sha256: {type: ['string', 'null'], pattern: '^[a-f0-9]{64}$'},
    processing_envelope_json: {type: 'string', minLength: 2}, processing_envelope_sha256: digest, attempt_observation: attemptObservation,
    payload_base64: {type: 'string', format: 'canonical-base64'},
    payload_bytes: {type: 'integer', minimum: 0}, payload_sha256: digest,
    requested_destination: {type: 'string', format: 'uri'}, transmitted_bytes: {type: 'integer', minimum: 0}, transmitted_sha256: digest,
    raw_output: {type: ['string', 'null']}, output_bytes: {type: 'integer', minimum: 0}, jsonl_bytes: {type: 'integer', minimum: 0}, runtime_ms: {type: 'integer', minimum: 0}, tokens: {type: 'integer', minimum: 0}, cost_microunits: {type: 'integer', minimum: 0},
    ceilings: profile.$defs.ceilings, interface_mode: {enum: ['non_interactive', 'interactive_only']}, authentication_variant: status, capability_variant: status, network_variant: status,
    behavior: {enum: ['complete', 'missing_boundary', 'stale_binding', 'unapproved_destination', 'unapproved_payload', 'isolation_unavailable', 'unsupported_fallback', 'crash_before_transmission', 'crash_after_transmission', 'recover_current', 'recover_stale']},
    output_kind: {enum: ['valid', 'malformed', 'tool_request', 'command_request', 'secret_request', 'authority_request', 'none']},
    claimed_authority: {enum: ['none', 'semantic', 'note_placement', 'taxonomy', 'projection', 'filesystem', 'tool', 'command', 'automation']},
    claimed_auth_fact: {type: ['string', 'null'], enum: [null, 'capability', 'network', 'residency', 'retention', 'training', 'deletion', 'entitlement', 'privacy']},
    transition_ref: {enum: [
      null,
      'contracts/transitions/codex-adapter-capability-proof-lifecycle.json#unproven:record_adapter_outcome',
      'contracts/transitions/codex-adapter-network-proof-lifecycle.json#unproven:transmit_remote_payload',
      'contracts/transitions/codex-adapter-authentication-prerequisite-lifecycle.json#unknown:record_adapter_outcome',
      'contracts/transitions/codex-adapter-proposal-validation-lifecycle.json#rejected:record_adapter_outcome',
      'contracts/transitions/codex-adapter-denial-lifecycle.json#denied:authorize_adapter_attempt',
      'contracts/transitions/codex-adapter-failure-lifecycle.json#ready:record_adapter_outcome',
      'contracts/transitions/codex-adapter-recovery-lifecycle.json#recovered:recover_adapter_receipt',
    ]},
  },
};

const fixtureManifest = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-fixture-manifest:v1', title: 'mdplace Codex fixture manifest',
  type: 'object', additionalProperties: false, required: ['$schema', 'schema_id', 'manifest_id', 'profile_id', 'requirements', 'fixtures', 'intake_fixtures', 'stateful_scenarios'],
  properties: {
    $schema: {const: '../schemas/codex-adapter-fixture-manifest.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-fixture-manifest/v1'}, manifest_id: {const: 'codex-adapter-fixtures:v1'}, profile_id: {const: 'codex-adapter'},
    requirements: {type: 'array', minItems: 8, maxItems: 8, uniqueItems: true, items: {type: 'string', pattern: '^REQ-CODEX-[0-9]{3}$'}},
    fixtures: {type: 'array', minItems: 77, maxItems: 77, items: {$ref: '#/$defs/fixture'}}, intake_fixtures: {const: 0}, stateful_scenarios: {const: 0},
  },
  $defs: {fixture: {type: 'object', additionalProperties: false, required: ['fixture_id', 'path', 'category', 'requirement_ids'], properties: {
    fixture_id: {type: 'string', pattern: '^FIX-CODEX-PROFILE-[0-9]{3}$'}, path: {type: 'string', pattern: '^scenarios/codex-intelligence-adapter/[a-z][a-z0-9-]+\\.json$'},
    category: scenario.properties.category, requirement_ids: {type: 'array', minItems: 8, maxItems: 8, uniqueItems: true, items: {type: 'string', pattern: '^REQ-CODEX-[0-9]{3}$'}},
  }}},
};

const evidence = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-evidence:v1', title: 'mdplace Codex machine evidence',
  type: 'object', additionalProperties: false, required: ['$schema', 'schema_id', 'evidence_id', 'profile_id', 'validator_version', 'fixture_bindings', 'receipt_sha256s', 'approved_processing_envelope_sha256', 'boundary_sha256', 'invocation_contract_sha256', 'output_schema_sha256', 'authentication_prerequisite_sha256', 'capability_proof_sha256', 'network_proof_sha256', 'fixture_manifest_sha256', 'network_operations', 'intake_fixtures', 'stateful_scenarios', 'verdict'],
  properties: {
    $schema: {const: '../../contracts/schemas/codex-adapter-evidence.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-evidence/v1'}, evidence_id: {const: 'codex-adapter-evidence:v1'}, profile_id: {const: 'codex-adapter'}, validator_version: {const: '1.2.0'},
    fixture_bindings: {type: 'array', minItems: 77, maxItems: 77, items: {$ref: '#/$defs/binding'}}, receipt_sha256s: {type: 'array', minItems: 77, maxItems: 77, items: digest},
    approved_processing_envelope_sha256: digest, boundary_sha256: digest, invocation_contract_sha256: digest, output_schema_sha256: digest,
    authentication_prerequisite_sha256: digest, capability_proof_sha256: digest, network_proof_sha256: digest, fixture_manifest_sha256: digest,
    network_operations: {const: 0}, intake_fixtures: {const: 0}, stateful_scenarios: {const: 0}, verdict: {const: 'pass'},
  },
  $defs: {binding: {type: 'object', additionalProperties: false, required: ['fixture_id', 'path', 'fixture_sha256', 'receipt_sha256', 'verdict'], properties: {
    fixture_id: {type: 'string', pattern: '^FIX-CODEX-PROFILE-[0-9]{3}$'}, path: {type: 'string', pattern: '^conformance/scenarios/codex-intelligence-adapter/[a-z][a-z0-9-]+\\.json$'}, fixture_sha256: digest, receipt_sha256: digest, verdict: {enum: ['pass', 'fail']},
  }}},
};

const recovery = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-recovery-report:v1', title: 'mdplace Codex recovery report',
  type: 'object', additionalProperties: false, required: ['$schema', 'schema_id', 'report_id', 'profile_id', 'claim_manifest_sha256', 'evidence_digest', 'parsed_artifacts_revalidated', 'cases', 'network_operations', 'verdict'],
  properties: {
    $schema: {const: '../../contracts/schemas/codex-adapter-recovery-report.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-recovery-report/v1'}, report_id: {const: 'codex-adapter-recovery:v1'}, profile_id: {const: 'codex-adapter'}, claim_manifest_sha256: digest, evidence_digest: digest, parsed_artifacts_revalidated: {const: true},
    cases: {type: 'array', minItems: 4, maxItems: 4, items: {$ref: '#/$defs/case'}}, network_operations: {const: 0}, verdict: {const: 'pass'},
  },
  $defs: {case: {type: 'object', additionalProperties: false, required: ['fixture_id', 'target_fixture_id', 'target_path', 'target_chain_id', 'target_attempt_id', 'target_attempt_sequence', 'target_attempt_class', 'target_authorization_id', 'target_envelope_id', 'target_envelope_sha256', 'preceding_receipt_sha256s', 'target_receipt_sha256', 'terminal_state', 'receipt_sha256'], properties: {
    fixture_id: {type: 'string', pattern: '^FIX-CODEX-PROFILE-[0-9]{3}$'}, target_fixture_id: {type: 'string', pattern: '^FIX-CODEX-PROFILE-[0-9]{3}$'}, target_path: {type: 'string', pattern: '^conformance/scenarios/codex-intelligence-adapter/[a-z][a-z0-9-]+\\.json$'}, target_chain_id: {type: 'string', pattern: '^adapter-chain:cdx-[0-9]{3}$'}, target_attempt_id: {type: 'string', pattern: '^adapter-attempt:cdx-[0-9]{3}$'}, target_attempt_sequence: {const: 0}, target_attempt_class: {const: 'primary'}, target_authorization_id: {const: 'adapter-authorization:remote-primary'}, target_envelope_id: {type: 'string', pattern: '^envelope:cdx-[0-9]{3}$'}, target_envelope_sha256: digest, preceding_receipt_sha256s: {type: 'array', maxItems: 0, items: digest}, target_receipt_sha256: digest, terminal_state: {enum: ['recovery_required', 'recovered']}, receipt_sha256: digest,
  }}},
};

const claim = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-claim-manifest:v1', title: 'mdplace Codex isolated claim',
  type: 'object', additionalProperties: false, required: ['$schema', 'schema_id', 'manifest_id', 'package_series', 'release_version', 'validator_id', 'validator_version', 'rows'],
  properties: {
    $schema: {const: '../schemas/codex-adapter-claim-manifest.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-claim-manifest/v1'}, manifest_id: {const: 'codex-adapter-claim:v1'}, package_series: {const: 'mdplace-spec/v1'}, release_version: {const: '1.0.0'}, validator_id: {const: 'mdplace.package-validator'}, validator_version: {const: '1.2.0'},
    rows: {type: 'array', minItems: 1, maxItems: 1, items: {$ref: '#/$defs/row'}},
  },
  $defs: {
    material: {type: 'object', additionalProperties: false, required: ['ordinal', 'label', 'path', 'sha256'], properties: {ordinal: {type: 'integer', minimum: 0}, label: {type: 'string', pattern: '^codex_material_[0-9]{3}$'}, path: {type: 'string', minLength: 1}, sha256: digest}},
    dependencies: {type: 'object', additionalProperties: false, required: ['core', 'product_readiness', 'local_adapter', 'remote_adapter', 'placement_automation', 'other_profiles'], properties: Object.fromEntries(['core', 'product_readiness', 'local_adapter', 'remote_adapter', 'placement_automation', 'other_profiles'].map((key) => [key, {const: false}]))},
    row: {type: 'object', additionalProperties: false, required: ['id', 'owner', 'verdict', 'evidence_digest', 'evidence_material', 'dependencies_elevated'], properties: {id: {const: 'codex-adapter'}, owner: {const: 'codex-adapter'}, verdict: {enum: ['pass', 'fail', 'unsupported', 'inconclusive']}, evidence_digest: digest, evidence_material: {type: 'array', minItems: 90, maxItems: 90, items: {$ref: '#/$defs/material'}}, dependencies_elevated: {$ref: '#/$defs/dependencies'}}},
  },
};

const verdict = {
  $schema: draft, $id: 'urn:mdplace:schema:codex-adapter-verdict-table:v1', title: 'mdplace Codex verdict table',
  type: 'object', additionalProperties: false, required: ['$schema', 'schema_id', 'table_id', 'profile_id', 'precedence', 'rows'],
  properties: {
    $schema: {const: '../schemas/codex-adapter-verdict-table.schema.json'}, schema_id: {const: 'mdplace.codex-adapter-verdict-table/v1'}, table_id: {const: 'VERDICT-CODEX-ADAPTER-V1'}, profile_id: {const: 'codex-adapter'},
    precedence: {type: 'array', prefixItems: [{const: 'fail'}, {const: 'unsupported'}, {const: 'inconclusive'}, {const: 'pass'}], minItems: 4, maxItems: 4},
    rows: {type: 'array', minItems: 4, maxItems: 4, items: {type: 'object', additionalProperties: false, required: ['verdict', 'meaning', 'required_fact_effect', 'claim_effect'], properties: {verdict: {enum: ['pass', 'fail', 'unsupported', 'inconclusive']}, meaning: {type: 'string', minLength: 1}, required_fact_effect: {enum: ['satisfied', 'non_pass']}, claim_effect: {enum: ['eligible_pass', 'deny_pass']}}}},
  },
};

export const codexAdapterSchemas = [
  ['contracts/schemas/codex-intelligence-adapter-profile.schema.json', profile],
  ['contracts/schemas/codex-invocation-contract.schema.json', codexInvocationContractSchema],
  ['contracts/schemas/codex-adapter-boundary.schema.json', boundary],
  ['contracts/schemas/codex-authentication-prerequisite.schema.json', authentication],
  ['contracts/schemas/codex-capability-proof.schema.json', capability],
  ['contracts/schemas/codex-network-proof.schema.json', network],
  ['contracts/schemas/codex-adapter-proposal.schema.json', proposal],
  ['contracts/schemas/codex-adapter-denial.schema.json', denial],
  ['contracts/schemas/codex-adapter-receipt.schema.json', receipt],
  ['contracts/schemas/codex-adapter-scenario.schema.json', scenario],
  ['contracts/schemas/codex-adapter-fixture-manifest.schema.json', fixtureManifest],
  ['contracts/schemas/codex-adapter-evidence.schema.json', evidence],
  ['contracts/schemas/codex-adapter-recovery-report.schema.json', recovery],
  ['contracts/schemas/codex-adapter-claim-manifest.schema.json', claim],
  ['contracts/schemas/codex-adapter-verdict-table.schema.json', verdict],
];
