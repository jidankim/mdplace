export function replayControlPlaneLifecycle(events, limits) {
  let current = {
    state: 'absent', version: 0, retryCount: 0, recoveryCount: 0, rejectionCount: 0,
    retryEligibleTick: null, lease: null, start: null, endedLeaseId: null,
    failedRecovery: null,
  };
  const trace = [];
  for (const event of events) {
    const before = current;
    const next = advanceLifecycle(before, event, limits);
    if (next === null) return null;
    current = next;
    trace.push({event, before, after: current});
  }
  return {current, trace};
}

function advanceLifecycle(current, event, limits) {
  switch (event.kind) {
    case 'enqueue':
      if (current.state !== 'absent' || event.version !== 1 || event.declaredState !== 'queued' ||
          event.leaseId !== null) return null;
      return {...current, state: 'queued', version: 1};
    case 'lease':
      if (!['queued', 'retry_wait'].includes(current.state) || event.version !== current.version + 1 ||
          event.declaredState !== 'leased' || typeof event.leaseId !== 'string' ||
          event.status !== 'active' || event.expiresTick <= event.acquiredTick ||
          event.expiresTick - event.acquiredTick > limits.leaseDurationTicks ||
          event.acquiredTick > limits.latestDispatchTick ||
          (current.state === 'retry_wait' && event.acquiredTick < current.retryEligibleTick)) return null;
      return {...current, state: 'leased', version: event.version, retryEligibleTick: null,
        lease: event, start: null, endedLeaseId: null};
    case 'start':
      if (current.state !== 'leased' || current.lease === null ||
          event.version !== current.version + 1 || event.declaredState !== 'executing' ||
          event.leaseId !== current.lease.leaseId || event.ownerId !== current.lease.ownerId ||
          event.acquiredTick !== current.lease.acquiredTick || event.expiresTick !== current.lease.expiresTick ||
          event.status !== 'active' || event.observedTick < current.lease.acquiredTick ||
          event.observedTick >= current.lease.expiresTick) return null;
      return {...current, state: 'executing', version: event.version, start: event};
    case 'retry': {
      const delay = limits.retryDelays[current.retryCount];
      if (current.state !== 'executing' || current.lease === null || current.start === null ||
          event.version !== current.version + 1 || event.declaredState !== 'retry_wait' ||
          (!event.omitsLease && event.leaseId !== current.lease.leaseId) ||
          event.priorRetryCount !== current.retryCount || event.resultingRetryCount !== current.retryCount + 1 ||
          event.observedTick < current.start.observedTick || event.observedTick >= current.lease.expiresTick ||
          event.selectedDelay !== delay || event.retryEligibleTick !== event.observedTick + delay ||
          event.retryEligibleTick > limits.latestDispatchTick) return null;
      return {...current, state: 'retry_wait', version: event.version,
        retryCount: event.resultingRetryCount, retryEligibleTick: event.retryEligibleTick,
        lease: null, start: null, endedLeaseId: current.lease.leaseId};
    }
    case 'recovery': {
      const wasExecuting = current.state === 'executing';
      const delay = wasExecuting ? limits.retryDelays[current.retryCount] : null;
      const recoveryExhausted = current.recoveryCount + 1 > limits.recoveryCeiling;
      const retryExhausted = wasExecuting && current.retryCount >= limits.retryCeiling;
      const tickOverflow = wasExecuting && !retryExhausted &&
        event.observedTick + delay > limits.latestDispatchTick;
      const failureRequired = recoveryExhausted || retryExhausted || tickOverflow;
      if (!['leased', 'executing'].includes(current.state) || current.lease === null ||
          event.version !== current.version + 1 || event.leaseId !== current.lease.leaseId ||
          (event.priorState !== undefined && event.priorState !== current.state) ||
          (event.priorRetryCount !== undefined && event.priorRetryCount !== current.retryCount) ||
          event.recoveryCount !== current.recoveryCount + 1 || event.status !== 'expired' ||
          event.observedTick < (wasExecuting ? current.start?.observedTick : current.lease.acquiredTick) ||
          event.observedTick < current.lease.expiresTick ||
          (event.decision === 'fail') !== failureRequired) return null;
      if (failureRequired) {
        const expectedDelay = tickOverflow && !recoveryExhausted ? delay : null;
        if (event.declaredState !== 'failed' || event.resultingRetryCount !== current.retryCount ||
            event.selectedDelay !== expectedDelay || event.retryEligibleTick !== null) return null;
        return {...current, state: 'failed', version: event.version,
          recoveryCount: event.recoveryCount, lease: null, start: null,
          endedLeaseId: current.lease.leaseId,
          failedRecovery: {...event, priorRetryCount: current.retryCount,
            recoveryExhausted, retryExhausted, tickOverflow}};
      }
      if (wasExecuting) {
        if (event.declaredState !== 'retry_wait' ||
            event.resultingRetryCount !== current.retryCount + 1 || event.selectedDelay !== delay ||
            event.retryEligibleTick !== event.observedTick + delay ||
            event.retryEligibleTick > limits.latestDispatchTick) return null;
        return {...current, state: 'retry_wait', version: event.version,
          retryCount: event.resultingRetryCount, recoveryCount: event.recoveryCount,
          retryEligibleTick: event.retryEligibleTick, lease: null, start: null,
          endedLeaseId: current.lease.leaseId};
      }
      if (event.declaredState !== 'queued' || event.resultingRetryCount !== current.retryCount ||
          event.selectedDelay !== null || event.retryEligibleTick !== null) return null;
      return {...current, state: 'queued', version: event.version,
        recoveryCount: event.recoveryCount, lease: null, start: null,
        endedLeaseId: current.lease.leaseId};
    }
    case 'cancellation': {
      if (!['queued', 'leased', 'executing', 'retry_wait'].includes(current.state) ||
          event.version !== current.version + 1 || event.declaredState !== 'cancelled') return null;
      const applicableLease = ['leased', 'executing'].includes(current.state) ? current.lease : null;
      if (event.leaseId !== (applicableLease?.leaseId ?? null) ||
          (applicableLease !== null && (event.observedTick <
            (current.state === 'executing' ? current.start?.observedTick : applicableLease.acquiredTick) ||
            event.observedTick >= applicableLease.expiresTick))) return null;
      return {...current, state: 'cancelled', version: event.version, retryEligibleTick: null,
        lease: null, start: null, endedLeaseId: applicableLease?.leaseId ?? null};
    }
    case 'completion':
      if (current.state === 'cancelled' || current.state === 'failed') {
        if (event.version !== current.version || event.outcome !== current.state ||
            event.declaredState !== current.state || event.leaseId !== current.endedLeaseId) return null;
        return {...current, failedRecovery: null};
      }
      if (current.state !== 'executing' || current.lease === null || current.start === null ||
          event.version !== current.version + 1 || !['succeeded', 'failed'].includes(event.outcome) ||
          event.declaredState !== event.outcome || event.leaseId !== current.lease.leaseId ||
          event.observedTick < current.start.observedTick || event.observedTick >= current.lease.expiresTick) return null;
      return {...current, state: event.outcome, version: event.version, lease: null, start: null,
        endedLeaseId: current.lease.leaseId};
    case 'resume':
      if (current.state !== 'cancelled' || event.version !== current.version + 1 ||
          event.declaredState !== 'queued' || event.leaseId !== null) return null;
      return {...current, state: 'queued', version: event.version, endedLeaseId: null};
    case 'rejection':
      if (current.state === 'absent' || event.version !== current.version ||
          event.declaredState !== 'rejected' || event.leaseId !== null) return null;
      return {...current, rejectionCount: current.rejectionCount + 1};
    default:
      return null;
  }
}
