import {createHash} from 'node:crypto';

import {canonicalJson} from './semantic-kernel-core.mjs';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}

export function adapterReceiptDigest(receipt) {
  const {receipt_sha256: _receiptSha256, ...body} = receipt;
  return canonicalDigest(body);
}

export function adapterIsolationReceipt(isolation) {
  return {
    ephemeral: isolation.ephemeral,
    fresh_process: isolation.fresh_process,
    filesystem: isolation.filesystem,
    tools: isolation.tools,
    ambient_configuration: isolation.ambient_configuration,
    credential_visibility: isolation.credential_visibility,
    network_scope: isolation.network_scope,
    canary_id: isolation.canary.canary_id,
    canary_challenge_sha256: sha256(isolation.canary.challenge),
    canary_expected_sha256: sha256(isolation.canary.expected),
    canary_observed_sha256: sha256(isolation.canary.observed),
    canary_passed: isolation.canary.passed,
  };
}

export function adapterReceiptTiming(attempt, budget, observedCompletedAt = null) {
  const observedStartedAt = attempt.double.observed_started_at;
  return {
    observed_started_at: observedStartedAt,
    observed_completed_at: observedCompletedAt ?? new Date(Date.parse(observedStartedAt) + budget.runtime_ms).toISOString(),
  };
}

export function createAdapterReceipt({attempt, transmission, isolation, budget, rawOutput, proposal, outcome, reason, observedCompletedAt = null}) {
  const envelope = attempt.envelope;
  const timing = adapterReceiptTiming(attempt, budget, observedCompletedAt);
  const body = {
    schema_id: 'mdplace.adapter-run-receipt/v1',
    receipt_id: `adapter-receipt:${envelope.attempt_id.slice('adapter-attempt:'.length)}`,
    receipt_version: '1.0.0',
    chain_id: envelope.chain_id,
    attempt_id: envelope.attempt_id,
    attempt_class: attempt.attempt_class,
    attempt_sequence: envelope.attempt_sequence,
    authorization_id: envelope.authorization_id,
    policy_binding: envelope.bindings.policy,
    source_profile_binding: envelope.bindings.source_profile,
    taxonomy_revision_binding: envelope.bindings.taxonomy_revision,
    envelope_id: envelope.envelope_id,
    envelope_sha256: canonicalDigest(envelope),
    transmission_sha256: transmission?.sha256 ?? null,
    transmitted_bytes: transmission?.byte_length ?? 0,
    observed_destination: transmission?.destination ?? null,
    effective_capabilities: isolation.effective_capabilities,
    retention_artifact_sha256s: envelope.retention_artifacts.map(sha256),
    credential_boundary_sha256: canonicalDigest(envelope.credential_boundary),
    isolation: adapterIsolationReceipt(isolation),
    budget,
    ...timing,
    provider_request_id: transmission === null ? null : attempt.double.provider_request_id,
    raw_response_sha256: rawOutput === null ? null : sha256(rawOutput),
    proposal_sha256: proposal === null ? null : canonicalDigest(proposal),
    outcome,
    reason,
    semantic_effects: [],
    filesystem_effects: [],
    tool_invocations: [],
  };
  return {...body, receipt_sha256: canonicalDigest(body)};
}

export function adapterResultDigest(result) {
  return canonicalDigest(result);
}

export function parseReceiptStrings(receipts) {
  return receipts.map((receipt) => JSON.parse(receipt));
}

function parsedObservations(observed) {
  return observed.observations.flatMap((value) => {
    try {
      return [typeof value === 'string' ? JSON.parse(value) : value];
    } catch {
      return [];
    }
  });
}

function receiptMatchesAttempt(receipt, attempt) {
  return receipt?.attempt_id === attempt?.envelope?.attempt_id &&
    receipt?.attempt_class === attempt?.attempt_class &&
    receipt?.attempt_sequence === attempt?.envelope?.attempt_sequence;
}

function isTransmissionObservation(observation) {
  return typeof observation?.exact_transmitted_sha256 === 'string' &&
    Number.isInteger(observation?.exact_transmitted_bytes) && observation.exact_transmitted_bytes > 0 &&
    typeof observation?.exact_destination === 'string';
}

