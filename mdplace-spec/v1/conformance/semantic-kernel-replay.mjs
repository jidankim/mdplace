import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  baseMatches,
  canonicalJson,
  commandDigestFromOperation,
  compareCanonicalText,
  isRecognizedOperationKind,
  operationEffect,
  operationDigest,
  preconditionsMatch,
  snapshotHistoryIsCanonical,
  stateDigest,
  stateEntries,
} from './semantic-kernel-core.mjs';
import {semanticActorHasCapability} from './semantic-kernel-authority.mjs';

async function validateRecord(record, packageRoot) {
  let operation;
  try {
    operation = JSON.parse(record);
  } catch {
    return {code: 'semantic.record_torn', operation: null};
  }
  let canonicalRecord;
  try {
    canonicalRecord = `${canonicalJson(operation)}\n`;
  } catch {
    return {code: 'semantic.record_noncanonical', operation: null};
  }
  if (canonicalRecord !== record) return {code: 'semantic.record_noncanonical', operation: null};
  const errors = await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/semantic-operation.schema.json', operation);
  if (schemaErrorCode(errors) !== null) return {code: 'semantic.record_malformed', operation: null};
  if (operation.schema_version !== '1.0.0') return {code: 'semantic.schema_version_unsupported', operation: null};
  if (commandDigestFromOperation(operation) !== operation.idempotency.command_digest) {
    return {code: 'semantic.command_digest_invalid', operation: null};
  }
  if (operationDigest(operation) !== operation.operation_digest) {
    return {code: 'semantic.operation_digest_invalid', operation: null};
  }
  return {code: null, operation};
}

export async function replayRecords(records, snapshot, boundInputs, packageRoot) {
  let state = new Map();
  let head = {sequence: 0, operationId: null};
  let history = [];
  if (snapshot !== null) {
    if (!snapshotHistoryIsCanonical(snapshot)) return {code: 'semantic.snapshot_stale', state, head};
    const prefix = await replayRecords(snapshot.history.map(({canonical_record: record}) => record), null, boundInputs, packageRoot);
    if (prefix.code !== null || prefix.head.sequence !== snapshot.sequence ||
        prefix.head.operationId !== snapshot.operation_id || stateDigest(prefix.state) !== snapshot.state_digest ||
        canonicalJson(stateEntries(prefix.state)) !== canonicalJson(snapshot.semantic_state) ||
        canonicalJson(prefix.history) !== canonicalJson(snapshot.history)) {
      return {code: 'semantic.snapshot_stale', state, head};
    }
    state = prefix.state;
    head = prefix.head;
    history = prefix.history;
  }
  const baseState = new Map(state);
  const baseHead = {...head};
  const rejectBatch = (code) => ({code, state: new Map(baseState), head: {...baseHead}});
  const parsed = [];
  for (const record of records) {
    const result = await validateRecord(record, packageRoot);
    if (result.code !== null) return rejectBatch(result.code);
    parsed.push({operation: result.operation, canonicalRecord: record});
  }
  const ordered = parsed.toSorted(({operation: left}, {operation: right}) =>
    left.ordering.sequence - right.ordering.sequence || compareCanonicalText(left.ordering.sort_key, right.ordering.sort_key));
  const seenCommands = new Map(history
    .map(({idempotency_key: key, command_digest: digest}) => [key, digest]));
  const seenOperations = new Set(history.map(({operation_id: operationId}) => operationId));
  for (const {operation, canonicalRecord} of ordered) {
    if (!isRecognizedOperationKind(operation.operation_kind)) return rejectBatch('semantic.operation_unknown');
    if (!await semanticActorHasCapability(packageRoot, operation.actor_authority, 'append')) {
      return rejectBatch('semantic.authority_denied');
    }
    const priorDigest = seenCommands.get(operation.idempotency.key);
    if (priorDigest !== undefined && priorDigest !== operation.idempotency.command_digest) {
      return rejectBatch('semantic.idempotency_incompatible');
    }
    if (priorDigest !== undefined || seenOperations.has(operation.operation_id)) {
      return rejectBatch('semantic.operation_duplicate');
    }
    if (!baseMatches(operation.base_references, head, state, boundInputs)) return rejectBatch('semantic.base_stale');
    if (operation.ordering.sequence !== head.sequence + 1 ||
        operation.ordering.predecessor_operation_id !== head.operationId) {
      return rejectBatch('semantic.ordering_invalid');
    }
    if (!preconditionsMatch(operation.preconditions, state)) return rejectBatch('semantic.precondition_failed');
    const effect = operationEffect(operation, state);
    if (effect.code !== null) return rejectBatch(effect.code);
    if (operation.closure_receipt.command_id !== operation.command_id ||
        operation.closure_receipt.operation_id !== operation.operation_id ||
        operation.closure_receipt.sequence !== operation.ordering.sequence ||
        operation.closure_receipt.state_digest !== stateDigest(effect.state)) {
      return rejectBatch('semantic.receipt_invalid');
    }
    state.clear();
    for (const [key, value] of effect.state) state.set(key, value);
    head = {sequence: operation.ordering.sequence, operationId: operation.operation_id};
    seenCommands.set(operation.idempotency.key, operation.idempotency.command_digest);
    seenOperations.add(operation.operation_id);
    history.push({
      sequence: operation.ordering.sequence,
      operation_id: operation.operation_id,
      operation_digest: operation.operation_digest,
      idempotency_key: operation.idempotency.key,
      command_digest: operation.idempotency.command_digest,
      canonical_record: canonicalRecord,
    });
  }
  return {code: null, state, head, history};
}
