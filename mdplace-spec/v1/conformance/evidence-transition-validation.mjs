import {isDeepStrictEqual} from 'node:util';

import {isRecord, observation, readJson} from './evidence-core.mjs';
import {
  freshClaimIsNew,
  hasFreshMandatoryEvidence,
  recordedClaimCodes,
  validateClaimBinding,
} from './evidence-freshness.mjs';
import {validateRecoveryReportBinding} from './evidence-recovery-validation.mjs';

function denied(codes, operations, terminalState, output = 'evidence transition denied') {
  return observation({verdict: 'fail', codes, output, operations, terminalState, illegalTransition: true});
}

export async function observeTransitionAttempt(document, packageRoot, operations, context, observeNested) {
  const table = await readJson(packageRoot, document.table_ref);
  const rows = Array.isArray(table?.transitions) ? table.transitions : [];
  const row = rows.find((candidate) => isRecord(candidate) &&
    candidate.from_state === document.from_state && candidate.command_or_event === document.command);
  if (row === undefined) {
    return observation({
      verdict: 'fail',
      codes: ['evidence.transition_unresolved'],
      output: 'evidence transition rejected',
      operations,
      terminalState: 'rejected',
    });
  }
  if (row.actor_authority !== undefined && !isDeepStrictEqual(row.actor_authority, document.actor_authority)) {
    return denied(['evidence.authority_denied'], operations, document.from_state);
  }
  if (row.allowed !== true) return denied(['evidence.transition_denied'], operations, row.terminal_state);
  const freshnessCommand = ['record_verdict', 'supply_fresh_evidence'].includes(document.command);
  if (freshnessCommand && (document.fresh_evidence_supplied !== true || !isRecord(document.fresh_claim))) {
    return denied(['evidence.fresh_evidence_required'], operations, document.from_state);
  }
  if ((!freshnessCommand &&
       (document.fresh_evidence_supplied !== false || document.fresh_claim !== null)) ||
      (document.command !== 'supply_fresh_evidence' && document.recorded_claim !== null) ||
      (document.command === 'supply_fresh_evidence' && document.from_state === 'awaiting_evidence' &&
       document.recorded_claim !== null) ||
      (document.command === 'supply_fresh_evidence' && document.recovery_report !== null)) {
    return denied(['evidence.fresh_evidence_inconsistent'], operations, document.from_state);
  }
  if (['readback', 'mark_stale'].includes(document.command)) {
    if (!isRecord(document.recovery_report)) {
      return denied(['evidence.recovery_report_required'], operations, document.from_state);
    }
    const recovery = await validateRecoveryReportBinding(
      document.recovery_report,
      packageRoot,
      context,
      observeNested,
    );
    const expectedState = document.command === 'mark_stale' ? 'evidence_stale' : row.terminal_state;
    if (recovery.codes.length > 0 || recovery.observed?.terminal_state !== expectedState) {
      return denied(['evidence.recovery_report_invalid', ...recovery.codes], operations, document.from_state);
    }
  }
  if (freshnessCommand) {
    const freshClaim = await validateClaimBinding(
      document.fresh_claim,
      document.fresh_claim.claim_id,
      packageRoot,
      context,
      observeNested,
    );
    if (freshClaim.codes.length > 0 || !hasFreshMandatoryEvidence(freshClaim.document)) {
      return denied(
        ['evidence.fresh_evidence_required', ...freshClaim.codes],
        operations,
        document.from_state,
      );
    }
    if (document.command === 'record_verdict') {
      if (!isRecord(document.recovery_report)) {
        return denied(['evidence.recovery_report_required'], operations, document.from_state);
      }
      const recovery = await validateRecoveryReportBinding(
        document.recovery_report,
        packageRoot,
        context,
        observeNested,
      );
      if (recovery.codes.length > 0 || recovery.observed?.terminal_state !== 'awaiting_evidence' ||
          recovery.document?.fresh_evidence_supplied !== true ||
          !isDeepStrictEqual(recovery.document?.claim, document.fresh_claim)) {
        return denied(['evidence.recovery_report_invalid', ...recovery.codes], operations, document.from_state);
      }
    }
    if (document.command === 'supply_fresh_evidence' && document.from_state !== 'awaiting_evidence') {
      const staleState = document.from_state === 'evidence_stale';
      const recordedClaim = await validateClaimBinding(
        document.recorded_claim,
        document.fresh_claim.claim_id,
        packageRoot,
        context,
        observeNested,
        {retainSemanticFailure: staleState},
      );
      const recordedCodes = recordedClaimCodes(recordedClaim.codes, staleState);
      if (recordedClaim.document === null || recordedCodes.length > 0) {
        return denied(
          ['evidence.recorded_claim_required', ...recordedCodes],
          operations,
          document.from_state,
        );
      }
      if (document.recorded_claim.sha256 === document.fresh_claim.sha256 ||
          !await freshClaimIsNew(
            document.recorded_claim,
            recordedClaim.document,
            freshClaim.document,
            packageRoot,
          )) {
        return denied(['evidence.fresh_evidence_replayed'], operations, document.from_state);
      }
    }
  }
  return observation({
    verdict: 'pass',
    output: 'evidence transition accepted',
    operations,
    terminalState: row.terminal_state,
  });
}
