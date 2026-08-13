import {createHash} from 'node:crypto';

import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {
  cancellationReceiptFields,
  completionReceiptFields,
  controlPlaneLimits,
  enqueueReceiptFields,
  resumeReceiptFields,
} from './control-plane-contract-values.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

export function leaseReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.owner_agent_id,
    receipt.acquired_tick, receipt.expires_tick, receipt.started_tick ?? '', receipt.status,
  ];
}

export function recoveryReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.prior_state,
    receipt.prior_retry_count, receipt.recovery_interruption_count,
    receipt.resulting_retry_count, receipt.recovery_tick, receipt.recovery_lease_status,
    receipt.recovery_decision, receipt.selected_retry_delay_ticks ?? '', receipt.resulting_state,
  ];
}

export function retryReceiptFields(receipt) {
  return [
    receipt.receipt_id, receipt.receipt_kind, receipt.lease_id, receipt.work_id,
    receipt.work_version, receipt.journal_sequence, receipt.prior_retry_count,
    receipt.resulting_retry_count, receipt.failure_tick, receipt.selected_retry_delay_ticks,
    receipt.retry_eligible_tick,
  ];
}

function lifecycleRecords(initial) {
  const work = initial.work;
  if (work === null) return [];
  return [
    {kind: 'enqueue', receipt: work.enqueue_receipt},
    ...initial.prior_lease_receipts.map((receipt) => ({kind: receipt.receipt_kind, receipt})),
    ...(initial.prior_retry_receipts ?? []).map((receipt) => ({kind: 'retry', receipt})),
    ...(initial.prior_recovery_receipts ?? []).map((receipt) => ({kind: 'recovery', receipt})),
    ...work.cancellation_history.map((receipt) => ({kind: 'cancellation', receipt})),
    ...work.completion_history.map((receipt) => ({kind: 'completion', receipt})),
    ...(work.resume_receipt === null ? [] : [{kind: 'resume', receipt: work.resume_receipt}]),
  ].sort((left, right) => left.receipt.journal_sequence - right.receipt.journal_sequence);
}

export function scenarioLifecycleDigest(initial) {
  const receipts = lifecycleRecords(initial).map(({receipt}) => receipt);
  return createHash('sha256').update(canonicalJson(receipts)).digest('hex');
}

function receiptIsAuthenticated(initial, kind, receipt) {
  const agentId = initial.persistent_agent_id;
  switch (kind) {
    case 'enqueue':
      return verifyControlPlaneReceipt('work_enqueue', enqueueReceiptFields(receipt), receipt, agentId);
    case 'lease':
    case 'start':
      return verifyControlPlaneReceipt('work_lease', leaseReceiptFields(receipt), receipt, agentId);
    case 'retry':
      return verifyControlPlaneReceipt('work_retry', retryReceiptFields(receipt), receipt, agentId);
    case 'recovery':
      return verifyControlPlaneReceipt('work_recovery', recoveryReceiptFields(receipt), receipt, agentId);
    case 'cancellation':
      return verifyControlPlaneReceipt(
        'work_journal_cancellation', cancellationReceiptFields(receipt), receipt, agentId,
      );
    case 'completion':
      return verifyControlPlaneReceipt('work_completion', completionReceiptFields(receipt), receipt, agentId);
    case 'resume':
      return verifyControlPlaneReceipt('work_resume', resumeReceiptFields(receipt), receipt, agentId);
    default:
      return false;
  }
}

