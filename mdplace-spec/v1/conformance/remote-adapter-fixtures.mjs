import {canonicalJson} from './semantic-kernel-core.mjs';
import {remoteAdapterEvidenceEvaluatedAt, remoteSha256} from './remote-adapter-core.mjs';

const approvedProvider = 'provider:remote-alpha';
const approvedDestination = 'https://api.remote-alpha.test/v1/process';
const policyDigest = '27a755ff5a6d91ce1f925c31cbc094bd25f70b54793dee4a9a4a56e8d3d07766';
const adapterBindings = {
  primary: {
    adapter_id: 'adapter:remote-alpha',
    model_id: 'model:remote-alpha',
    model_version: '2026-08-01',
  },
  fallback: {
    adapter_id: 'adapter:remote-alpha-fallback',
    model_id: 'model:remote-alpha-fallback',
    model_version: '2026-08-15',
  },
};

function boundJson(document, variant = 'current') {
  if (variant === 'missing') return {json: null, sha256: null};
  if (variant === 'malformed') return {json: '{', sha256: remoteSha256('{')};
  const copy = structuredClone(document);
  if (variant !== 'current') copy.status = variant;
  if (variant === 'failed') copy.prerequisite = 'failed';
  const json = canonicalJson(copy);
  return {json, sha256: remoteSha256(json)};
}

function envelopeFor(baseEnvelope, scenarioId, sequence, kind, targetBytes, stalePolicy) {
  const envelope = structuredClone(baseEnvelope);
  const adapter = kind === 'fallback' ? adapterBindings.fallback : adapterBindings.primary;
  const suffix = scenarioId.toLowerCase();
  envelope.envelope_id = `envelope:${suffix}-${sequence}`;
  envelope.chain_id = `adapter-chain:${suffix}`;
  envelope.attempt_id = `adapter-attempt:${suffix}-${sequence}`;
  envelope.attempt_sequence = sequence;
  envelope.authorization_id = `adapter-authorization:remote-${kind === 'initial' ? 'primary' : kind}`;
  envelope.destination.endpoint = approvedDestination;
  Object.assign(envelope.bindings, adapter);
  envelope.bindings.policy.sha256 = stalePolicy ? '0'.repeat(64) : policyDigest;
  envelope.ceilings = {input_bytes: 4096, output_bytes: 3000, runtime_ms: 800, cost_microunits: 5000};
  envelope.retention_facts = [{
    retention_fact_id: 'retention:remote-alpha',
    status: 'unknown_acknowledged',
    max_days: 30,
    data_use: 'provider_training_unknown',
    region: 'unsupported',
    subprocessors: [],
  }];
  const segment = envelope.payload_segments.at(-1);
  if (targetBytes !== undefined) {
    let padding = segment.utf8;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      segment.utf8 = padding;
      segment.byte_length = Buffer.byteLength(padding);
      segment.sha256 = remoteSha256(padding);
      const difference = targetBytes - Buffer.byteLength(canonicalJson(envelope));
      if (difference === 0) break;
      padding = difference > 0 ? `${padding}${'x'.repeat(difference)}` : padding.slice(0, difference);
    }
  }
  return canonicalJson(envelope);
}

function attemptObservation(scenarioId, sequence, kind, payload, denied, unknownCompletion = false) {
  const suffix = scenarioId.toLowerCase();
  const bytes = denied ? Buffer.alloc(0) : Buffer.from(payload, 'utf8');
  return {
    attempt_id: `adapter-attempt:${suffix}-${sequence}`,
    attempt_sequence: sequence,
    attempt_kind: denied ? 'denial' : kind,
    destination: denied ? null : approvedDestination,
    payload_base64: bytes.toString('base64'),
    transmitted_bytes: bytes.length,
    transmitted_sha256: remoteSha256(bytes),
    boundary: denied
      ? 'pre_egress_denial'
      : unknownCompletion ? 'egress_completion_unknown' : 'egress_complete',
    provider_request_id: denied || unknownCompletion ? null : `provider-request:${suffix}-${sequence}`,
  };
}

const authorityCases = ['semantic', 'note_placement', 'taxonomy', 'projection', 'filesystem', 'tool', 'automation']
  .map((authority) => [`${authority.replace('_', '-')}-authority-denied`, 'authority_denial', {claimedAuthority: authority}]);

const illegalTransitionPairs = {
  'permitted-egress': 'pending:transmit_remote_payload',
  denial: 'denied:authorize_remote_egress',
  failure: 'ready:record_remote_failure',
  retry: 'unavailable:transmit_remote_payload',
  fallback: 'unavailable:transmit_remote_payload',
  recovery: 'interrupted:recover_remote_receipt',
  verdict: 'pass:record_pass',
};

