import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {codexSha256} from './codex-adapter-core.mjs';
import {readPackageFile} from './safe-path.mjs';

const emptyDigest = codexSha256(Buffer.alloc(0));
const approvedDestination = 'https://codex.openai.test/v1/execute';
const policyDigest = '27a755ff5a6d91ce1f925c31cbc094bd25f70b54793dee4a9a4a56e8d3d07766';
const proofCodePrefixes = {
  authentication: 'authentication_prerequisite', capability: 'capability_proof', network: 'network_proof',
};
const authorityCodes = new Map([
  ['semantic', 'codex.semantic_authority_denied'], ['note_placement', 'codex.note_placement_authority_denied'],
  ['taxonomy', 'codex.taxonomy_authority_denied'], ['projection', 'codex.projection_authority_denied'],
  ['filesystem', 'codex.filesystem_authority_denied'], ['tool', 'codex.tool_authority_denied'],
  ['command', 'codex.command_authority_denied'], ['automation', 'codex.automation_authority_denied'],
]);
const outputCodes = new Map([
  ['malformed', 'codex.malformed_output'], ['tool_request', 'codex.tool_request_denied'],
  ['command_request', 'codex.command_request_denied'], ['secret_request', 'codex.secret_request_denied'],
]);

async function parseBound(raw, digest, schemaPath, missingCode, digestCode, malformedCode, packageRoot) {
  if (raw === null || digest === null) return {document: null, code: missingCode};
  if (codexSha256(raw) !== digest) return {document: null, code: digestCode};
  try {
    const document = JSON.parse(raw);
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document));
    return schemaCode === null ? {document, code: null} : {document: null, code: malformedCode};
  } catch {
    return {document: null, code: malformedCode};
  }
}

function validAt(document, evaluatedAt) {
  const evaluated = Date.parse(evaluatedAt);
  const observed = Date.parse(document?.observed_at);
  const expires = Date.parse(document?.expires_at);
  return Number.isFinite(evaluated) && Number.isFinite(observed) && Number.isFinite(expires) &&
    observed <= evaluated && evaluated < expires;
}

function proofStatusCode(kind, variant, document, evaluatedAt) {
  if (variant === 'current' && document?.status === 'current') {
    return validAt(document, evaluatedAt) ? null : `codex.${proofCodePrefixes[kind]}_stale`;
  }
  const status = variant === 'current' ? document?.status ?? 'missing' : variant;
  return `codex.${proofCodePrefixes[kind]}_${status}`;
}

async function parseScenarioBindings(document, packageRoot) {
  const [boundary, authentication, capability, network] = await Promise.all([
    parseBound(document.boundary_json, document.boundary_sha256, 'contracts/schemas/codex-adapter-boundary.schema.json', 'codex.boundary_missing', 'codex.boundary_digest_mismatch', 'codex.boundary_malformed', packageRoot),
    parseBound(document.authentication_json, document.authentication_sha256, 'contracts/schemas/codex-authentication-prerequisite.schema.json', 'codex.authentication_prerequisite_missing', 'codex.authentication_prerequisite_digest_mismatch', 'codex.authentication_prerequisite_malformed', packageRoot),
    parseBound(document.capability_json, document.capability_sha256, 'contracts/schemas/codex-capability-proof.schema.json', 'codex.capability_proof_missing', 'codex.capability_proof_digest_mismatch', 'codex.capability_proof_malformed', packageRoot),
    parseBound(document.network_json, document.network_sha256, 'contracts/schemas/codex-network-proof.schema.json', 'codex.network_proof_missing', 'codex.network_proof_digest_mismatch', 'codex.network_proof_malformed', packageRoot),
  ]);
  return {boundary, authentication, capability, network};
}

