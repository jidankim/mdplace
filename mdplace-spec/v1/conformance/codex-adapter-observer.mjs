import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {validateProposal} from './intelligence-adapter-validation.mjs';
import {canonicalBase64Bytes} from './canonical-base64.mjs';
import {
  codexReceiptArtifacts,
  codexSha256,
} from './codex-adapter-core.mjs';
import {
  codexApprovedEnvelopeCodes,
  codexHighestPrecedenceCode,
  codexObservationIsolationCodes,
  codexObservationTimingCode,
  codexRecoveryTarget,
  codexResourceCodes,
} from './codex-adapter-validation.mjs';
import {readPackageFile} from './safe-path.mjs';
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
async function invocationContractCode(boundary, packageRoot) {
  const invocationPath = 'contracts/codex-intelligence-adapter/invocation-contract.json';
  const outputSchemaPath = 'contracts/schemas/codex-adapter-proposal.schema.json';
  const invocationRead = await readPackageFile(packageRoot, invocationPath);
  if (invocationRead.status !== 'present') return 'codex.invocation_contract_missing';
  if (codexSha256(invocationRead.content) !== boundary.invocation_contract_sha256) {
    return 'codex.invocation_contract_digest_mismatch';
  }
  let invocation;
  try {
    invocation = JSON.parse(invocationRead.content.toString('utf8'));
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/codex-invocation-contract.schema.json',
      invocation,
    ));
    if (schemaCode !== null) return 'codex.invocation_contract_malformed';
  } catch {
    return 'codex.invocation_contract_malformed';
  }
  const outputRead = await readPackageFile(packageRoot, outputSchemaPath);
  if (outputRead.status !== 'present') return 'codex.invocation_contract_missing';
  const outputSha256 = codexSha256(outputRead.content);
  return boundary.interface.invocation_contract_ref === invocationPath &&
    boundary.interface.output_schema_ref === outputSchemaPath && invocation.output.schema_ref === outputSchemaPath &&
    invocation.output.schema_sha256 === outputSha256 && boundary.output_schema_sha256 === outputSha256
    ? null
    : 'codex.invocation_contract_binding_mismatch';
}
async function envelopeCodes(document, boundary, packageRoot) {
  if (codexSha256(document.processing_envelope_json) !== document.processing_envelope_sha256) return ['codex.processing_envelope_digest_mismatch'];
  let envelope;
  try {
    envelope = JSON.parse(document.processing_envelope_json);
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/processing-envelope.schema.json', envelope));
    if (code !== null) return ['codex.processing_envelope_malformed'];
  } catch {
    return ['codex.processing_envelope_malformed'];
  }
  const codes = [];
  const bytes = canonicalBase64Bytes(document.payload_base64);
  if (bytes === null) return ['codex.payload_digest_mismatch'];
  if (bytes.length !== document.payload_bytes || codexSha256(bytes) !== document.payload_sha256) codes.push('codex.payload_digest_mismatch');
  const fields = envelope.transmitted_fields ?? [];
  const segments = envelope.payload_segments ?? [];
  if (!isDeepStrictEqual(fields.map(({field_id: id}) => id), boundary.transmitted_fields) ||
      fields.length !== segments.length || segments.length !== 1) codes.push('codex.unapproved_payload');
  if (fields.length === 1 && segments.length === 1) {
    const segment = segments[0];
    const field = fields[0];
    if (field.segment_id !== segment.segment_id || field.field_id !== segment.field_id ||
        segment.utf8 !== bytes.toString('utf8') || segment.byte_length !== bytes.length ||
        segment.sha256 !== codexSha256(bytes)) codes.push('codex.unapproved_payload');
  }
  if (envelope.bindings?.policy?.sha256 !== policyDigest) codes.push('codex.stale_processing_envelope');
  if (envelope.destination?.endpoint !== approvedDestination || document.requested_destination !== approvedDestination) codes.push('codex.unapproved_destination');
  if (boundary.processing_envelope_sha256 !== document.processing_envelope_sha256 || boundary.payload_sha256 !== document.payload_sha256 || boundary.payload_bytes !== document.payload_bytes) codes.push('codex.boundary_binding_mismatch');
  codes.push(...await codexApprovedEnvelopeCodes(
    document, envelope, bytes.toString('utf8'), packageRoot, boundary.approved_processing_envelope_sha256,
  ));
  return codes;
}
function boundaryBindingCodes(document, bindings) {
  const codes = [];
  const boundary = bindings.boundary.document;
  if (document.interface_mode !== 'non_interactive') codes.push('codex.interactive_only_execution');
  if (bindings.boundary.code !== null) codes.push(bindings.boundary.code);
  if (boundary !== null && boundary.status !== 'current') codes.push(`codex.boundary_${boundary.status}`);
  if (boundary !== null && !validAt(boundary, document.evaluated_at)) codes.push('codex.boundary_stale');
  for (const [kind, result, variant, digestField] of [
    ['authentication', bindings.authentication, document.authentication_variant, 'authentication_prerequisite_sha256'],
    ['capability', bindings.capability, document.capability_variant, 'capability_proof_sha256'],
    ['network', bindings.network, document.network_variant, 'network_proof_sha256'],
  ]) {
    if (result.code !== null) {
      codes.push(result.code);
      continue;
    }
    const statusCode = proofStatusCode(kind, variant, result.document, document.evaluated_at);
    if (statusCode !== null) codes.push(statusCode);
    if (boundary !== null && boundary[digestField] !== document[`${kind === 'authentication' ? 'authentication' : kind}_sha256`]) {
      codes.push(`codex.${proofCodePrefixes[kind]}_binding_mismatch`);
    }
  }
  if (bindings.authentication.document !== null &&
      (bindings.authentication.document.satisfied !== true || bindings.authentication.document.claims_established.length !== 0)) {
    codes.push('codex.authentication_prerequisite_failed');
  }
  if (bindings.capability.document !== null && bindings.capability.document.proof_result !== 'exact') {
    codes.push('codex.capability_proof_inconclusive');
  }
  if (bindings.network.document !== null &&
      (bindings.network.document.proof_result !== 'exact' || bindings.network.document.allowed_destination !== approvedDestination ||
       !isDeepStrictEqual(bindings.network.document.observed_payload_destinations, [approvedDestination]))) {
    codes.push('codex.network_proof_inconclusive');
  }
  if (boundary !== null &&
      (boundary.isolation.fresh_process !== true || boundary.isolation.scratch_only !== true ||
       boundary.isolation.vault_visible !== false || boundary.isolation.tools.length !== 0)) {
    codes.push('codex.isolation_unavailable');
  }
  return codes;
}
async function proposalCode(document, packageRoot) {
  const explicit = outputCodes.get(document.output_kind);
  if (explicit !== undefined) return explicit;
  if (document.raw_output === null) return 'codex.malformed_output';
  try {
    const envelope = JSON.parse(document.processing_envelope_json);
    const validation = await validateProposal(document.raw_output, envelope, packageRoot);
    if (validation.code === 'adapter.proposal_binding_denied') return 'codex.proposal_validation_failed';
    if (validation.code !== null) return 'codex.malformed_output';
    const profileSchemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/codex-adapter-proposal.schema.json',
      validation.proposal,
    ));
    return profileSchemaCode === null ? null : 'codex.malformed_output';
  } catch {
    return 'codex.malformed_output';
  }
}
async function evaluationCode(document, packageRoot, recoveryRecord) {
  const timingCode = codexObservationTimingCode(document);
  if (document.operation === 'transition' || document.transition_ref !== null) {
    const exactZero = document.transmitted_bytes === 0 && document.transmitted_sha256 === codexSha256(Buffer.alloc(0)) && document.attempt_observation.provider_request_id === null;
    return {code: exactZero ? 'codex.illegal_transition' : document.transmitted_bytes > 0 ? 'codex.transmitted_before_authorization' : 'codex.output_measurement_mismatch', preTransmission: exactZero};
  }
  const bindings = await parseScenarioBindings(document, packageRoot);
  const preflightCodes = boundaryBindingCodes(document, bindings);
  if (bindings.boundary.document !== null) {
    const invocationCode = await invocationContractCode(bindings.boundary.document, packageRoot);
    if (invocationCode !== null) preflightCodes.push(invocationCode);
  }
  if (document.payload_bytes > document.ceilings.input_bytes) preflightCodes.push('codex.input_limit_exceeded');
  if (bindings.boundary.document !== null) {
    preflightCodes.push(...await envelopeCodes(document, bindings.boundary.document, packageRoot));
  }
  try {
    preflightCodes.push(...codexObservationIsolationCodes(document));
  } catch {
    // A malformed envelope is already a closed preflight failure; do not infer unavailable isolation.
  }
  if (document.behavior === 'unsupported_fallback') preflightCodes.push('codex.unapproved_fallback');
  if (document.operation === 'recover' && (document.transmitted_bytes !== 0 ||
      document.transmitted_sha256 !== codexSha256(Buffer.alloc(0)) || document.attempt_observation.provider_request_id !== null)) {
    preflightCodes.push('codex.recovery_retransmission_denied');
  }
  if (preflightCodes.length > 0 && document.transmitted_bytes !== 0) {
    preflightCodes.push('codex.transmitted_before_authorization');
  }
  if (preflightCodes.length > 0 && document.transmitted_bytes === 0 &&
      document.transmitted_sha256 !== codexSha256(Buffer.alloc(0))) {
    preflightCodes.push('codex.transmitted_digest_mismatch');
  }
  const preflightCode = codexHighestPrecedenceCode([...preflightCodes, timingCode]);
  if (preflightCode !== null) return {code: preflightCode, preTransmission: document.transmitted_bytes === 0};
  if (document.operation === 'recover') {
    const recovery = await codexRecoveryTarget(document, recoveryRecord, packageRoot, observeCodexAdapterScenario);
    const code = codexHighestPrecedenceCode([timingCode, recovery.code]);
    return {code, preTransmission: true, recoveredReceipt: code === null ? recovery.receipt : null};
  }
  const postflightCodes = [...codexResourceCodes(document), timingCode];
  if (document.claimed_authority !== 'none') {
    postflightCodes.push(authorityCodes.get(document.claimed_authority) ?? 'codex.authority_request_denied');
  }
  if (document.claimed_auth_fact !== null) postflightCodes.push(`codex.authentication_does_not_prove_${document.claimed_auth_fact}`);
  if (document.behavior === 'crash_before_transmission') {
    const crashObservationMatches = document.transmitted_bytes === 0 &&
      document.transmitted_sha256 === codexSha256(Buffer.alloc(0)) && document.attempt_observation.provider_request_id === null;
    postflightCodes.push(crashObservationMatches ? 'codex.crash_before_transmission' : 'codex.output_measurement_mismatch');
  } else {
    if (document.transmitted_bytes !== document.payload_bytes) postflightCodes.push('codex.transmitted_bytes_mismatch');
    if (document.transmitted_sha256 !== document.payload_sha256) postflightCodes.push('codex.transmitted_digest_mismatch');
  }
  if (document.behavior === 'crash_after_transmission') postflightCodes.push('codex.crash_after_transmission');
  if (!document.behavior.startsWith('crash_')) postflightCodes.push(await proposalCode(document, packageRoot));
  const code = codexHighestPrecedenceCode(postflightCodes);
  return {code, preTransmission: code === 'codex.crash_before_transmission' && document.transmitted_bytes === 0};
}
export async function observeCodexAdapterScenario(subject, packageRoot, recoveryRecord = null) {
  const document = subject.document;
  const {code, preTransmission, recoveredReceipt = null} = await evaluationCode(document, packageRoot, recoveryRecord);
  let outcome = code === null ? 'accepted' : preTransmission ? 'denied' : 'rejected';
  if (code === 'codex.crash_before_transmission' || code === 'codex.crash_after_transmission') outcome = 'recovery_required';
  if (document.operation === 'recover') outcome = code === null ? 'recovered' : 'recovery_required';
  const {receipt, denial} = recoveredReceipt === null
    ? codexReceiptArtifacts(document, code, preTransmission, codexObservationTimingCode(document) === null)
    : {receipt: recoveredReceipt, denial: null};
  const operations = ['prove documented non-interactive Codex boundary', 'prove opaque authentication prerequisite', 'prove exact effective capabilities', 'prove exact network boundary', 'bind approved Processing Envelope'];
  if (!preTransmission && document.operation === 'execute') operations.push('observe exact transmitted bytes');
  if (document.raw_output !== null && !preTransmission) operations.push('validate inert Codex proposal bytes');
  const observedTransmittedBytes = receipt?.transmitted_bytes ?? denial?.transmitted_bytes ?? 0;
  const observedDestination = receipt?.observed_destination ?? denial?.destination ?? null;
  const newlyTransmittedBytes = recoveredReceipt === null ? observedTransmittedBytes : 0;
  return {
    verdict: code === null ? 'pass' : 'fail', codes: code === null ? [] : [code],
    inputs: [`boundary:${document.boundary_sha256 ?? 'missing'}`, `payload:${document.payload_sha256}`, `destination:${document.requested_destination}`],
    outputs: [code === null ? (outcome === 'recovered' ? 'Codex recovery accepted' : 'schema-valid Codex proposal remains advice') : 'Codex attempt denied or rejected'],
    operations, receipts: receipt === null ? [] : [canonicalJson(receipt)], filesystem_effects: ['none'],
    network_effects: [newlyTransmittedBytes === 0
      ? 'none'
      : `transmitted ${newlyTransmittedBytes} exact bytes to ${observedDestination}`],
    observations: ['semantic_effects=0', 'filesystem_effects=0', 'tool_invocations=0', ...(denial === null ? [] : [canonicalJson(denial)])],
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
