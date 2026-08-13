const digestPattern = /^[a-f0-9]{64}$/;

export function controlPlaneOutcomeFieldsAreValid(result, {
  retryCount,
  retryCeiling,
  recoveryInterruptionCount,
  recoveryCeiling,
  retryDelays = [1000, 5000],
  latestDispatchTick = 999700,
}) {
  const hasNoFailureBasis = result?.failure_retryable === null &&
    result?.failure_observed_tick === null && result?.selected_retry_delay_ticks === null;
  if (result?.outcome === 'succeeded') {
    return typeof result.output_digest === 'string' && digestPattern.test(result.output_digest) &&
      result.code === null && hasNoFailureBasis;
  }
  if (result?.outcome === 'cancelled') {
    return result.output_digest === null && result.code === 'control.cancelled' && hasNoFailureBasis;
  }
  if (result?.outcome !== 'failed' || result.output_digest !== null) return false;
  if (result.code === 'control.execution_failed') {
    return result.failure_retryable === false && Number.isInteger(result.failure_observed_tick) &&
      result.selected_retry_delay_ticks === null;
  }
  if (result.code === 'control.retry_ceiling_exceeded') {
    return retryCount === retryCeiling && result.failure_retryable === true &&
      Number.isInteger(result.failure_observed_tick) && result.selected_retry_delay_ticks === null;
  }
  if (result.code === 'control.recovery_ceiling_exceeded') {
    return recoveryInterruptionCount === recoveryCeiling && hasNoFailureBasis;
  }
  if (result.code !== 'control.retry_tick_overflow' || result.failure_retryable !== true ||
      !Number.isInteger(result.failure_observed_tick) || retryCount >= retryCeiling) return false;
  const expectedDelay = retryDelays[retryCount];
  return result.selected_retry_delay_ticks === expectedDelay &&
    result.failure_observed_tick + expectedDelay > latestDispatchTick;
}
