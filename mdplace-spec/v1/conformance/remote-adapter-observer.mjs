import {isDeepStrictEqual} from 'node:util';

import {canonicalJson} from './semantic-kernel-core.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {remoteAdapterEvidenceEvaluatedAt, remoteSha256} from './remote-adapter-core.mjs';

const approvedProvider = 'provider:remote-alpha';
const approvedDestination = 'https://api.remote-alpha.test/v1/process';
const currentPolicyDigest = '27a755ff5a6d91ce1f925c31cbc094bd25f70b54793dee4a9a4a56e8d3d07766';
const dimensions = ['residency', 'retention', 'training', 'deletion', 'entitlement', 'privacy_behavior'];

function parseBoundJson(json, digest) {
  if (json === null || digest === null) return {document: null, status: 'missing'};
  if (remoteSha256(json) !== digest) return {document: null, status: 'digest_mismatch'};
  try {
    return {document: JSON.parse(json), status: 'parsed'};
  } catch {
    return {document: null, status: 'malformed'};
  }
}

function currentEvidence(document) {
  const evaluatedAt = Date.parse(remoteAdapterEvidenceEvaluatedAt);
  return document?.status === 'current' &&
    Date.parse(document.observed_at) <= evaluatedAt && Date.parse(document.expires_at) > evaluatedAt;
}

function factStatuses(retention) {
  return Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    retention?.facts?.find((fact) => fact.dimension === dimension)?.status ?? 'unsupported',
  ]));
}

export function remoteAdapterReceiptDigest(receipt) {
  const {receipt_sha256: ignored, ...material} = receipt;
  void ignored;
  return remoteSha256(canonicalJson(material));
}

async function schemaCode(packageRoot, schema, document) {
  if (document === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schema, document));
  } catch {
    return 'schema.instance_missing';
  }
}

async function recoveryCodes(packageRoot, scenario, record) {
  if (record === null) return ['remote.recovery_record_missing'];
  const [claimRead, evidenceRead] = await Promise.all([
    readPackageFile(packageRoot, 'contracts/remote-intelligence-adapter/claim-manifest.json'),
    readPackageFile(packageRoot, 'conformance/evidence/remote-adapter-evidence.json'),
  ]);
  if (claimRead.status !== 'present' || evidenceRead.status !== 'present') {
    return ['remote.recovery_evidence_missing'];
  }
  let claim;
  try {
    claim = JSON.parse(claimRead.content.toString('utf8'));
    JSON.parse(evidenceRead.content.toString('utf8'));
  } catch {
    return ['remote.recovery_evidence_malformed'];
  }
  const expectedClaim = remoteSha256(claimRead.content);
  const expectedEvidence = claim.rows?.[0]?.evidence_digest;
  const codes = [];
  if (record.fixture_id === undefined || record.scenario_id !== scenario.scenario_id) {
    codes.push('remote.recovery_target_mismatch');
  }
  if (record.claim_manifest_sha256 !== expectedClaim) codes.push('remote.recovery_claim_digest_mismatch');
  if (record.evidence_digest !== expectedEvidence) codes.push('remote.recovery_evidence_digest_mismatch');
  return codes;
}

