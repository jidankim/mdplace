import {canonicalJson, stateDigest} from './semantic-kernel-core.mjs';

function receiptSuffix(document) {
  return (document.action.command_id ?? document.action.recovery_id ?? `scenario:${document.scenario_id}`)
    .split(':').at(-1);
}

export function semanticRejectionReceipt(code, document, state, head = {
  sequence: document.initial.head.sequence,
  operationId: document.initial.head.operation_id,
}) {
  return canonicalJson({
    schema_id: 'mdplace.semantic-rejection-receipt/v1',
    receipt_id: `receipt:rejection-${document.scenario_id.toLowerCase()}`,
    outcome: 'rejected',
    code,
    actor_kind: document.action.actor.actor_kind,
    command_id: document.action.command_id,
    operation_id: document.action.operation_id,
    semantic_head: {
      sequence: head.sequence,
      operation_id: head.operationId,
      state_digest: stateDigest(state),
    },
    filesystem_effects: ['none'],
  });
}

export function semanticRecoveryReceipt(document, state, operation, effects) {
  return canonicalJson({
    schema_id: 'mdplace.semantic-recovery-receipt/v1',
    receipt_id: `receipt:recovery-${receiptSuffix(document)}`,
    recovery_id: document.action.recovery_id,
    outcome: 'completed',
    crash_point: document.action.crash_point,
    operation_id: operation?.operation_id ?? null,
    canonical_record_published: operation !== null,
    closure_receipt_published: operation !== null,
    state_digest: stateDigest(state),
    filesystem_effects: effects,
  });
}
