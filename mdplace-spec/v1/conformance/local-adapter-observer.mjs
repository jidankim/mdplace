import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  localAdapterAttemptObservation,
  localAdapterEvidenceStatus,
  localAdapterRecoveryCode,
} from './local-adapter-evidence-validation.mjs';
import {adapterReceiptDigest, createAdapterReceipt, sha256} from './intelligence-adapter-core.mjs';
import {preflightCode, validateProposal} from './intelligence-adapter-validation.mjs';
import {readPackageFile} from './safe-path.mjs';

const authorityCodes = new Map([
  ['semantic', 'local.semantic_authority_denied'], ['note_placement', 'local.note_placement_authority_denied'],
  ['taxonomy', 'local.taxonomy_authority_denied'], ['projection', 'local.projection_authority_denied'],
  ['filesystem', 'local.filesystem_authority_denied'], ['network', 'local.network_authority_denied'],
  ['tool', 'local.tool_authority_denied'], ['automation', 'local.automation_authority_denied'],
]);
const instructionCodes = new Map([
  ['embedded_tool', 'local.tool_request_denied'], ['secret_request', 'local.secret_request_denied'],
  ['ambient_configuration', 'local.ambient_configuration_denied'],
]);
const behaviorCodes = new Map([
  ['interrupt', 'local.interrupted'], ['cancelled', 'local.cancelled'],
  ['repeated_interruption', 'local.repeated_interruption'], ['hung', 'local.execution_hung'],
  ['flaky', 'local.execution_flaky'], ['misleading_success', 'local.misleading_success_denied'],
  ['crash_before_receipt', 'local.crash_before_receipt'], ['crash_after_receipt', 'local.crash_after_receipt'],
]);

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

async function parseEnvelope(document, packageRoot, attemptObservation) {
  if (sha256(document.processing_envelope_json) !== document.processing_envelope_sha256) {
    return {envelope: null, code: 'local.processing_envelope_digest_mismatch'};
  }
  let envelope;
  try {
    envelope = JSON.parse(document.processing_envelope_json);
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/processing-envelope.schema.json',
      envelope,
    ));
    if (schemaCode !== null) return {envelope: null, code: 'local.processing_envelope_malformed'};
  } catch {
    return {envelope: null, code: 'local.processing_envelope_malformed'};
  }
  const context = await readJson(packageRoot, 'contracts/intelligence-adapter/approved-context.json');
  if (context === null) return {envelope, code: 'local.policy_binding_missing'};
  if (attemptObservation === null) return {envelope, code: null};
  const attemptClass = context.attempt_authorizations.find(({authorization_id: id}) =>
    id === envelope.authorization_id)?.attempt_class ?? 'primary';
  const adapterCode = preflightCode({
    attempt_class: attemptClass,
    envelope,
    isolation: attemptObservation.isolation,
  }, context);
  if (adapterCode === null) return {envelope, code: null};
  if (adapterCode === 'adapter.input_budget_exhausted') return {envelope, code: 'local.input_budget_exhausted'};
  if (adapterCode === 'adapter.isolation_failed') return {envelope, code: 'local.isolation_observation_failed'};
  if (adapterCode === 'adapter.canary_failed') return {envelope, code: 'local.isolation_canary_failed'};
  return {envelope, code: adapterCode === 'adapter.policy_binding_denied'
    ? 'local.policy_binding_stale'
    : 'local.processing_envelope_denied'};
}

async function evidenceStatuses(document, packageRoot) {
  const profile = await readPackageFile(packageRoot, 'contracts/local-intelligence-adapter/profile.json');
  const profileSha256 = profile.status === 'present' ? sha256(profile.content) : '0'.repeat(64);
  const common = {evaluatedAt: document.evaluated_at, profileSha256, packageRoot};
  const [capability, isolation] = await Promise.all([
    localAdapterEvidenceStatus({raw: document.capability_evidence_json, digest: document.capability_evidence_sha256, schemaPath: 'contracts/schemas/local-adapter-capability-evidence.schema.json', ...common}),
    localAdapterEvidenceStatus({raw: document.isolation_evidence_json, digest: document.isolation_evidence_sha256, schemaPath: 'contracts/schemas/local-adapter-isolation-evidence.schema.json', ...common}),
  ]);
  return {capability, isolation};
}

async function proposalResult(document, envelope, packageRoot) {
  if (typeof document.raw_output !== 'string') return {code: 'local.malformed_output', proposal: null};
  const validated = await validateProposal(document.raw_output, envelope, packageRoot);
  if (validated.code === null) return {code: null, proposal: validated.proposal};
  return {
    code: validated.code === 'adapter.proposal_binding_denied'
      ? 'local.proposal_binding_denied'
      : 'local.malformed_output',
    proposal: null,
  };
}