export function scenarioLifecycleIsValid(initial) {
  const work = initial.work;
  const records = lifecycleRecords(initial);
  if (new Set(records.map(({receipt}) => receipt.receipt_id)).size !== records.length ||
      new Set(records.map(({receipt}) => receipt.journal_sequence)).size !== records.length ||
      records.some(({receipt}, index) => receipt.journal_sequence !== index + 1) ||
      initial.journal_head_sequence !== records.length ||
      initial.journal_head_digest !== scenarioLifecycleDigest(initial) ||
      records.some(({kind, receipt}) => !receiptIsAuthenticated(initial, kind, receipt))) return false;
  if (work === null) return records.length === 0;

  let state = 'absent';
  let version = 0;
  let retryCount = 0;
  let recoveryCount = 0;
  let retryEligibleTick = null;
  let lease = null;
  let cancellation = null;
  let completion = null;

  for (const {kind, receipt} of records) {
    if (receipt.work_id !== work.work_id) return false;
    switch (kind) {
      case 'enqueue':
        if (state !== 'absent' || receipt.work_version !== 1) return false;
        state = 'queued'; version = 1;
        break;
      case 'lease':
        if (!['queued', 'retry_wait'].includes(state) || receipt.work_version !== version + 1 ||
            receipt.owner_agent_id !== initial.persistent_agent_id ||
            receipt.started_tick !== null || receipt.status !== 'active' ||
            receipt.expires_tick <= receipt.acquired_tick ||
            receipt.expires_tick - receipt.acquired_tick > controlPlaneLimits.leaseDurationTicks ||
            receipt.acquired_tick > controlPlaneLimits.latestDispatchTick ||
            (state === 'retry_wait' && receipt.acquired_tick < retryEligibleTick)) return false;
        state = 'leased'; version = receipt.work_version; lease = receipt; retryEligibleTick = null;
        break;
      case 'start':
        if (state !== 'leased' || lease === null || receipt.work_version !== version + 1 ||
            receipt.lease_id !== lease.lease_id || receipt.owner_agent_id !== lease.owner_agent_id ||
            receipt.acquired_tick !== lease.acquired_tick || receipt.expires_tick !== lease.expires_tick ||
            receipt.status !== 'active' || receipt.started_tick < lease.acquired_tick ||
            receipt.started_tick >= lease.expires_tick) return false;
        state = 'executing'; version = receipt.work_version;
        break;
      case 'retry': {
        const delay = controlPlaneLimits.retryDelays[retryCount];
        if (state !== 'executing' || lease === null || receipt.work_version !== version + 1 ||
            receipt.lease_id !== lease.lease_id || receipt.prior_retry_count !== retryCount ||
            receipt.resulting_retry_count !== retryCount + 1 ||
            receipt.failure_tick < lease.acquired_tick || receipt.failure_tick >= lease.expires_tick ||
            receipt.selected_retry_delay_ticks !== delay ||
            receipt.retry_eligible_tick !== receipt.failure_tick + delay ||
            receipt.retry_eligible_tick > controlPlaneLimits.latestDispatchTick) return false;
        state = 'retry_wait'; version = receipt.work_version; retryCount += 1;
        retryEligibleTick = receipt.retry_eligible_tick; lease = null;
        break;
      }
      case 'recovery': {
        const wasExecuting = state === 'executing';
        const delay = wasExecuting ? controlPlaneLimits.retryDelays[retryCount] : null;
        const recoveryExhausted = recoveryCount + 1 > controlPlaneLimits.recoveryInterruptionCeiling;
        const retryExhausted = wasExecuting && retryCount >= controlPlaneLimits.retryCeiling;
        const tickOverflow = wasExecuting && !retryExhausted &&
          receipt.recovery_tick + delay > controlPlaneLimits.latestDispatchTick;
        const failureRequired = recoveryExhausted || retryExhausted || tickOverflow;
        if (!['leased', 'executing'].includes(state) || lease === null ||
            receipt.work_version !== version + 1 || receipt.lease_id !== lease.lease_id ||
            receipt.prior_state !== state || receipt.prior_retry_count !== retryCount ||
            receipt.recovery_interruption_count !== recoveryCount + 1 ||
            !['expired', 'revoked'].includes(receipt.recovery_lease_status) ||
            receipt.recovery_tick < lease.acquired_tick ||
            (receipt.recovery_lease_status === 'expired' && receipt.recovery_tick < lease.expires_tick) ||
            (receipt.recovery_decision === 'fail') !== failureRequired) return false;
        if (failureRequired) {
          if (receipt.resulting_state !== 'failed' || receipt.resulting_retry_count !== retryCount ||
              receipt.selected_retry_delay_ticks !== (tickOverflow && !recoveryExhausted ? delay : null)) return false;
          state = 'failed';
        } else if (wasExecuting) {
          if (receipt.resulting_state !== 'retry_wait' ||
              receipt.resulting_retry_count !== retryCount + 1 ||
              receipt.selected_retry_delay_ticks !== delay) return false;
          state = 'retry_wait'; retryCount += 1;
          retryEligibleTick = receipt.recovery_tick + delay;
        } else {
          if (receipt.resulting_state !== 'queued' || receipt.resulting_retry_count !== retryCount ||
              receipt.selected_retry_delay_ticks !== null) return false;
          state = 'queued';
        }
        version = receipt.work_version; recoveryCount += 1; lease = null;
        break;
      }
      case 'cancellation':
        if (!['queued', 'leased', 'executing', 'retry_wait'].includes(state) ||
            receipt.work_version !== version + 1 ||
            receipt.vault_owner_receipt.vault_id !== initial.vault_id ||
            !((lease === null && receipt.vault_owner_receipt.lease_id === null) ||
              (lease !== null && receipt.vault_owner_receipt.lease_id === lease.lease_id)) ||
            (lease !== null && (lease.status !== 'active' ||
              receipt.cancellation_tick < lease.acquired_tick ||
              receipt.cancellation_tick >= lease.expires_tick))) return false;
        state = 'cancelled'; version = receipt.work_version; cancellation = receipt; lease = null;
        break;
      case 'completion':
        if (state === 'cancelled') {
          if (cancellation === null || receipt.outcome !== 'cancelled' ||
              receipt.work_version !== version ||
              receipt.journal_sequence !== cancellation.journal_sequence + 1) return false;
        } else if (state === 'failed') {
          if (receipt.outcome !== 'failed' || receipt.work_version !== version) return false;
        } else if (state === 'executing') {
          if (!['succeeded', 'failed'].includes(receipt.outcome) ||
              receipt.work_version !== version + 1 || receipt.lease_id !== lease?.lease_id) return false;
          state = receipt.outcome; version = receipt.work_version; lease = null;
        } else {
          return false;
        }
        completion = receipt;
        break;
      case 'resume':
        if (state !== 'cancelled' || completion?.outcome !== 'cancelled' ||
            receipt.cancelled_work_version !== version ||
            receipt.resumed_work_version !== version + 1 ||
            receipt.journal_sequence !== completion.journal_sequence + 1) return false;
        state = 'queued'; version = receipt.resumed_work_version;
        cancellation = null; completion = null;
        break;
      default:
        return false;
    }
  }

  const leaseIsExact = ['leased', 'executing'].includes(state)
    ? lease !== null && work.lease_id === lease.lease_id && work.owner_agent_id === lease.owner_agent_id &&
      work.lease_acquired_tick === lease.acquired_tick && work.lease_expires_tick === lease.expires_tick &&
      ['active', 'expired', 'revoked'].includes(work.lease_status)
    : work.lease_id === null && work.owner_agent_id === null && work.lease_acquired_tick === null &&
      work.lease_expires_tick === null && work.lease_status === null;
  return state === work.state && version === work.work_version && retryCount === work.retry_count &&
    recoveryCount === work.recovery_interruption_count &&
    retryEligibleTick === work.retry_eligible_tick && leaseIsExact;
}
