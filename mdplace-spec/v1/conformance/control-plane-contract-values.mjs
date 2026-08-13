import {canonicalJson} from './semantic-kernel-core.mjs';

export const controlPlaneLimits = Object.freeze({
  maxJournalSequence: 20_000,
  maxTick: 1_000_000,
  leaseDurationTicks: 300,
  maxLeaseExpiryTick: 1_000_300,
  retryDelays: Object.freeze([1000, 5000]),
  retryCeiling: 2,
  recoveryInterruptionCeiling: 2,
  maxRecoveryInterruptionCount: 3,
  resumeCeiling: 1,
  latestDispatchTick: 999_700,
});

export function completionReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.lease_id ?? '',
    receipt.idempotency_key, receipt.base_head_sequence, receipt.base_head_digest,
    receipt.journal_sequence, receipt.completion_tick, receipt.outcome,
    receipt.output_digest ?? '', receipt.code ?? '',
    receipt.failure_retryable ?? '', receipt.failure_observed_tick ?? '',
    receipt.selected_retry_delay_ticks ?? '',
  ];
}

export function journalPrefixReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.journal_id, receipt.head_sequence, receipt.head_digest,
    canonicalJson(receipt.active_leases),
  ];
}

export function schedulerLeaseReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.vault_id, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.owner_agent_id, receipt.acquired_tick,
    receipt.expires_tick, receipt.status,
  ];
}

export function writerLockReceiptFields(receipt, vaultId) {
  return [
    receipt.lock_id, receipt.prior_epoch, receipt.epoch, receipt.owner_agent_id,
    receipt.token_digest, receipt.retained, vaultId,
  ];
}

export function readinessGateReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.agent_id, receipt.vault_id, receipt.ordinal,
    receipt.gate, receipt.verdict, receipt.observation_digest,
    receipt.previous_receipt_digest,
  ];
}

export function cancellationReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.cancellation_id, receipt.work_id, receipt.work_version,
    receipt.idempotency_key, receipt.requested_by, receipt.vault_owner_receipt.receipt_id,
    receipt.vault_owner_receipt.signature_digest, receipt.journal_sequence, receipt.cancellation_tick,
    receipt.reason_code, receipt.resume_count, receipt.resume_ceiling,
  ];
}

export function enqueueReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.work_id, receipt.work_version, receipt.idempotency_key,
    receipt.input_digest, receipt.base_head_sequence, receipt.base_head_digest,
    receipt.journal_sequence,
  ];
}

export function resumeReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.work_id, receipt.cancelled_work_version,
    receipt.resumed_work_version, receipt.idempotency_key,
    receipt.vault_owner_receipt.receipt_id, receipt.vault_owner_receipt.signature_digest,
    receipt.cancellation_receipt_id, receipt.cancellation_receipt_signature_digest,
    receipt.cancellation_completion_receipt_id, receipt.cancellation_completion_signature_digest,
    receipt.resume_count, receipt.journal_sequence,
  ];
}

export function vaultOwnerReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.principal_id, receipt.vault_id, receipt.action_kind,
    receipt.work_id, receipt.work_version, receipt.lease_id ?? '', receipt.idempotency_key,
  ];
}
