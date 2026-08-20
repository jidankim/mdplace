import {createHash} from 'node:crypto';

import {canonicalJson} from './semantic-kernel-core.mjs';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalDigest(value) {
  return sha256(canonicalJson(value));
}

export function adapterReceiptDigest(receipt) {
  const {receipt_sha256: ignored, ...body} = receipt;
  return canonicalDigest(body);
}

export function createAdapterReceipt({attempt, transmission, isolation, budget, rawOutput, proposal, outcome, reason}) {
  const envelope = attempt.envelope;
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
    envelope_id: envelope.envelope_id,
    envelope_sha256: canonicalDigest(envelope),
    transmission_sha256: transmission?.sha256 ?? null,
    transmitted_bytes: transmission?.byte_length ?? 0,
    observed_destination: transmission?.destination ?? null,
    effective_capabilities: isolation.effective_capabilities,
    retention_artifact_sha256s: envelope.retention_artifacts.map(sha256),
    credential_boundary_sha256: canonicalDigest(envelope.credential_boundary),
    isolation: {
      ephemeral: isolation.ephemeral,
      fresh_process: isolation.fresh_process,
      filesystem: isolation.filesystem,
      tools: isolation.tools,
      ambient_configuration: isolation.ambient_configuration,
      credential_visibility: isolation.credential_visibility,
      network_scope: isolation.network_scope,
      canary_id: isolation.canary.canary_id,
      canary_passed: isolation.canary.passed,
    },
    budget,
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
