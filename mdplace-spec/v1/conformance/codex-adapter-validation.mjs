import {isDeepStrictEqual} from 'node:util';

import {codexReceiptMatchesScenario, codexReceiptReason, codexSha256} from './codex-adapter-core.mjs';
import {highestPrecedenceCode} from './intelligence-adapter-validation.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

export function codexHighestPrecedenceCode(codes) {
  const applicable = codes.filter((code) => code !== null);
  const reason = highestPrecedenceCode(applicable.map((code) => codexReceiptReason(code)));
  return applicable.find((code) => codexReceiptReason(code) === reason) ?? null;
}

export function codexObservationTimingCode(document) {
  const startedAt = Date.parse(document.attempt_observation.observed_started_at);
  const completedAt = Date.parse(document.attempt_observation.observed_completed_at);
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt - startedAt === document.runtime_ms
    ? null
    : 'codex.output_measurement_mismatch';
}

export function codexResourceCodes(document) {
  const codes = [];
  const actualOutputBytes = typeof document.raw_output === 'string' ? Buffer.byteLength(document.raw_output) : 0;
  if (actualOutputBytes > document.ceilings.output_bytes) codes.push('codex.output_limit_exceeded');
  if (document.output_bytes !== actualOutputBytes) codes.push('codex.output_measurement_mismatch');
  const checks = [
    ['jsonl_bytes', 'jsonl_bytes', 'codex.jsonl_limit_exceeded'],
    ['runtime_ms', 'runtime_ms', 'codex.runtime_limit_exceeded'], ['tokens', 'tokens', 'codex.token_limit_exceeded'],
    ['cost_microunits', 'cost_microunits', 'codex.cost_limit_exceeded'],
  ];
  codes.push(...checks.filter(([observed, ceiling]) => document[observed] > document.ceilings[ceiling])
    .map(([, , code]) => code));
  return codes;
}

export function codexObservationIsolationCodes(document) {
  const envelope = JSON.parse(document.processing_envelope_json);
  const isolation = document.attempt_observation.isolation;
  const codes = [];
  if (!isolation.ephemeral || !isolation.fresh_process || isolation.filesystem !== 'none' || isolation.tools !== 'none' ||
      isolation.ambient_configuration !== 'unreadable' || isolation.credential_visibility !== 'none' ||
      !isDeepStrictEqual(isolation.network_scope, [envelope.destination.endpoint]) ||
      !isDeepStrictEqual(isolation.effective_capabilities, envelope.capabilities)) {
    codes.push('codex.isolation_unavailable');
  }
  const canary = isolation.canary;
  const expectedCanaryId = `canary:${envelope.attempt_id.slice('adapter-attempt:'.length)}`;
  if (canary.canary_id !== expectedCanaryId || canary.challenge !== 'return inert-canary without actions' ||
      canary.expected !== 'inert-canary' || canary.observed !== 'inert-canary' || !canary.passed) {
    codes.push('codex.isolation_canary_failed');
  }
  return codes;
}

export async function codexApprovedEnvelopeCodes(document, envelope, payload, packageRoot, approvedSha256) {
  const read = await readPackageFile(
    packageRoot,
    'contracts/codex-intelligence-adapter/approved-processing-envelope.json',
  );
  if (read.status !== 'present') return ['codex.stale_processing_envelope'];
  if (codexSha256(read.content) !== approvedSha256) return ['codex.stale_processing_envelope'];
  try {
    const approved = JSON.parse(read.content.toString('utf8'));
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/processing-envelope.schema.json',
      approved,
    ));
    if (schemaCode !== null) return ['codex.stale_processing_envelope'];
    const suffix = document.scenario_id.toLowerCase();
    approved.envelope_id = `envelope:${suffix}`;
    approved.chain_id = `adapter-chain:${suffix}`;
    approved.attempt_id = `adapter-attempt:${suffix}`;
    approved.transmitted_fields[0].segment_id = `segment:${suffix}`;
    approved.payload_segments[0] = {
      segment_id: `segment:${suffix}`,
      field_id: 'field:source-content',
      utf8: payload,
      byte_length: Buffer.byteLength(payload),
      sha256: codexSha256(payload),
    };
    const codes = [];
    const policyProjection = ({envelope_id, chain_id, attempt_id, attempt_sequence, authorization_id, bindings, ceilings, contracts, cached_proposal_binding}) => ({
      envelope_id, chain_id, attempt_id, attempt_sequence, authorization_id,
      bindings: {
        vault_id: bindings.vault_id, policy: bindings.policy, source_profile: bindings.source_profile,
        taxonomy_revision: bindings.taxonomy_revision, source_note_id: bindings.source_note_id,
        source_note_version_sha256: bindings.source_note_version_sha256, adapter_id: bindings.adapter_id,
      },
      ceilings, contracts, cached_proposal_binding,
    });
    const providerProjection = ({bindings}) => ({
      provider_id: bindings.provider_id, model_id: bindings.model_id, model_version: bindings.model_version,
    });
    if (!isDeepStrictEqual(policyProjection(envelope), policyProjection(approved))) codes.push('codex.stale_processing_envelope');
    if (!isDeepStrictEqual(providerProjection(envelope), providerProjection(approved))) codes.push('codex.unapproved_provider');
    if (envelope.purpose_id !== approved.purpose_id) codes.push('codex.unapproved_purpose');
    if (!isDeepStrictEqual(envelope.destination, approved.destination)) codes.push('codex.unapproved_destination');
    if (!isDeepStrictEqual(envelope.transmitted_fields, approved.transmitted_fields) ||
        !isDeepStrictEqual(envelope.payload_segments, approved.payload_segments)) codes.push('codex.unapproved_payload');
    if (!isDeepStrictEqual(envelope.transmitted_artifacts, approved.transmitted_artifacts)) codes.push('codex.unapproved_artifact');
    if (!isDeepStrictEqual(envelope.redactions, approved.redactions)) codes.push('codex.redaction_unproven');
    if (!isDeepStrictEqual(envelope.retention_facts, approved.retention_facts) ||
        !isDeepStrictEqual(envelope.retention_artifacts, approved.retention_artifacts)) codes.push('codex.retention_unproven');
    if (!isDeepStrictEqual(envelope.capabilities, approved.capabilities)) codes.push('codex.capability_proof_mismatch');
    if (!isDeepStrictEqual(envelope.credential_boundary, approved.credential_boundary)) codes.push('codex.authentication_prerequisite_mismatch');
    if (codes.length === 0 && !isDeepStrictEqual(envelope, approved)) codes.push('codex.stale_processing_envelope');
    return codes;
  } catch {
    return ['codex.stale_processing_envelope'];
  }
}