async function evaluate(document, packageRoot, recoveryBindings) {
  const [observationResult, statuses] = await Promise.all([
    localAdapterAttemptObservation(document, packageRoot),
    evidenceStatuses(document, packageRoot),
  ]);
  const {envelope, code: envelopeCode} = await parseEnvelope(document, packageRoot, observationResult.document);
  let code = document.transition_ref !== null || document.operation === 'transition'
    ? 'local.illegal_transition'
    : envelopeCode;
  if (code === null) code = observationResult.code;
  if (code === null && statuses.capability !== 'current') code = `local.capability_fact_${statuses.capability}`;
  if (code === null && statuses.isolation !== 'current') code = `local.isolation_fact_${statuses.isolation}`;
  if (code === null) code = instructionCodes.get(document.instruction_kind) ?? null;
  if (code === null) code = authorityCodes.get(document.claimed_authority) ?? null;
  const inputBytes = Buffer.byteLength(document.processing_envelope_json);
  const outputBytes = typeof document.raw_output === 'string' ? Buffer.byteLength(document.raw_output) : 0;
  const observedRuntime = observationResult.document === null
    ? null
    : Date.parse(observationResult.document.observed_completed_at) -
      Date.parse(observationResult.document.observed_started_at);
  if (code === null && document.output_bytes !== outputBytes) code = 'local.measurement_mismatch';
  if (code === null && observedRuntime !== document.runtime_ms) code = 'local.measurement_mismatch';
  if (code === null && inputBytes > document.ceilings.input_bytes) code = 'local.input_budget_exhausted';
  if (code === null && outputBytes > document.ceilings.output_bytes) code = 'local.output_budget_exhausted';
  if (code === null && document.runtime_ms > document.ceilings.runtime_ms) code = 'local.runtime_budget_exhausted';
  if (code === null && document.attempts > document.ceilings.attempts) code = 'local.attempt_budget_exhausted';
  if (code === null) code = behaviorCodes.get(document.behavior) ?? null;
  if (code === null && document.behavior === 'malformed_output') code = 'local.malformed_output';
  if (code === null && document.operation === 'recover') {
    code = await localAdapterRecoveryCode(recoveryBindings, packageRoot);
  }
  const proposal = code === null && document.operation !== 'transition'
    ? await proposalResult(document, envelope, packageRoot)
    : {code: null, proposal: null};
  return {
    code: code ?? proposal.code,
    proposal: proposal.proposal,
    envelope,
    statuses,
    observation: observationResult.document,
    inputBytes,
    outputBytes,
  };
}

function receiptReason(code) {
  if (code === null) return 'adapter.proposal_accepted_as_advice';
  if (code.startsWith('local.policy_') || code.startsWith('local.processing_envelope_')) return 'adapter.policy_binding_denied';
  if (code.startsWith('local.capability_')) return 'adapter.capability_denied';
  if (code === 'local.isolation_canary_failed') return 'adapter.canary_failed';
  if (code.startsWith('local.isolation_')) return 'adapter.isolation_failed';
  if (code === 'local.tool_request_denied' || code === 'local.tool_authority_denied') return 'adapter.tool_request_denied';
  if (code === 'local.secret_request_denied') return 'adapter.secret_request_denied';
  if (code === 'local.ambient_configuration_denied') return 'adapter.ambient_config_denied';
  if (code === 'local.filesystem_authority_denied') return 'adapter.filesystem_authority_denied';
  if (code === 'local.note_placement_authority_denied') return 'adapter.placement_authority_denied';
  if (code === 'local.network_authority_denied') return 'adapter.destination_denied';
  if (code.endsWith('authority_denied')) return 'adapter.semantic_authority_denied';
  if (code === 'local.input_budget_exhausted') return 'adapter.input_budget_exhausted';
  if (code === 'local.output_budget_exhausted') return 'adapter.output_budget_exhausted';
  if (code === 'local.runtime_budget_exhausted' || code === 'local.execution_hung') return 'adapter.timeout';
  if (code === 'local.attempt_budget_exhausted' || code === 'local.execution_flaky' || code === 'local.cancelled') return 'adapter.retry_exhausted';
  if (code === 'local.illegal_transition') return 'adapter.illegal_transition';
  if (code.startsWith('local.recovery_') || code.startsWith('local.crash_') || code.includes('interrupted')) return 'adapter.recovery_unknown_completion';
  return 'adapter.malformed_output';
}

function receiptOutcome(reason) {
  if (reason === 'adapter.proposal_accepted_as_advice') return 'accepted';
  if (reason === 'adapter.timeout') return 'timeout';
  if (reason === 'adapter.retry_exhausted') return 'retry_exhausted';
  if (reason === 'adapter.output_budget_exhausted' || reason === 'adapter.input_budget_exhausted') return 'budget_exhausted';
  if (reason === 'adapter.isolation_failed' || reason === 'adapter.canary_failed') return 'isolation_failure';
  if (reason === 'adapter.recovery_unknown_completion') return 'recovery_required';
  if (reason === 'adapter.malformed_output') return 'malformed_output';
  return 'denied';
}

function transmissionOccurred(code, operation) {
  return operation === 'recover' || code === null || [
    'local.malformed_output', 'local.measurement_mismatch', 'local.output_budget_exhausted',
    'local.runtime_budget_exhausted', 'local.execution_hung', 'local.execution_flaky',
    'local.misleading_success_denied', 'local.interrupted', 'local.repeated_interruption',
    'local.crash_before_receipt', 'local.crash_after_receipt',
  ].includes(code);
}