function observationMatchesReceipt(observation, receipt) {
  return observation?.attempt_id === receipt?.attempt_id &&
    observation?.attempt_class === receipt?.attempt_class &&
    observation?.exact_transmitted_sha256 === receipt?.transmission_sha256 &&
    observation?.exact_transmitted_bytes === receipt?.transmitted_bytes &&
    observation?.exact_destination === receipt?.observed_destination;
}

function observationMatchesAttempt(observation, attempt) {
  const envelopeJson = canonicalJson(attempt.envelope);
  return isTransmissionObservation(observation) &&
    observation.attempt_id === attempt.envelope.attempt_id &&
    observation.attempt_class === attempt.attempt_class &&
    observation.exact_transmitted_sha256 === sha256(envelopeJson) &&
    observation.exact_transmitted_bytes === Buffer.byteLength(envelopeJson) &&
    observation.exact_destination === attempt.envelope.destination.endpoint;
}

function executeReceiptChainIsComplete(record) {
  const {attempts} = record.document;
  const {receipts} = record;
  if (receipts.length === 0 || receipts.length > attempts.length) return false;
  if (receipts.some((receipt, index) => !receiptMatchesAttempt(receipt, attempts[index])) ||
      new Set(receipts.map(({attempt_id: attemptId}) => attemptId)).size !== receipts.length ||
      new Set(receipts.map(({attempt_sequence: sequence}) => sequence)).size !== receipts.length) return false;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    const next = receipts[index + 1];
    const expectedNextClass = receipt.reason === 'adapter.retry_scheduled'
      ? 'retry'
      : receipt.reason === 'adapter.fallback_scheduled' ? 'fallback' : null;
    if ((expectedNextClass === null && next !== undefined) ||
        (expectedNextClass !== null && next?.attempt_class !== expectedNextClass)) return false;
  }
  return true;
}

function executeTransmissionObservationsAreComplete(record, observations) {
  const {attempts} = record.document;
  const {receipts} = record;
  if (observations.some((observation) => !isTransmissionObservation(observation))) return false;
  const attemptIndexes = observations.map((observation) => attempts.findIndex((attempt) =>
    observationMatchesAttempt(observation, attempt)));
  if (attemptIndexes.some((index) => index < 0) || attemptIndexes.some((index, position) =>
    position > 0 && index <= attemptIndexes[position - 1])) return false;
  const transmittedReceipts = receipts.filter(({transmitted_bytes: bytes}) => bytes > 0);
  return transmittedReceipts.every((receipt) => observations.some((observation) =>
    observationMatchesReceipt(observation, receipt)));
}

function recoveryReceiptIsComplete(record) {
  const {document, receipts} = record;
  const {recovery} = document;
  const target = document.attempts.find(({envelope}) =>
    envelope.attempt_id === recovery.target_attempt_id &&
    envelope.attempt_sequence === recovery.target_attempt_sequence);
  if (target === undefined || receipts.length !== 1 || !receiptMatchesAttempt(receipts[0], target)) return false;
  const [receipt] = receipts;
  if (recovery.crash_point === 'before_transmission') return receipt.transmitted_bytes === 0;
  if (recovery.crash_point === 'after_transmission_before_receipt') return receipt.transmitted_bytes > 0;
  if (recovery.crash_point === 'after_receipt') {
    return recovery.prior_receipts.length === 1 &&
      recovery.prior_receipts[0].receipt_sha256 === receipt.receipt_sha256;
  }
  return false;
}

function recoveryTransmissionObservationIsComplete(record, observations) {
  const {document} = record;
  const {recovery} = document;
  const target = document.attempts.find(({envelope}) =>
    envelope.attempt_id === recovery.target_attempt_id &&
    envelope.attempt_sequence === recovery.target_attempt_sequence);
  if (target === undefined || observations.length !== 1) return false;
  const [observation] = observations;
  if (recovery.crash_point === 'before_transmission') {
    return observation.attempt_id === target.envelope.attempt_id && observation.exact_transmitted_bytes === 0;
  }
  if (recovery.crash_point === 'after_transmission_before_receipt') {
    return observation.new_transmission === false && observationMatchesAttempt(observation, target);
  }
  if (recovery.crash_point === 'after_receipt') {
    return recovery.prior_receipts.length === 1 &&
      observation.receipt_id === recovery.prior_receipts[0].receipt_id && observation.new_transmission === false;
  }
  return false;
}

