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

export function adapterReceiptTiming(attempt, budget) {
  const observedStartedAt = attempt.double.observed_started_at;
  return {
    observed_started_at: observedStartedAt,
    observed_completed_at: new Date(Date.parse(observedStartedAt) + budget.runtime_ms).toISOString(),
  };
}

export function createAdapterReceipt({attempt, transmission, isolation, budget, rawOutput, proposal, outcome, reason}) {
  const envelope = attempt.envelope;
  const timing = adapterReceiptTiming(attempt, budget);
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

export function adapterEvidenceClaims(records) {
  const fixtureIdsMatching = (predicate) => records.filter(predicate).map(({fixtureId}) => fixtureId);
  const observationsByRecord = new Map(records.map((record) => [record.fixtureId, parsedObservations(record.observed)]));
  const hasReason = (record, reasons) => record.receipts.some(({reason}) => reasons.has(reason));
  const retryReasons = new Set(['adapter.retry_scheduled', 'adapter.retry_exhausted']);
  const fallbackReasons = new Set(['adapter.fallback_scheduled', 'adapter.fallback_exhausted']);
  const isolationReasons = new Set(['adapter.isolation_failed', 'adapter.canary_failed']);
  const canaryReasons = new Set(['adapter.canary_failed']);
  const exactTransmissionObserved = records.every((record) => record.receipts
    .filter(({transmitted_bytes: bytes}) => bytes > 0)
    .every((receipt) => observationsByRecord.get(record.fixtureId).some((observation) =>
      observation.exact_transmitted_sha256 === receipt.transmission_sha256 &&
      observation.exact_transmitted_bytes === receipt.transmitted_bytes &&
      observation.exact_destination === receipt.observed_destination) ||
      (record.document.operation === 'recover' && record.document.recovery.crash_point === 'after_receipt' &&
        record.document.recovery.prior_receipts.some(({receipt_sha256: digest}) => digest === receipt.receipt_sha256))));
  return {
    isolation_fixture_ids: fixtureIdsMatching((record) => hasReason(record, isolationReasons)),
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
    exact_transmission_observed: exactTransmissionObserved,
    all_outcomes_receipted: records.every((record) =>
      record.receipts.length === Math.max(1, observationsByRecord.get(record.fixtureId).length)),
  };
}