function recoveryCompatibility(envelope) {
  return {
    adapter_id: envelope.bindings.adapter_id,
    provider_id: envelope.bindings.provider_id,
    model_id: envelope.bindings.model_id,
    model_version: envelope.bindings.model_version,
    purpose_id: envelope.purpose_id,
    destination: envelope.destination,
    capabilities: envelope.capabilities,
    credential_boundary: envelope.credential_boundary,
    ceilings: envelope.ceilings,
    contracts: envelope.contracts,
  };
}

export async function codexRecoveryTarget(document, recoveryRecord, packageRoot, observeScenario) {
  const stale = {code: 'codex.recovery_binding_stale', receipt: null};
  if (recoveryRecord === null || document.behavior !== 'recover_current') return stale;
  const manifestRead = await readPackageFile(packageRoot, 'contracts/codex-intelligence-adapter/fixture-manifest.json');
  if (manifestRead.status !== 'present') return stale;
  let entry;
  try {
    const manifest = JSON.parse(manifestRead.content.toString('utf8'));
    if (!Array.isArray(manifest.fixtures)) return stale;
    entry = manifest.fixtures.find(({fixture_id: id}) => id === recoveryRecord.target_fixture_id);
  } catch {
    return stale;
  }
  const expectedPath = entry === undefined ? null : `conformance/${entry.path}`;
  if (expectedPath === null || recoveryRecord.target_path !== expectedPath) return stale;
  const targetRead = await readPackageFile(packageRoot, expectedPath);
  if (targetRead.status !== 'present') return stale;
  try {
    const target = JSON.parse(targetRead.content.toString('utf8'));
    const targetDocument = target.subject.document;
    const targetEnvelope = JSON.parse(targetDocument.processing_envelope_json);
    const currentEnvelope = JSON.parse(document.processing_envelope_json);
    const identityMatches = target.fixture_id === recoveryRecord.target_fixture_id &&
      target.subject.kind === 'codex_intelligence_adapter' && targetDocument.operation === 'execute' &&
      ['crash_before_transmission', 'crash_after_transmission'].includes(targetDocument.behavior) &&
      targetEnvelope.chain_id === recoveryRecord.target_chain_id && targetEnvelope.attempt_id === recoveryRecord.target_attempt_id &&
      targetEnvelope.attempt_sequence === recoveryRecord.target_attempt_sequence &&
      targetEnvelope.authorization_id === recoveryRecord.target_authorization_id &&
      targetEnvelope.envelope_id === recoveryRecord.target_envelope_id &&
      targetDocument.processing_envelope_sha256 === recoveryRecord.target_envelope_sha256 &&
      recoveryRecord.target_attempt_class === 'primary' && targetEnvelope.attempt_sequence === 0 &&
      isDeepStrictEqual(recoveryRecord.preceding_receipt_sha256s, []) &&
      isDeepStrictEqual(recoveryCompatibility(targetEnvelope), recoveryCompatibility(currentEnvelope));
    if (!identityMatches) return stale;
    const recomputed = await observeScenario(target.subject, packageRoot);
    const receipt = JSON.parse(recomputed.receipts[0]);
    const compatibleCrash = recomputed.terminal_state === 'recovery_required' && recomputed.codes.length === 1 &&
      recomputed.codes[0].startsWith('codex.crash_');
    return compatibleCrash && receipt.receipt_sha256 === recoveryRecord.target_receipt_sha256 &&
      codexReceiptMatchesScenario(receipt, targetDocument) ? {code: null, receipt} : stale;
  } catch {
    return stale;
  }
}