export const remoteAdapterCases = [
  ['permitted-primary-exact-bytes', 'positive', {}],
  ['permitted-retry-exact-bytes', 'positive', {operation: 'retry', attempts: 2, retries: 1}],
  ['permitted-fallback-exact-bytes', 'positive', {operation: 'fallback', attempts: 2, fallbacks: 1}],
  ['exact-input-ceiling', 'exact_boundary', {targetEnvelopeBytes: 4096, inputBytes: 4096}],
  ['exact-output-ceiling', 'exact_boundary', {outputBytes: 3000}],
  ['exact-runtime-ceiling', 'exact_boundary', {runtimeMs: 800}],
  ['exact-cost-ceiling', 'exact_boundary', {costMicrounits: 5000}],
  ['exact-attempt-ceiling', 'exact_boundary', {operation: 'fallback', attempts: 3, retries: 1, fallbacks: 1}],
  ['exact-retry-ceiling', 'exact_boundary', {operation: 'retry', attempts: 2, retries: 1}],
  ['exact-fallback-ceiling', 'exact_boundary', {operation: 'fallback', attempts: 2, fallbacks: 1}],
  ['missing-processing-envelope-denied', 'negative', {envelopeVariant: 'missing', behavior: 'missing'}],
  ['stale-policy-binding-denied', 'stale_state', {stalePolicy: true, behavior: 'stale'}],
  ['malformed-processing-envelope-denied', 'negative', {envelopeVariant: 'malformed', behavior: 'malformed'}],
  ['unsupported-provider-denied', 'negative', {provider: 'provider:unsupported', behavior: 'unsupported'}],
  ['unauthorized-provider-denied', 'authority_denial', {provider: 'provider:unauthorized', behavior: 'unauthorized'}],
  ['input-budget-exhausted', 'over_boundary', {inputBytes: 4097, behavior: 'over_budget'}],
  ['output-budget-exhausted', 'over_boundary', {outputBytes: 3001, behavior: 'over_budget'}],
  ['runtime-budget-exhausted', 'over_boundary', {runtimeMs: 801, behavior: 'over_budget'}],
  ['cost-budget-exhausted', 'over_boundary', {costMicrounits: 5001, behavior: 'over_budget'}],
  ['unapproved-destination-denied', 'authority_denial', {destination: 'https://api.unapproved.test/v1/process', behavior: 'unauthorized'}],
  ['forbidden-retry-denied', 'negative', {operation: 'retry', attempts: 3, retries: 2, behavior: 'forbidden_retry'}],
  ['forbidden-fallback-denied', 'negative', {operation: 'fallback', attempts: 3, fallbacks: 2, behavior: 'forbidden_fallback'}],
  ['failed-credential-boundary-denied', 'negative', {credentialVariant: 'failed', behavior: 'failed_boundary'}],
  ['missing-credential-boundary-denied', 'negative', {credentialVariant: 'missing', behavior: 'missing'}],
  ['stale-credential-boundary-denied', 'stale_state', {credentialVariant: 'stale', behavior: 'stale'}],
  ['malformed-credential-boundary-denied', 'negative', {credentialVariant: 'malformed', behavior: 'malformed'}],
  ['unsupported-credential-boundary-denied', 'negative', {credentialVariant: 'unsupported', behavior: 'unsupported'}],
  ['missing-retention-evidence-denied', 'negative', {retentionVariant: 'missing', behavior: 'missing'}],
  ['stale-retention-evidence-denied', 'stale_state', {retentionVariant: 'stale', behavior: 'stale'}],
  ['malformed-retention-evidence-denied', 'negative', {retentionVariant: 'malformed', behavior: 'malformed'}],
  ['unsupported-retention-evidence-denied', 'negative', {retentionVariant: 'unsupported', behavior: 'unsupported'}],
  ['inconclusive-retention-evidence-denied', 'negative', {retentionVariant: 'inconclusive', behavior: 'unsupported'}],
  ['authentication-does-not-establish-residency', 'negative', {providerFactClaim: 'residency'}],
  ['transport-does-not-establish-training', 'negative', {providerFactClaim: 'training'}],
  ['provider-output-does-not-establish-deletion', 'negative', {providerFactClaim: 'deletion'}],
  ['retry-does-not-establish-entitlement', 'negative', {operation: 'retry', attempts: 2, retries: 1, providerFactClaim: 'entitlement'}],
  ['fallback-does-not-establish-privacy-behavior', 'negative', {operation: 'fallback', attempts: 2, fallbacks: 1, providerFactClaim: 'privacy_behavior'}],
  ['absence-of-contrary-evidence-does-not-establish-training', 'negative', {providerFactClaim: 'training'}],
  ...authorityCases,
  ['crash-before-egress-zero-byte-recovery', 'crash_recovery', {behavior: 'crash_before_egress'}],
  ['crash-after-egress-preserves-attempt', 'crash_recovery', {behavior: 'crash_after_egress'}],
  ['recovery-revalidates-current-digests', 'crash_recovery', {operation: 'recover', behavior: 'recover_current'}],
  ['recovery-rejects-stale-claim-digest', 'stale_state', {operation: 'recover', behavior: 'recover_stale_claim'}],
  ['recovery-rejects-stale-evidence-digest', 'stale_state', {operation: 'recover', behavior: 'recover_stale_evidence'}],
  ...Object.entries(illegalTransitionPairs).map(([name, pair]) => [
    `illegal-${name}-transition-denied`,
    'illegal_transition',
    {operation: 'transition', transitionRef: `contracts/transitions/remote-adapter-${name}-lifecycle.json#${pair}`},
  ]),
];