async function envelopeCode(document, boundary, packageRoot) {
  if (codexSha256(document.processing_envelope_json) !== document.processing_envelope_sha256) return 'codex.processing_envelope_digest_mismatch';
  let envelope;
  try {
    envelope = JSON.parse(document.processing_envelope_json);
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/processing-envelope.schema.json', envelope));
    if (code !== null) return 'codex.processing_envelope_malformed';
  } catch {
    return 'codex.processing_envelope_malformed';
  }
  const bytes = Buffer.from(document.payload_base64, 'base64');
  if (bytes.length !== document.payload_bytes || codexSha256(bytes) !== document.payload_sha256) return 'codex.payload_digest_mismatch';
  const segment = envelope.payload_segments?.[0];
  if (segment?.utf8 !== bytes.toString('utf8') || segment?.byte_length !== bytes.length || segment?.sha256 !== codexSha256(bytes)) return 'codex.unapproved_payload';
  if (envelope.bindings?.policy?.sha256 !== policyDigest) return 'codex.stale_processing_envelope';
  if (envelope.destination?.endpoint !== approvedDestination || document.requested_destination !== approvedDestination) return 'codex.unapproved_destination';
  if (boundary.processing_envelope_sha256 !== document.processing_envelope_sha256 || boundary.payload_sha256 !== document.payload_sha256 || boundary.payload_bytes !== document.payload_bytes) return 'codex.boundary_binding_mismatch';
  return null;
}

function boundaryBindingCode(document, bindings) {
  const boundary = bindings.boundary.document;
  if (document.interface_mode !== 'non_interactive') return 'codex.interactive_only_execution';
  if (bindings.boundary.code !== null) return bindings.boundary.code;
  if (boundary.status !== 'current') return `codex.boundary_${boundary.status}`;
  if (!validAt(boundary, document.evaluated_at)) return 'codex.boundary_stale';
  for (const [kind, result, variant, digestField] of [
    ['authentication', bindings.authentication, document.authentication_variant, 'authentication_prerequisite_sha256'],
    ['capability', bindings.capability, document.capability_variant, 'capability_proof_sha256'],
    ['network', bindings.network, document.network_variant, 'network_proof_sha256'],
  ]) {
    if (result.code !== null) return result.code;
    const statusCode = proofStatusCode(kind, variant, result.document, document.evaluated_at);
    if (statusCode !== null) return statusCode;
    if (boundary[digestField] !== document[`${kind === 'authentication' ? 'authentication' : kind}_sha256`]) return `codex.${proofCodePrefixes[kind]}_binding_mismatch`;
  }
  if (bindings.authentication.document.satisfied !== true || bindings.authentication.document.claims_established.length !== 0) return 'codex.authentication_prerequisite_failed';
  if (bindings.capability.document.proof_result !== 'exact') return 'codex.capability_proof_inconclusive';
  if (bindings.network.document.proof_result !== 'exact' || bindings.network.document.allowed_destination !== approvedDestination ||
      !isDeepStrictEqual(bindings.network.document.observed_payload_destinations, [approvedDestination])) return 'codex.network_proof_inconclusive';
  if (boundary.isolation.fresh_process !== true || boundary.isolation.scratch_only !== true || boundary.isolation.vault_visible !== false || boundary.isolation.tools.length !== 0) return 'codex.isolation_unavailable';
  return null;
}

function resourceCode(document) {
  const checks = [
    ['payload_bytes', 'input_bytes', 'input_limit_exceeded'], ['jsonl_bytes', 'jsonl_bytes', 'jsonl_limit_exceeded'],
    ['output_bytes', 'output_bytes', 'output_limit_exceeded'], ['runtime_ms', 'runtime_ms', 'runtime_limit_exceeded'],
    ['tokens', 'tokens', 'token_limit_exceeded'], ['cost_microunits', 'cost_microunits', 'cost_limit_exceeded'],
  ];
  return checks.find(([observed, ceiling]) => document[observed] > document.ceilings[ceiling])?.[2] ?? null;
}

async function proposalCode(document, packageRoot) {
  const explicit = outputCodes.get(document.output_kind);
  if (explicit !== undefined) return explicit;
  if (document.claimed_authority !== 'none') return authorityCodes.get(document.claimed_authority) ?? 'codex.authority_request_denied';
  if (document.claimed_auth_fact !== null) return `codex.authentication_does_not_prove_${document.claimed_auth_fact}`;
  if (document.raw_output === null) return 'codex.malformed_output';
  try {
    const proposal = JSON.parse(document.raw_output);
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/codex-adapter-proposal.schema.json', proposal));
    if (schemaCode !== null) return 'codex.malformed_output';
    const digestInput = canonicalJson({...proposal, raw_output_sha256: '0'.repeat(64)});
    if (proposal.raw_output_sha256 !== codexSha256(digestInput) || proposal.processing_envelope_sha256 !== document.processing_envelope_sha256 ||
        proposal.advisory_only !== true || proposal.tool_requests.length !== 0 || proposal.semantic_effects.length !== 0 || proposal.filesystem_effects.length !== 0 ||
        Object.values(proposal.authority).some((value) => value !== 'none')) return 'codex.proposal_validation_failed';
    return null;
  } catch {
    return 'codex.malformed_output';
  }
}

