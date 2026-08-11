import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  baseMatches,
  canonicalJson,
  compareCanonicalText,
  isRecognizedOperationKind,
  operationEffect,
  operationFromAction,
  preconditionsMatch,
  stateDigest,
  stateFromEntries,
  stateLabel,
} from './semantic-kernel-core.mjs';

const appendActors = new Set(['vault_owner', 'mdplace_agent']);

function observed({verdict, codes = [], outputs, operations, receipts, effects = ['none'], terminal = 'ready', illegal = false}) {
  return {verdict, codes, outputs, operations, receipts, filesystem_effects: effects, terminal_state: terminal, illegal_transition: illegal};
}

function rejected(code, state, {terminal = 'ready', illegal = false, operation = 'validate append command'} = {}) {
  return observed({
    verdict: 'fail', codes: [code],
    outputs: ['append rejected', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
    operations: [operation], receipts: ['SemanticRejectionReceipt'], terminal, illegal,
  });
}

async function validateRecord(record, packageRoot) {
  let operation;
  try {
    operation = JSON.parse(record);
  } catch {
    return {code: 'semantic.record_torn', operation: null};
  }
  if (`${canonicalJson(operation)}\n` !== record) return {code: 'semantic.record_noncanonical', operation: null};
  const errors = await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/semantic-operation.schema.json', operation);
  if (schemaErrorCode(errors) !== null) return {code: 'semantic.record_malformed', operation: null};
  if (operation.schema_version !== '1.0.0') return {code: 'semantic.schema_version_unsupported', operation: null};
  return {code: null, operation};
}

async function replayRecords(records, snapshot, boundInputs, packageRoot) {
  const parsed = [];
  for (const record of records) {
    const result = await validateRecord(record, packageRoot);
    if (result.code !== null) return {code: result.code, state: new Map(), head: null};
    parsed.push(result.operation);
  }
  const ordered = parsed.toSorted((left, right) =>
    left.ordering.sequence - right.ordering.sequence || compareCanonicalText(left.ordering.sort_key, right.ordering.sort_key));
  const state = snapshot === null ? new Map() : stateFromEntries(snapshot.semantic_state);
  let head = snapshot === null
    ? {sequence: 0, operationId: null}
    : {sequence: snapshot.sequence, operationId: snapshot.operation_id};
  if (snapshot !== null && stateDigest(state) !== snapshot.state_digest) {
    return {code: 'semantic.snapshot_stale', state, head};
  }
  const seenCommands = new Map();
  const seenOperations = new Set();
  for (const operation of ordered) {
    if (!isRecognizedOperationKind(operation.operation_kind)) return {code: 'semantic.operation_unknown', state, head};
    if (!appendActors.has(operation.actor_authority.actor_kind)) return {code: 'semantic.authority_denied', state, head};
    const priorDigest = seenCommands.get(operation.idempotency.key);
    if (priorDigest !== undefined && priorDigest !== operation.idempotency.command_digest) {
      return {code: 'semantic.idempotency_incompatible', state, head};
    }
    if (priorDigest !== undefined || seenOperations.has(operation.operation_id)) {
      return {code: 'semantic.operation_duplicate', state, head};
    }
    if (!baseMatches(operation.base_references, head, state, boundInputs)) return {code: 'semantic.base_stale', state, head};
    if (operation.ordering.sequence !== head.sequence + 1 ||
        operation.ordering.predecessor_operation_id !== head.operationId) {
      return {code: 'semantic.ordering_invalid', state, head};
    }
    if (!preconditionsMatch(operation.preconditions, state)) return {code: 'semantic.precondition_failed', state, head};
    const effect = operationEffect(operation, state);
    if (effect.code !== null) return {code: effect.code, state, head};
    if (operation.closure_receipt.command_id !== operation.command_id ||
        operation.closure_receipt.operation_id !== operation.operation_id ||
        operation.closure_receipt.sequence !== operation.ordering.sequence ||
        operation.closure_receipt.state_digest !== stateDigest(effect.state)) {
      return {code: 'semantic.receipt_invalid', state, head};
    }
    state.clear();
    for (const [key, value] of effect.state) state.set(key, value);
    head = {sequence: operation.ordering.sequence, operationId: operation.operation_id};
    seenCommands.set(operation.idempotency.key, operation.idempotency.command_digest);
    seenOperations.add(operation.operation_id);
  }
  return {code: null, state, head};
}

function observeAppend(document) {
  const {action, initial} = document;
  const state = stateFromEntries(initial.semantic_state);
  if (initial.lifecycle_state !== 'ready') return rejected('semantic.recovery_required', state, {terminal: 'recovery_required', illegal: true});
  if (!isRecognizedOperationKind(action.operation_kind)) return rejected('semantic.operation_unknown', state);
  if (!appendActors.has(action.actor.actor_kind)) return rejected('semantic.authority_denied', state);
  const prior = initial.prior_receipts.find(({idempotency_key: key}) => key === action.idempotency_key);
  if (prior !== undefined) {
    if (prior.command_digest !== action.command_digest) return rejected('semantic.idempotency_incompatible', state);
    return observed({
      verdict: 'pass', outputs: ['append idempotent', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['validate actor authority', 'resolve idempotency material'],
      receipts: [`SemanticAppendReceipt:${prior.receipt_id}`],
    });
  }
  if (!baseMatches(action.base_references, {sequence: initial.head.sequence, operationId: initial.head.operation_id}, state, initial.bound_inputs)) {
    return rejected('semantic.base_stale', state);
  }
  if (action.ordering?.sequence !== initial.head.sequence + 1 ||
      action.ordering?.predecessor_operation_id !== initial.head.operation_id) {
    return rejected('semantic.ordering_invalid', state);
  }
  if (!preconditionsMatch(action.preconditions, state)) return rejected('semantic.precondition_failed', state);
  const result = operationFromAction(action, state);
  if (result.code !== null) return rejected(result.code, state, {illegal: result.code === 'semantic.illegal_transition'});
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
    return observed({
      verdict: 'fail', codes: [result.code], outputs: ['replay rejected', 'semantic_state:[]'],
      operations: ['validate canonical operation records'], receipts: ['SemanticRejectionReceipt'], terminal: 'recovery_required',
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
      operations: ['validate recovery state'], receipts: ['SemanticRejectionReceipt'], illegal: true,
    });
  }
  if (document.action.actor.actor_kind !== 'foreground_recovery') {
    return observed({
      verdict: 'fail', codes: ['semantic.authority_denied'],
      outputs: ['recovery rejected', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['validate recovery authority'], receipts: ['SemanticRejectionReceipt'], terminal: 'recovery_required',
    });
  }
  if (document.action.crash_point === 'before_record_publish') {
    return observed({
      verdict: 'pass', outputs: ['recovery completed', 'canonical_record:none', `semantic_state:${stateLabel(state)}`],
      operations: ['read crash journal', 'inspect canonical namespace', 'discard uncommitted staging record'],
      receipts: ['SemanticRecoveryReport'], effects: ['discard uncommitted staging record'],
    });
  }
  const replayed = await replayRecords(document.action.records, null, document.initial.bound_inputs, packageRoot);
  if (replayed.code !== null) return rejected(replayed.code, state, {terminal: 'recovery_required', operation: 'validate published canonical record'});
  const operation = JSON.parse(document.action.records[0]);
  return observed({
    verdict: 'pass', outputs: ['recovery completed', `canonical_record:${operation.operation_id}`, `semantic_state:${stateLabel(replayed.state)}`],
    operations: ['read crash journal', 'validate published canonical record', 'publish missing closure receipt'],
    receipts: [`SemanticAppendReceipt:${operation.closure_receipt.receipt_id}`, 'SemanticRecoveryReport'],
    effects: ['preserve canonical operation', 'publish missing closure receipt'],
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
  switch (subject.document.action.kind) {
    case 'append': return observeAppend(subject.document);
    case 'replay': return observeReplay(subject.document, packageRoot);
    case 'rebuild_view': return observeReplay(subject.document, packageRoot, true);
    case 'recover': return observeRecovery(subject.document, packageRoot);
    default: throw new Error('scenario schema allowed an unknown action');
  }
}