function attemptKind(overrides, sequence) {
  if (sequence === 0) return 'initial';
  if (sequence <= (overrides.retries ?? 0)) return 'retry';
  return 'fallback';
}

export function remoteAdapterScenario(index, definition, evidence, baseEnvelope) {
  const [caseId, , overrides] = definition;
  const scenarioId = `RAP-${String(index + 1).padStart(3, '0')}`;
  const attempts = overrides.attempts ?? 1;
  const isDeniedBeforeEgress = overrides.envelopeVariant !== undefined || overrides.stalePolicy === true ||
    overrides.provider !== undefined || overrides.destination !== undefined ||
    (overrides.inputBytes ?? 0) > 4096 || (overrides.outputBytes ?? 0) > 3000 ||
    (overrides.runtimeMs ?? 0) > 800 || (overrides.costMicrounits ?? 0) > 5000 ||
    (overrides.retries ?? 0) > 1 || (overrides.fallbacks ?? 0) > 1 ||
    overrides.credentialVariant !== undefined || overrides.retentionVariant !== undefined ||
    overrides.claimedAuthority !== undefined || overrides.operation === 'transition' ||
    overrides.behavior === 'crash_before_egress';
  const firstEnvelope = overrides.envelopeVariant === 'missing'
    ? null
    : overrides.envelopeVariant === 'malformed'
      ? '{'
      : envelopeFor(baseEnvelope, scenarioId, 0, 'initial', overrides.targetEnvelopeBytes, overrides.stalePolicy);
  const envelopeSha256 = firstEnvelope === null ? null : remoteSha256(firstEnvelope);
  const credential = boundJson(evidence.credential, overrides.credentialVariant ?? 'current');
  const retention = boundJson(evidence.retention, overrides.retentionVariant ?? 'current');
  const authorizedAttempts = [];
  const observations = Array.from({length: isDeniedBeforeEgress ? 1 : attempts}, (_, sequence) => {
    const kind = attemptKind(overrides, sequence);
    const payload = sequence === 0
      ? firstEnvelope ?? ''
      : envelopeFor(baseEnvelope, scenarioId, sequence, kind, undefined, false);
    if (!isDeniedBeforeEgress) {
      authorizedAttempts.push({
        attempt_id: `adapter-attempt:${scenarioId.toLowerCase()}-${sequence}`,
        attempt_sequence: sequence,
        attempt_kind: kind,
        authorization_id: `adapter-authorization:remote-${kind === 'initial' ? 'primary' : kind}`,
        processing_envelope_json: payload,
        processing_envelope_sha256: remoteSha256(payload),
      });
    }
    return attemptObservation(
      scenarioId,
      sequence,
      kind,
      payload,
      isDeniedBeforeEgress,
      overrides.behavior === 'crash_after_egress',
    );
  });
  const observationsJson = canonicalJson(observations);
  return {
    schema_id: 'mdplace.remote-adapter-scenario/v1',
    scenario_id: scenarioId,
    case_id: caseId,
    operation: overrides.operation ?? 'execute',
    evaluated_at: remoteAdapterEvidenceEvaluatedAt,
    processing_envelope_json: firstEnvelope,
    processing_envelope_sha256: envelopeSha256,
    authorized_attempts: authorizedAttempts,
    credential_evidence_json: credential.json,
    credential_evidence_sha256: credential.sha256,
    retention_evidence_json: retention.json,
    retention_evidence_sha256: retention.sha256,
    attempt_observations_json: observationsJson,
    attempt_observations_sha256: remoteSha256(observationsJson),
    requested_provider: overrides.provider ?? approvedProvider,
    requested_destination: overrides.destination ?? approvedDestination,
    input_bytes: overrides.inputBytes ?? (firstEnvelope === null ? 0 : Buffer.byteLength(firstEnvelope)),
    output_bytes: overrides.outputBytes ?? 512,
    runtime_ms: overrides.runtimeMs ?? 250,
    cost_microunits: overrides.costMicrounits ?? 1000,
    attempts,
    retries: overrides.retries ?? 0,
    fallbacks: overrides.fallbacks ?? 0,
    ceilings: {input_bytes: 4096, output_bytes: 3000, runtime_ms: 800, cost_microunits: 5000, attempts: 3, retries: 1, fallbacks: 1},
    behavior: overrides.behavior ?? 'complete',
    claimed_authority: overrides.claimedAuthority ?? 'none',
    provider_fact_claim: overrides.providerFactClaim ?? null,
    transition_ref: overrides.transitionRef ?? null,
  };
}