function terminalState(document, code) {
  if (code === null) return document.operation === 'recover' ? 'recovered' : 'validated';
  if (code === 'local.cancelled') return 'cancelled';
  if (code === 'local.interrupted' || code === 'local.repeated_interruption') return 'interrupted';
  if (code.startsWith('local.crash_') || code.startsWith('local.recovery_')) return 'recovery_required';
  return 'denied';
}

export async function observeLocalAdapterScenario(subject, packageRoot, recoveryBindings = null) {
  const document = subject?.document ?? subject;
  const evaluated = await evaluate(document, packageRoot, recoveryBindings);
  const {code, envelope, statuses, observation} = evaluated;
  if (observation === null) {
    return {
      verdict: 'fail',
      codes: [code],
      inputs: [`envelope-sha256:${document.processing_envelope_sha256}`, `attempt-observation-sha256:${document.attempt_observation_sha256}`],
      outputs: ['Local Intelligence Adapter attempt denied'],
      operations: ['parse Local Intelligence Adapter scenario', 'validate exact Processing Envelope', 'reject malformed exact attempt observation'],
      receipts: [],
      filesystem_effects: ['none'],
      network_effects: ['none'],
      observations: [JSON.stringify({processing_envelope_sha256: document.processing_envelope_sha256, attempt_observation_sha256: document.attempt_observation_sha256, new_transmission: false})],
      terminal_state: 'denied',
      illegal_transition: false,
    };
  }
  const transmitted = envelope !== null && transmissionOccurred(code, document.operation);
  const transmission = transmitted
    ? {destination: envelope.destination.endpoint, sha256: sha256(document.processing_envelope_json), byte_length: evaluated.inputBytes}
    : null;
  const reason = receiptReason(code);
  const attempt = {
    attempt_class: document.operation === 'resume' ? 'fallback' : 'primary',
    envelope,
    isolation: observation.isolation,
    double: {observed_started_at: observation.observed_started_at, observed_completed_at: observation.observed_completed_at, provider_request_id: null},
  };
  const generatedReceipt = createAdapterReceipt({
    attempt, transmission, isolation: attempt.isolation,
    budget: {input_bytes: transmitted ? evaluated.inputBytes : 0, output_bytes: transmitted ? evaluated.outputBytes : 0, runtime_ms: document.runtime_ms, cost_microunits: 0},
    rawOutput: transmitted ? document.raw_output : null, proposal: transmitted ? evaluated.proposal : null,
    outcome: receiptOutcome(reason), reason,
  });
  const receiptWithObservedTiming = {...generatedReceipt, observed_started_at: observation.observed_started_at, observed_completed_at: observation.observed_completed_at};
  const receipt = {...receiptWithObservedTiming, receipt_sha256: adapterReceiptDigest(receiptWithObservedTiming)};
  let receiptCode = null;
  try {
    receiptCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/adapter-run-receipt.schema.json', receipt));
  } catch {
    receiptCode = 'schema.instance_missing';
  }
  const codes = [code, receiptCode === null ? null : 'local.receipt_malformed'].filter(Boolean);
  const recovery = document.operation === 'recover';
  return {
    verdict: codes.length === 0 ? 'pass' : 'fail', codes,
    inputs: [`envelope-sha256:${document.processing_envelope_sha256}`, `attempt-observation-sha256:${document.attempt_observation_sha256}`, `capability:${statuses.capability}`, `isolation:${statuses.isolation}`, `instruction:${document.instruction_kind}`, `behavior:${document.behavior}`],
    outputs: [code === null ? recovery ? 'parsed evidence and Claim Manifest revalidated' : 'schema-validated Intelligence Proposal retained as inert advice' : terminalState(document, code) === 'recovery_required' ? 'Local Intelligence Adapter recovery required' : 'Local Intelligence Adapter attempt denied'],
    operations: code === null
      ? recovery ? ['parse Local Intelligence Adapter scenario', 'validate exact Processing Envelope', 'parse capability and isolation evidence', 'recompute Claim Manifest evidence digests', 'read Conformance Verdict', 'recover Adapter Run Receipt'] : ['parse Local Intelligence Adapter scenario', 'validate exact Processing Envelope', 'parse capability and isolation evidence', 'validate Intelligence Proposal schema and bindings', 'record Adapter Run Receipt']
      : ['parse Local Intelligence Adapter scenario', 'validate exact Processing Envelope', 'parse capability and isolation evidence', 'apply default-deny precedence', 'record Adapter Run Receipt'],
    receipts: [JSON.stringify(receipt)], filesystem_effects: ['none'], network_effects: ['none'],
    observations: [JSON.stringify({processing_envelope_sha256: document.processing_envelope_sha256, attempt_observation_sha256: document.attempt_observation_sha256, transmitted_bytes: receipt.transmitted_bytes, destination: receipt.observed_destination, new_transmission: transmitted && !recovery})],
    terminal_state: terminalState(document, code), illegal_transition: code === 'local.illegal_transition',
  };
}