async function observationCodes(observations, denyBeforeEgress, scenario, packageRoot) {
  if (!Array.isArray(observations) || observations.length === 0) return ['remote.attempt_observation_invalid'];
  const codes = [];
  const authorized = Array.isArray(scenario.authorized_attempts) ? scenario.authorized_attempts : [];
  const expectedKinds = [
    'initial',
    ...Array.from({length: scenario.retries}, () => 'retry'),
    ...Array.from({length: scenario.fallbacks}, () => 'fallback'),
  ];
  if (denyBeforeEgress) {
    if (authorized.length !== 0) codes.push('remote.attempt_authorization_invalid');
  } else if (authorized.length !== observations.length ||
      !isDeepStrictEqual(expectedKinds, observations.map(({attempt_kind: kind}) => kind)) ||
      scenario.retries + scenario.fallbacks !== scenario.attempts - 1 ||
      authorized[0]?.processing_envelope_json !== scenario.processing_envelope_json ||
      authorized[0]?.processing_envelope_sha256 !== scenario.processing_envelope_sha256) {
    codes.push('remote.attempt_topology_invalid');
  }
  const attemptIds = observations.map(({attempt_id: id}) => id);
  if (new Set(attemptIds).size !== attemptIds.length) codes.push('remote.attempt_topology_invalid');
  for (const [index, observation] of observations.entries()) {
    let payload;
    try {
      payload = Buffer.from(observation.payload_base64, 'base64');
    } catch {
      codes.push('remote.attempt_observation_invalid');
      continue;
    }
    const exact = observation.transmitted_bytes === payload.length &&
      observation.transmitted_sha256 === remoteSha256(payload);
    if (!exact) codes.push('remote.transmitted_bytes_mismatch');
    const expectedAttemptId = `adapter-attempt:${scenario.scenario_id.toLowerCase()}-${index}`;
    if (observation.attempt_id !== expectedAttemptId || observation.attempt_sequence !== index) {
      codes.push('remote.attempt_topology_invalid');
    }
    if (denyBeforeEgress) {
      if (payload.length !== 0 || observation.destination !== null ||
          observation.boundary !== 'pre_egress_denial' || observation.provider_request_id !== null) {
        codes.push('remote.zero_byte_denial_invalid');
      }
    } else {
      if (observation.destination !== approvedDestination || payload.length === 0 ||
          !['egress_complete', 'egress_completion_unknown'].includes(observation.boundary)) {
        codes.push('remote.permitted_egress_invalid');
      }
      const binding = authorized[index];
      const expectedAuthorization = `adapter-authorization:remote-${observation.attempt_kind === 'initial' ? 'primary' : observation.attempt_kind}`;
      if (binding?.attempt_id !== observation.attempt_id || binding?.attempt_sequence !== index ||
          binding?.attempt_kind !== observation.attempt_kind || binding?.authorization_id !== expectedAuthorization ||
          binding?.processing_envelope_sha256 !== remoteSha256(binding?.processing_envelope_json ?? '') ||
          payload.toString('utf8') !== binding?.processing_envelope_json) {
        codes.push('remote.transmitted_payload_mismatch');
        continue;
      }
      let boundEnvelope;
      try {
        boundEnvelope = JSON.parse(binding.processing_envelope_json);
      } catch {
        codes.push('remote.attempt_authorization_invalid');
        continue;
      }
      if (await schemaCode(packageRoot, 'contracts/schemas/processing-envelope.schema.json', boundEnvelope) !== null ||
          boundEnvelope.attempt_id !== observation.attempt_id || boundEnvelope.attempt_sequence !== index ||
          boundEnvelope.authorization_id !== binding.authorization_id ||
          boundEnvelope.bindings?.provider_id !== approvedProvider ||
          boundEnvelope.destination?.endpoint !== approvedDestination ||
          !isDeepStrictEqual(boundEnvelope.ceilings, {
            input_bytes: 4096,
            output_bytes: 3000,
            runtime_ms: 800,
            cost_microunits: 5000,
          }) || !isDeepStrictEqual(boundEnvelope.retention_facts, [{
            retention_fact_id: 'retention:remote-alpha',
            status: 'unknown_acknowledged',
            max_days: 30,
            data_use: 'provider_training_unknown',
            region: 'unsupported',
            subprocessors: [],
          }])) {
        codes.push('remote.attempt_authorization_invalid');
      }
    }
  }
  if (observations.length !== (denyBeforeEgress ? 1 : scenario.attempts)) {
    codes.push('remote.attempt_count_mismatch');
  }
  return codes;
}

function receiptAttempts(observations) {
  return observations.map(({payload_base64, ...attempt}) => attempt);
}

