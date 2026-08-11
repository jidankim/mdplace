import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  baseMatches,
  canonicalJson,
  compareCanonicalText,
  isRecognizedOperationKind,
  isSemanticWriter,
  operationEffect,
  preconditionsMatch,
  snapshotHistoryIsCanonical,
  stateDigest,
  stateFromEntries,
} from './semantic-kernel-core.mjs';

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

export async function replayRecords(records, snapshot, boundInputs, packageRoot) {
  const state = snapshot === null ? new Map() : stateFromEntries(snapshot.semantic_state);
  let head = snapshot === null
    ? {sequence: 0, operationId: null}
    : {sequence: snapshot.sequence, operationId: snapshot.operation_id};
  if (snapshot !== null && (stateDigest(state) !== snapshot.state_digest || !snapshotHistoryIsCanonical(snapshot))) {
    return {code: 'semantic.snapshot_stale', state: new Map(), head: {sequence: 0, operationId: null}};
  }
  const parsed = [];
  for (const record of records) {
    const result = await validateRecord(record, packageRoot);
    if (result.code !== null) return {code: result.code, state, head};
    parsed.push(result.operation);
  }
  const ordered = parsed.toSorted((left, right) =>
    left.ordering.sequence - right.ordering.sequence || compareCanonicalText(left.ordering.sort_key, right.ordering.sort_key));
  const seenCommands = new Map((snapshot?.history ?? [])
    .map(({idempotency_key: key, command_digest: digest}) => [key, digest]));
  const seenOperations = new Set((snapshot?.history ?? []).map(({operation_id: operationId}) => operationId));
  for (const operation of ordered) {
    if (!isRecognizedOperationKind(operation.operation_kind)) return {code: 'semantic.operation_unknown', state, head};
    if (!isSemanticWriter(operation.actor_authority.actor_kind)) return {code: 'semantic.authority_denied', state, head};
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
