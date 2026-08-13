import {createHash} from 'node:crypto';

import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {replayControlPlaneLifecycle} from './control-plane-lifecycle-replay.mjs';
import {
  cancellationReceiptFields,
  completionReceiptFields,
  controlPlaneLimits,
  enqueueReceiptFields,
  journalPrefixReceiptFields,
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
  return scenarioLifecycleDigestAtSequence(initial, initial.journal_head_sequence);
}

export function scenarioLifecycleDigestAtSequence(initial, sequence) {
  if (sequence < initial.journal_prefix_receipt.head_sequence) return null;
  const receipts = lifecycleRecords(initial)
    .filter(({receipt}) => receipt.journal_sequence <= sequence)
    .map(({receipt}) => receipt);
  if (receipts.length === 0) return initial.journal_prefix_receipt.head_digest;
  return createHash('sha256').update(canonicalJson({
    prefix_head_sequence: initial.journal_prefix_receipt.head_sequence,
    prefix_head_digest: initial.journal_prefix_receipt.head_digest,
    receipts,
  })).digest('hex');
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
  const prefix = initial.journal_prefix_receipt;
  const prefixLeaseIds = prefix.active_leases.map(({lease_id: id}) => id);
  const prefixWorkIds = prefix.active_leases.map(({work_id: id}) => id);
  const prefixIsAuthenticated = prefix.journal_id === `journal:${initial.vault_id.replace(':', '-')}` &&
    prefix.active_leases.length <= prefix.head_sequence &&
    new Set(prefixLeaseIds).size === prefixLeaseIds.length &&
    new Set(prefixWorkIds).size === prefixWorkIds.length &&
    (work === null || !prefixWorkIds.includes(work.work_id)) &&
    verifyControlPlaneReceipt(
      'work_journal_prefix', journalPrefixReceiptFields(prefix), prefix, initial.persistent_agent_id,
    );
  if (new Set(records.map(({receipt}) => receipt.receipt_id)).size !== records.length ||
      new Set(records.map(({receipt}) => receipt.journal_sequence)).size !== records.length ||
      !prefixIsAuthenticated ||
      records.some(({receipt}, index) => receipt.journal_sequence !== prefix.head_sequence + index + 1) ||
      initial.journal_head_sequence !== prefix.head_sequence + records.length ||
      initial.journal_head_digest !== scenarioLifecycleDigest(initial) ||
      records.some(({kind, receipt}) => !receiptIsAuthenticated(initial, kind, receipt))) return false;
  if (work === null) return records.length === 0;

  const events = [];
  for (const {kind, receipt} of records) {
    if (receipt.work_id !== work.work_id) return false;
    const precedingRecord = records.find(({receipt: candidate}) =>
      candidate.journal_sequence === receipt.journal_sequence - 1);
    const preceding = precedingRecord?.receipt;
    if (kind === 'enqueue' && (receipt.base_head_sequence !== prefix.head_sequence ||
        receipt.base_head_digest !== prefix.head_digest ||
        receipt.journal_sequence !== prefix.head_sequence + 1)) return false;
    if (kind === 'lease' && (receipt.owner_agent_id !== initial.persistent_agent_id ||
        receipt.started_tick !== null)) return false;
    if (kind === 'cancellation' &&
        (receipt.vault_owner_receipt.vault_id !== initial.vault_id ||
         receipt.vault_owner_receipt.action_kind !== 'cancel')) return false;
    if (kind === 'completion') {
      const adjacentTerminal = ['cancellation', 'recovery'].includes(precedingRecord?.kind);
      const expectedBase = adjacentTerminal ? preceding.journal_sequence : receipt.journal_sequence - 1;
      if (receipt.idempotency_key !== work.idempotency_key ||
          receipt.base_head_sequence !== expectedBase ||
          receipt.base_head_digest !== scenarioLifecycleDigestAtSequence(initial, expectedBase) ||
          (adjacentTerminal && receipt.journal_sequence !== preceding.journal_sequence + 1) ||
          (precedingRecord?.kind === 'cancellation' && receipt.completion_tick !== preceding.cancellation_tick) ||
          (precedingRecord?.kind === 'recovery' && receipt.completion_tick !== preceding.recovery_tick) ||
          (receipt.outcome === 'failed' && receipt.failure_observed_tick !== null &&
            receipt.completion_tick !== receipt.failure_observed_tick)) return false;
    }
    if (kind === 'resume' && (preceding?.outcome !== 'cancelled' ||
        receipt.cancelled_work_version !== preceding.work_version ||
        receipt.resumed_work_version !== preceding.work_version + 1)) return false;
    events.push(scenarioEvent(kind, receipt));
  }
  const replay = replayControlPlaneLifecycle(events, {
    leaseDurationTicks: controlPlaneLimits.leaseDurationTicks,
    retryDelays: controlPlaneLimits.retryDelays,
    retryCeiling: controlPlaneLimits.retryCeiling,
    recoveryCeiling: controlPlaneLimits.recoveryInterruptionCeiling,
    latestDispatchTick: controlPlaneLimits.latestDispatchTick,
    reservedLeaseIds: prefixLeaseIds,
  });
  if (replay === null) return false;
  const {current} = replay;
  const leaseIsExact = ['leased', 'executing'].includes(current.state)
    ? current.lease !== null && work.lease_id === current.lease.leaseId &&
      work.owner_agent_id === current.lease.ownerId &&
      work.lease_acquired_tick === current.lease.acquiredTick &&
      work.lease_expires_tick === current.lease.expiresTick && work.lease_status === current.lease.status
    : work.lease_id === null && work.owner_agent_id === null && work.lease_acquired_tick === null &&
      work.lease_expires_tick === null && work.lease_status === null;
  return current.state === work.state && current.version === work.work_version &&
    current.retryCount === work.retry_count && current.recoveryCount === work.recovery_interruption_count &&
    current.retryEligibleTick === work.retry_eligible_tick && leaseIsExact;
}