export async function observeRemoteAdapterScenario(subject, packageRoot, recoveryRecord = null) {
  const scenario = subject.document;
  const operations = ['parse Remote Intelligence Adapter scenario', 'apply default-deny precedence'];
  const codes = [];
  const envelope = parseBoundJson(scenario.processing_envelope_json, scenario.processing_envelope_sha256);
  const credential = parseBoundJson(scenario.credential_evidence_json, scenario.credential_evidence_sha256);
  const retention = parseBoundJson(scenario.retention_evidence_json, scenario.retention_evidence_sha256);
  const attempts = parseBoundJson(scenario.attempt_observations_json, scenario.attempt_observations_sha256);

  if (scenario.operation === 'transition') {
    const [path, pair] = scenario.transition_ref.split('#');
    const tableRead = await readPackageFile(packageRoot, path);
    let row = null;
    if (tableRead.status === 'present') {
      try {
        const table = JSON.parse(tableRead.content.toString('utf8'));
        row = table.transitions.find(({from_state: state, command_or_event: command}) => `${state}:${command}` === pair);
      } catch {
        row = null;
      }
    }
    if (row?.allowed !== false) codes.push('remote.transition_fixture_invalid');
    codes.push('remote.illegal_transition');
  } else {
    if (envelope.status === 'missing') codes.push('remote.processing_envelope_missing');
    else if (envelope.status !== 'parsed') codes.push('remote.processing_envelope_malformed');
    else {
      const envelopeCode = await schemaCode(packageRoot, 'contracts/schemas/processing-envelope.schema.json', envelope.document);
      if (envelopeCode !== null) codes.push(envelopeCode);
      else if (envelope.document.bindings.policy.sha256 !== currentPolicyDigest) codes.push('remote.processing_envelope_stale');
    }
    if (scenario.requested_provider !== approvedProvider) {
      codes.push(scenario.behavior === 'unsupported' ? 'remote.provider_unsupported' : 'remote.provider_unauthorized');
    }
    if (scenario.requested_destination !== approvedDestination) codes.push('remote.destination_unapproved');
    const limits = ['input_bytes', 'output_bytes', 'runtime_ms', 'cost_microunits', 'attempts'];
    if (limits.some((key) => scenario[key] > scenario.ceilings[key])) codes.push('remote.budget_exceeded');
    if (scenario.retries > scenario.ceilings.retries) codes.push('remote.retry_forbidden');
    if (scenario.fallbacks > scenario.ceilings.fallbacks) codes.push('remote.fallback_forbidden');

    const credentialCode = await schemaCode(
      packageRoot,
      'contracts/schemas/remote-adapter-credential-boundary-evidence.schema.json',
      credential.document,
    );
    if (credential.status !== 'parsed' || credentialCode !== null || !currentEvidence(credential.document) ||
        credential.document?.prerequisite !== 'satisfied') codes.push('remote.credential_boundary_failed');
    const retentionCode = await schemaCode(
      packageRoot,
      'contracts/schemas/remote-adapter-retention-evidence.schema.json',
      retention.document,
    );
    if (retention.status !== 'parsed' || retentionCode !== null || !currentEvidence(retention.document) ||
        new Set(retention.document?.facts?.map(({dimension}) => dimension)).size !== dimensions.length) {
      codes.push('remote.retention_evidence_invalid');
    }
    if (scenario.claimed_authority !== 'none') codes.push('remote.authority_denied');
    const statuses = factStatuses(retention.document);
    if (scenario.provider_fact_claim !== null && statuses[scenario.provider_fact_claim] !== 'disclosed') {
      codes.push('remote.provider_fact_unproven');
    }
    if (scenario.behavior === 'crash_before_egress' || scenario.behavior === 'crash_after_egress') {
      codes.push('remote.recovery_required');
    }
    if (scenario.operation === 'recover') codes.push(...await recoveryCodes(packageRoot, scenario, recoveryRecord));
  }

  const denyBeforeEgress = scenario.behavior === 'crash_before_egress' || codes.some((code) => ![
    'remote.provider_fact_unproven',
    'remote.recovery_required',
    'remote.recovery_record_missing',
    'remote.recovery_target_mismatch',
    'remote.recovery_claim_digest_mismatch',
    'remote.recovery_evidence_digest_mismatch',
  ].includes(code));
  if (attempts.status !== 'parsed') codes.push('remote.attempt_observation_invalid');
  else codes.push(...await observationCodes(attempts.document, denyBeforeEgress, scenario, packageRoot));
  const uniqueCodes = [...new Set(codes)];
  const recoverySucceeded = scenario.operation === 'recover' && uniqueCodes.length === 0;
  const outcome = recoverySucceeded
    ? 'recovered'
    : uniqueCodes.includes('remote.recovery_required') || scenario.operation === 'recover' ? 'recovery_required'
      : uniqueCodes.length === 0 ? 'permitted' : 'denied';
  const reason = recoverySucceeded
    ? 'remote.recovery_completed'
    : uniqueCodes[0] ?? 'remote.egress_permitted';
  const receipt = {
    schema_id: 'mdplace.remote-adapter-profile-receipt/v1',
    receipt_id: `remote-adapter-receipt:${scenario.scenario_id.toLowerCase()}`,
    scenario_id: scenario.scenario_id,
    profile_id: 'remote-adapter',
    outcome,
    reason,
    attempts: receiptAttempts(attempts.document ?? []),
    credential_boundary_sha256: scenario.credential_evidence_sha256,
    retention_evidence_sha256: scenario.retention_evidence_sha256,
    provider_fact_statuses: factStatuses(retention.document),
    semantic_effects: [], filesystem_effects: [], tool_invocations: [],
  };
  receipt.receipt_sha256 = remoteAdapterReceiptDigest(receipt);
  operations.push('verify exact transmitted bytes and destination', 'record Remote Intelligence Adapter profile receipt');
  return {
    verdict: uniqueCodes.length === 0 ? 'pass' : 'fail',
    codes: uniqueCodes,
    inputs: [
      `envelope-sha256:${scenario.processing_envelope_sha256 ?? 'none'}`,
      `credential-boundary-sha256:${scenario.credential_evidence_sha256 ?? 'none'}`,
      `retention-evidence-sha256:${scenario.retention_evidence_sha256 ?? 'none'}`,
      `attempt-observations-sha256:${scenario.attempt_observations_sha256}`,
    ],
    outputs: [uniqueCodes.length === 0 ? 'Remote Intelligence Adapter profile observation accepted' : 'Remote Intelligence Adapter profile observation denied'],
    operations,
    receipts: [canonicalJson(receipt)],
    filesystem_effects: ['none'],
    network_effects: scenario.operation === 'recover' || denyBeforeEgress
      ? ['none']
      : (attempts.document ?? []).map(({destination, transmitted_sha256: sha256, transmitted_bytes: bytes}) => `transmit:${destination}:${sha256}:${bytes}`),
    observations: [scenario.attempt_observations_json],
    terminal_state: recoverySucceeded ? 'recovered' : outcome,
    illegal_transition: uniqueCodes.includes('remote.illegal_transition'),
  };
}