function illegalTransitionReceiptIsComplete(record) {
  const [attempt] = record.document.attempts;
  const [receipt] = record.receipts;
  return record.receipts.length === 1 && receiptMatchesAttempt(receipt, attempt) && receipt.transmitted_bytes === 0;
}

function illegalTransitionObservationIsComplete(record, observations) {
  const [observation] = observations;
  const illegal = record.document.illegal_transition;
  return observations.length === 1 && observation.table === illegal.table &&
    observation.from_state === illegal.from_state && observation.command === illegal.command &&
    observation.allowed === false;
}

function receiptEvidenceIsComplete(record) {
  if (record.document.operation === 'execute') return executeReceiptChainIsComplete(record);
  if (record.document.operation === 'recover') return recoveryReceiptIsComplete(record);
  if (record.document.operation === 'observe_illegal_transition') {
    return illegalTransitionReceiptIsComplete(record);
  }
  return false;
}

function transmissionEvidenceIsComplete(record, observations) {
  if (record.document.operation === 'execute') {
    return executeTransmissionObservationsAreComplete(record, observations);
  }
  if (record.document.operation === 'recover') {
    return recoveryTransmissionObservationIsComplete(record, observations);
  }
  if (record.document.operation === 'observe_illegal_transition') {
    return illegalTransitionObservationIsComplete(record, observations);
  }
  return false;
}

export function adapterEvidenceClaims(records) {
  const fixtureIdsMatching = (predicate) => records.filter(predicate).map(({fixtureId}) => fixtureId);
  const observationsByRecord = new Map(records.map((record) => [record.fixtureId, parsedObservations(record.observed)]));
  const hasReason = (record, reasons) => record.receipts.some(({reason}) => reasons.has(reason));
  const retryReasons = new Set(['adapter.retry_scheduled', 'adapter.retry_exhausted']);
  const fallbackReasons = new Set(['adapter.fallback_scheduled', 'adapter.fallback_exhausted']);
  const isolationReasons = new Set(['adapter.isolation_failed', 'adapter.canary_failed']);
  const canaryReasons = new Set(['adapter.canary_failed']);
  const completeReceiptEvidence = records.every((record) => receiptEvidenceIsComplete(record));
  const completeTransmissionEvidence = records.every((record) =>
    transmissionEvidenceIsComplete(record, observationsByRecord.get(record.fixtureId)));
  return {
    isolation_fixture_ids: fixtureIdsMatching((record) => hasReason(record, isolationReasons) ||
      observationsByRecord.get(record.fixtureId).some((observation) => observation.isolation !== undefined)),
    canary_fixture_ids: fixtureIdsMatching((record) => hasReason(record, canaryReasons) ||
      observationsByRecord.get(record.fixtureId).some((observation) => observation.isolation?.canary !== undefined)),
    instrumented_double_fixture_ids: fixtureIdsMatching((record) =>
      observationsByRecord.get(record.fixtureId).some((observation) => observation.measured_budget !== undefined)),
    retry_fixture_ids: fixtureIdsMatching((record) =>
      record.document.attempts.some(({attempt_class: attemptClass}) => attemptClass === 'retry') ||
      hasReason(record, retryReasons)),
    fallback_fixture_ids: fixtureIdsMatching((record) =>
      record.document.attempts.some(({attempt_class: attemptClass}) => attemptClass === 'fallback') ||
      hasReason(record, fallbackReasons)),
    inert_output_fixture_ids: fixtureIdsMatching((record) => record.receipts.some((receipt) =>
      receipt.raw_response_sha256 !== null || receipt.proposal_sha256 !== null)),
    zero_semantic_effect: records.every(({receipts}) =>
      receipts.every(({semantic_effects: effects}) => effects.length === 0)),
    zero_filesystem_effect: records.every(({observed, receipts}) =>
      observed.filesystem_effects.every((effect) => effect === 'none') &&
      receipts.every(({filesystem_effects: effects}) => effects.length === 0)),
    zero_tool_effect: records.every(({receipts}) =>
      receipts.every(({tool_invocations: invocations}) => invocations.length === 0)),
    exact_transmission_observed: completeTransmissionEvidence,
    all_outcomes_receipted: completeReceiptEvidence,
  };
}
