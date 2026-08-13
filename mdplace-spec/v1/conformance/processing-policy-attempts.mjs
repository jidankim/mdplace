import {isDeepStrictEqual} from 'node:util';

import {sha256Json} from './processing-policy-core.mjs';

export function processingAttemptReceiptDigest(receipt) {
  const {receipt_sha256: _receiptDigest, ...receiptPayload} = receipt;
  return sha256Json(receiptPayload);
}

export function attemptChainViolation(policy, request) {
  const chain = request.attempt_chain;
  if (!Array.isArray(chain) || chain.length !== request.retry.attempts + request.fallback_position + 1 ||
      chain.some((attempt, index) => attempt.sequence !== index) ||
      chain.some((attempt, index) => attempt.outcome !== (index === chain.length - 1
        ? 'pending'
        : 'safe_transient_failure'))) return 'policy.retry_exceeded';
  const initial = chain.filter(({fallback_position: position}) => position === 0);
  if (initial.length !== request.retry.attempts + 1 || initial.some(({adapter_id: adapterId}) =>
    adapterId !== initial[0]?.adapter_id) || initial.some(({consent_binding_id: consentId}) =>
    consentId !== initial[0]?.consent_binding_id)) return 'policy.retry_exceeded';
  const fallback = chain.filter(({fallback_position: position}) => position > 0);
  if (fallback.some((attempt, index) => {
    const expected = policy.grants.fallback_chain[index];
    return attempt.fallback_position !== index + 1 || expected === undefined ||
      attempt.adapter_id !== expected.adapter_id ||
      attempt.consent_binding_id !== expected.consent_binding_id;
  })) return 'policy.fallback_denied';
  const current = chain.at(-1);
  if (current.adapter_id !== request.adapter_id || current.consent_binding_id !== request.consent_binding_id ||
      current.fallback_position !== request.fallback_position) return 'policy.fallback_denied';
  if (chain.some((attempt) => !policy.grants.consent_bindings.some((binding) =>
    binding.consent_binding_id === attempt.consent_binding_id && binding.adapter_id === attempt.adapter_id))) {
    return 'policy.fallback_denied';
  }
  return null;
}

export function attemptAccountingViolation(document) {
  const {attempt_receipts: receipts, request, trusted_context: trusted} = document;
  if (!Array.isArray(receipts) || receipts.length !== request.attempt_chain.length ||
      new Set(receipts.map(({receipt_id: id}) => id)).size !== receipts.length) return 'policy.retry_exceeded';
  const byId = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const totals = {input_bytes: 0, output_bytes: 0, elapsed_ms: 0, cumulative_cost_microunits: 0};
  const payloadBytes = Buffer.byteLength(request.payload.bytes, 'utf8');
  for (const attempt of request.attempt_chain) {
    const receipt = byId.get(attempt.receipt_id);
    if (receipt === undefined || receipt.receipt_sha256 !== attempt.receipt_sha256 ||
        receipt.receipt_sha256 !== processingAttemptReceiptDigest(receipt) ||
        !trusted.attempt_receipt_sha256s.includes(receipt.receipt_sha256) ||
        receipt.request_id !== request.request_id || receipt.sequence !== attempt.sequence ||
        receipt.adapter_id !== attempt.adapter_id || receipt.consent_binding_id !== attempt.consent_binding_id ||
        receipt.fallback_position !== attempt.fallback_position || receipt.outcome !== attempt.outcome ||
        receipt.payload_sha256 !== request.payload.sha256 || receipt.usage.input_bytes < payloadBytes ||
        receipt.accounting_kind !== (attempt.outcome === 'pending' ? 'reserved' : 'measured') ||
        receipt.issuer !== 'mdplace_local_attempt_accountant' ||
        receipt.identity_assurance !== 'trusted_local_accountant' ||
        receipt.verification_method !== 'manifest_bound_attempt_accounting_readback') {
      return 'policy.retry_exceeded';
    }
    totals.input_bytes += receipt.usage.input_bytes;
    totals.output_bytes += receipt.usage.output_bytes;
    totals.elapsed_ms += receipt.usage.elapsed_ms;
    totals.cumulative_cost_microunits += receipt.usage.cost_microunits;
  }
  const declared = {
    input_bytes: request.retry.input_bytes,
    output_bytes: request.retry.output_bytes,
    elapsed_ms: request.retry.elapsed_ms,
    cumulative_cost_microunits: request.retry.cumulative_cost_microunits,
  };
  return isDeepStrictEqual(totals, declared) ? null : 'policy.retry_exceeded';
}