function receiptDigest(receipt) {
  return codexSha256(canonicalJson({...receipt, receipt_sha256: '0'.repeat(64)}));
}

export function codexAdapterReceiptDigest(receipt) {
  return receiptDigest(receipt);
}

function denialFor(document, code, transmittedBytes, transmittedSha256, destination, boundary) {
  return {
    schema_id: 'mdplace.codex-adapter-denial/v1', denial_id: `codex-denial:${document.scenario_id.toLowerCase()}`,
    profile_id: 'codex-adapter', scenario_id: document.scenario_id, code, boundary,
    transmitted_bytes: transmittedBytes, transmitted_sha256: transmittedSha256, destination,
    semantic_effects: [], filesystem_effects: [], tool_invocations: [],
  };
}

function receiptFor(document, code, preTransmission, outcome) {
  const transmittedBytes = preTransmission || document.operation === 'recover' ? 0 : document.payload_bytes;
  const transmittedSha256 = transmittedBytes === 0 ? emptyDigest : document.payload_sha256;
  const destination = transmittedBytes === 0 ? null : document.requested_destination;
  const denial = code === null ? null : denialFor(
    document, code, transmittedBytes, transmittedSha256, destination,
    outcome === 'recovery_required' || document.operation === 'recover' ? 'recovery' : preTransmission ? 'pre_transmission' : 'post_response_validation',
  );
  const accepted = code === null && outcome === 'accepted';
  const receipt = {
    schema_id: 'mdplace.codex-adapter-receipt/v1', receipt_id: `codex-receipt:${document.scenario_id.toLowerCase()}`,
    profile_id: 'codex-adapter', scenario_id: document.scenario_id, outcome,
    boundary_sha256: document.boundary_sha256, authentication_prerequisite_sha256: document.authentication_sha256,
    capability_proof_sha256: document.capability_sha256, network_proof_sha256: document.network_sha256,
    processing_envelope_sha256: document.processing_envelope_sha256, destination, transmitted_bytes: transmittedBytes,
    transmitted_sha256: transmittedSha256, output_sha256: typeof document.raw_output === 'string' ? codexSha256(document.raw_output) : null,
    proposal_id: accepted ? `codex-proposal:${document.scenario_id.toLowerCase()}` : null, denial,
    tool_events_observed: ['tool_request', 'command_request'].includes(document.output_kind) ? 1 : 0,
    semantic_effects: [], filesystem_effects: [], authority_effects: [], tool_invocations: [], receipt_sha256: '0'.repeat(64),
  };
  receipt.receipt_sha256 = receiptDigest(receipt);
  return receipt;
}

