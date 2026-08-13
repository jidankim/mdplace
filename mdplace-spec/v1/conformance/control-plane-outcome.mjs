const digestPattern = /^[a-f0-9]{64}$/;

export function controlPlaneOutcomeFieldsAreValid(result, {
  retryCount,
  retryCeiling,
  recoveryInterruptionCount,
  recoveryCeiling,
}) {
  if (result?.outcome === 'succeeded') {
    return typeof result.output_digest === 'string' && digestPattern.test(result.output_digest) &&
      result.code === null;
  }
  if (result?.outcome === 'cancelled') {
    return result.output_digest === null && result.code === 'control.cancelled';
  }
  if (result?.outcome !== 'failed' || result.output_digest !== null) return false;
  if (result.code === 'control.retry_ceiling_exceeded') return retryCount === retryCeiling;
  if (result.code === 'control.recovery_ceiling_exceeded') {
    return recoveryInterruptionCount === recoveryCeiling;
  }
  return ['control.execution_failed', 'control.retry_tick_overflow'].includes(result.code);
}
