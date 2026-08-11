import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  baseMatches,
  isRecognizedOperationKind,
  isSemanticWriter,
  operationFromAction,
  preconditionsMatch,
  stateEntriesAreCanonical,
  stateFromEntries,
  stateLabel,
} from './semantic-kernel-core.mjs';
import {semanticRecoveryReceipt, semanticRejectionReceipt} from './semantic-kernel-receipts.mjs';
import {replayRecords} from './semantic-kernel-replay.mjs';

function observed({verdict, codes = [], outputs, operations, receipts, effects = ['none'], terminal = 'ready', illegal = false}) {
  return {verdict, codes, outputs, operations, receipts, filesystem_effects: effects, terminal_state: terminal, illegal_transition: illegal};
}

function rejected(code, document, state, {terminal = 'ready', illegal = false, operation = 'validate append command'} = {}) {
  return observed({
    verdict: 'fail', codes: [code],
    outputs: ['append rejected', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
    operations: [operation], receipts: [semanticRejectionReceipt(code, document, state)], terminal, illegal,
  });
}

function observeAppend(document) {
  const {action, initial} = document;
  const state = stateFromEntries(initial.semantic_state);
  if (initial.lifecycle_state !== 'ready') return rejected('semantic.recovery_required', document, state, {terminal: 'recovery_required', illegal: true});
  if (!isRecognizedOperationKind(action.operation_kind)) return rejected('semantic.operation_unknown', document, state);
  if (!isSemanticWriter(action.actor.actor_kind)) return rejected('semantic.authority_denied', document, state);
  const prior = initial.prior_receipts.find(({idempotency_key: key}) => key === action.idempotency_key);
  if (prior !== undefined) {
    if (prior.command_digest !== action.command_digest) return rejected('semantic.idempotency_incompatible', document, state);
    return observed({
      verdict: 'pass', outputs: ['append idempotent', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['validate actor authority', 'resolve idempotency material'],
      receipts: [`SemanticAppendReceipt:${prior.receipt_id}`],
    });
  }
  if (!baseMatches(action.base_references, {sequence: initial.head.sequence, operationId: initial.head.operation_id}, state, initial.bound_inputs)) {
    return rejected('semantic.base_stale', document, state);
  }
  if (action.ordering?.sequence !== initial.head.sequence + 1 ||
      action.ordering?.predecessor_operation_id !== initial.head.operation_id) {
    return rejected('semantic.ordering_invalid', document, state);
  }
  if (!preconditionsMatch(action.preconditions, state)) return rejected('semantic.precondition_failed', document, state);
  const result = operationFromAction(action, state);
  if (result.code !== null) return rejected(result.code, document, state, {illegal: result.code === 'semantic.illegal_transition'});
  return observed({
    verdict: 'pass',
    outputs: ['append accepted', `canonical_record:${result.operation.operation_id}`, `semantic_state:${stateLabel(result.state)}`, `snapshot_state:${stateLabel(result.state)}`],
    operations: ['validate actor authority', 'resolve idempotency material', 'compare exact semantic head', 'validate operation preconditions', 'append canonical operation'],
    receipts: [`SemanticAppendReceipt:${result.operation.closure_receipt.receipt_id}`],
    effects: ['append one immutable canonical operation'],
  });
}

async function observeReplay(document, packageRoot, rebuild = false) {
  const result = await replayRecords(document.action.records, document.action.snapshot, document.initial.bound_inputs, packageRoot);
  if (result.code !== null) {
    const state = stateLabel(result.state);
    return observed({
      verdict: 'fail', codes: [result.code], outputs: ['replay rejected', `semantic_state:${state}`],
      operations: ['validate canonical operation records'],
      receipts: [semanticRejectionReceipt(result.code, document, result.state, result.head)],
      terminal: 'recovery_required',
    });
  }
  const state = stateLabel(result.state);
  if (rebuild) {
    return observed({
      verdict: 'pass', outputs: ['view rebuilt', `semantic_state:${state}`, `rebuilt_view:${state}`],
      operations: ['validate canonical operation records', 'order operations deterministically', 'replay semantic state', 'rebuild disposable view'],
      receipts: ['SemanticRebuildReceipt'],
    });
  }
  return observed({
    verdict: 'pass', outputs: ['replay accepted', `semantic_state:${state}`, `snapshot_state:${state}`],
    operations: ['validate canonical operation records', 'order operations deterministically', 'replay semantic state', 'emit Semantic Snapshot'],
    receipts: ['SemanticReplayReceipt'],
  });
}

async function observeRecovery(document, packageRoot) {
  const state = stateFromEntries(document.initial.semantic_state);
  if (document.initial.lifecycle_state !== 'recovery_required') {
    return observed({
      verdict: 'fail', codes: ['semantic.recovery_not_required'],
      outputs: ['recovery rejected', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['validate recovery state'],
      receipts: [semanticRejectionReceipt('semantic.recovery_not_required', document, state)], illegal: true,
    });
  }
  if (document.action.actor.actor_kind !== 'foreground_recovery') {
    return observed({
      verdict: 'fail', codes: ['semantic.authority_denied'],
      outputs: ['recovery rejected', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['validate recovery authority'],
      receipts: [semanticRejectionReceipt('semantic.authority_denied', document, state)], terminal: 'recovery_required',
    });
  }
  if (document.action.crash_point === 'before_record_publish') {
    const effects = ['discard uncommitted staging record'];
    return observed({
      verdict: 'pass', outputs: ['recovery completed', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['read crash journal', 'inspect canonical namespace', 'discard uncommitted staging record'],
      receipts: [semanticRecoveryReceipt(document, state, null, effects)], effects,
    });
  }
  const replayed = await replayRecords(document.action.records, null, document.initial.bound_inputs, packageRoot);
  if (replayed.code !== null) return rejected(replayed.code, document, state, {terminal: 'recovery_required', operation: 'validate published canonical record'});
  const operation = JSON.parse(document.action.records[0]);
  const effects = ['preserve canonical operation', 'publish missing closure receipt'];
  return observed({
    verdict: 'pass', outputs: ['recovery completed', `canonical_record:${operation.operation_id}`, `semantic_state:${stateLabel(replayed.state)}`],
    operations: ['read crash journal', 'validate published canonical record', 'publish missing closure receipt'],
    receipts: [`SemanticAppendReceipt:${operation.closure_receipt.receipt_id}`, semanticRecoveryReceipt(document, replayed.state, operation, effects)],
    effects,
  });
}

export async function observeSemanticKernelScenario(subject, packageRoot) {
  const errors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  const schemaCode = schemaErrorCode(errors);
  if (schemaCode !== null) {
    return observed({
      verdict: 'fail', codes: [schemaCode], outputs: ['scenario rejected'],
      operations: ['validate Semantic Kernel scenario'], receipts: ['SemanticRejectionReceipt'], terminal: 'rejected',
    });
  }
  const {document} = subject;
  if (!stateEntriesAreCanonical(document.initial.semantic_state) ||
      (document.action.snapshot !== null && !stateEntriesAreCanonical(document.action.snapshot.semantic_state))) {
    return observed({
      verdict: 'fail', codes: ['semantic.state_noncanonical'], outputs: ['scenario rejected'],
      operations: ['validate ordered semantic state'], receipts: ['SemanticRejectionReceipt'], terminal: 'rejected',
    });
  }
  switch (document.action.kind) {
    case 'append': return observeAppend(document);
    case 'replay': return observeReplay(document, packageRoot);
    case 'rebuild_view': return observeReplay(document, packageRoot, true);
    case 'recover': return observeRecovery(document, packageRoot);
    default: throw new Error('scenario schema allowed an unknown action');
  }
}