async function evaluationCode(document, packageRoot, recoveryRecord) {
  if (document.operation === 'transition' || document.transition_ref !== null) return {code: 'codex.illegal_transition', preTransmission: true};
  if (document.payload_bytes > document.ceilings.input_bytes) return {code: 'codex.input_limit_exceeded', preTransmission: true};
  const bindings = await parseScenarioBindings(document, packageRoot);
  let code = boundaryBindingCode(document, bindings);
  let preTransmission = code !== null;
  if (code === null) code = await envelopeCode(document, bindings.boundary.document, packageRoot);
  if (code !== null) preTransmission = true;
  if (code === null && document.behavior === 'isolation_unavailable') { code = 'codex.isolation_unavailable'; preTransmission = true; }
  if (code === null && document.behavior === 'unsupported_fallback') { code = 'codex.unapproved_fallback'; preTransmission = true; }
  if (code === null && document.behavior === 'unapproved_payload') { code = 'codex.unapproved_payload'; preTransmission = true; }
  if (code === null && document.claimed_auth_fact !== null) code = `codex.authentication_does_not_prove_${document.claimed_auth_fact}`;
  if (code === null) {
    const limit = resourceCode(document);
    if (limit !== null) code = `codex.${limit}`;
  }
  if (code === null && document.behavior === 'crash_before_transmission') { code = 'codex.crash_before_transmission'; preTransmission = true; }
  if (code === null && document.transmitted_bytes !== document.payload_bytes) code = 'codex.transmitted_bytes_mismatch';
  if (code === null && document.transmitted_sha256 !== document.payload_sha256) code = 'codex.transmitted_digest_mismatch';
  if (code === null && document.behavior === 'crash_after_transmission') code = 'codex.crash_after_transmission';
  if (document.operation === 'recover') {
    const current = document.behavior === 'recover_current' && recoveryRecord !== null &&
      recoveryRecord.boundary_revalidated && recoveryRecord.capability_revalidated && recoveryRecord.network_revalidated &&
      recoveryRecord.authentication_revalidated && recoveryRecord.processing_envelope_revalidated;
    return {code: current ? null : 'codex.recovery_binding_stale', preTransmission: true};
  }
  if (code === null) code = await proposalCode(document, packageRoot);
  return {code, preTransmission};
}

export async function observeCodexAdapterScenario(subject, packageRoot, recoveryRecord = null) {
  const document = subject.document;
  const {code, preTransmission} = await evaluationCode(document, packageRoot, recoveryRecord);
  let outcome = code === null ? 'accepted' : preTransmission ? 'denied' : 'rejected';
  if (document.behavior === 'crash_before_transmission' || document.behavior === 'crash_after_transmission') outcome = 'recovery_required';
  if (document.operation === 'recover') outcome = code === null ? 'recovered' : 'recovery_required';
  const receipt = receiptFor(document, code, preTransmission, outcome);
  const operations = ['prove documented non-interactive Codex boundary', 'prove opaque authentication prerequisite', 'prove exact effective capabilities', 'prove exact network boundary', 'bind approved Processing Envelope'];
  if (!preTransmission && document.operation === 'execute') operations.push('observe exact transmitted bytes');
  if (document.raw_output !== null && !preTransmission) operations.push('validate inert Codex proposal bytes');
  return {
    verdict: code === null ? 'pass' : 'fail', codes: code === null ? [] : [code],
    inputs: [`boundary:${document.boundary_sha256 ?? 'missing'}`, `payload:${document.payload_sha256}`, `destination:${document.requested_destination}`],
    outputs: [code === null ? (outcome === 'recovered' ? 'Codex recovery accepted' : 'schema-valid Codex proposal remains advice') : 'Codex attempt denied or rejected'],
    operations, receipts: [canonicalJson(receipt)], filesystem_effects: ['none'],
    network_effects: [receipt.transmitted_bytes === 0 ? 'none' : `transmitted ${receipt.transmitted_bytes} exact bytes to ${receipt.destination}`],
    observations: ['semantic_effects=0', 'filesystem_effects=0', 'tool_invocations=0'],
    terminal_state: outcome, illegal_transition: code === 'codex.illegal_transition',
  };
}

export async function codexAdapterRecoveryRecord(fixtureId, packageRoot) {
  const read = await readPackageFile(packageRoot, 'conformance/evidence/codex-adapter-recovery-report.json');
  if (read.status !== 'present') return null;
  try {
    const report = JSON.parse(read.content.toString('utf8'));
    return report.cases.find(({fixture_id: id}) => id === fixtureId) ?? null;
  } catch {
    return null;
  }
}

export function codexReceiptMatchesScenario(receipt, document) {
  return receipt.scenario_id === document.scenario_id && receipt.processing_envelope_sha256 === document.processing_envelope_sha256 &&
    receipt.semantic_effects.length === 0 && receipt.filesystem_effects.length === 0 && receipt.tool_invocations.length === 0 &&
    receipt.receipt_sha256 === receiptDigest(receipt) &&
    (receipt.transmitted_bytes === 0 || isDeepStrictEqual(
      [receipt.transmitted_bytes, receipt.transmitted_sha256, receipt.destination],
      [document.payload_bytes, document.payload_sha256, document.requested_destination],
    ));
}