function scenarioEvent(kind, receipt) {
  const common = {kind, version: receipt.work_version, leaseId: receipt.lease_id ?? null};
  switch (kind) {
    case 'enqueue': return {...common, declaredState: 'queued'};
    case 'lease': return {...common, declaredState: 'leased', ownerId: receipt.owner_agent_id,
      acquiredTick: receipt.acquired_tick, expiresTick: receipt.expires_tick, status: receipt.status};
    case 'start': return {...common, declaredState: 'executing', ownerId: receipt.owner_agent_id,
      acquiredTick: receipt.acquired_tick, expiresTick: receipt.expires_tick,
      observedTick: receipt.started_tick, status: receipt.status};
    case 'retry': return {...common, declaredState: 'retry_wait', priorRetryCount: receipt.prior_retry_count,
      resultingRetryCount: receipt.resulting_retry_count, observedTick: receipt.failure_tick,
      selectedDelay: receipt.selected_retry_delay_ticks, retryEligibleTick: receipt.retry_eligible_tick};
    case 'recovery': return {...common, declaredState: receipt.resulting_state,
      priorState: receipt.prior_state, priorRetryCount: receipt.prior_retry_count,
      recoveryCount: receipt.recovery_interruption_count,
      resultingRetryCount: receipt.resulting_retry_count, observedTick: receipt.recovery_tick,
      status: receipt.recovery_lease_status, decision: receipt.recovery_decision,
      selectedDelay: receipt.selected_retry_delay_ticks,
      retryEligibleTick: receipt.resulting_state === 'retry_wait'
        ? receipt.recovery_tick + receipt.selected_retry_delay_ticks : null};
    case 'cancellation': return {...common, declaredState: 'cancelled',
      leaseId: receipt.vault_owner_receipt.lease_id, observedTick: receipt.cancellation_tick};
    case 'completion': return {...common, declaredState: receipt.outcome,
      outcome: receipt.outcome, observedTick: receipt.completion_tick,
      failureObservedTick: receipt.failure_observed_tick};
    case 'resume': return {...common, version: receipt.resumed_work_version,
      leaseId: null, declaredState: 'queued'};
    default: return common;
  }
}
