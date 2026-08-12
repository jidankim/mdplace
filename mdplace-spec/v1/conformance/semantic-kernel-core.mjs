import {createHash} from 'node:crypto';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRecognizedOperationKind(operationKind) {
  return operationKind === 'semantic_assignment' ||
    operationKind === 'semantic_removal' ||
    operationKind === 'compatibility_marker';
}

function commandPreimage({
  commandId,
  operationId,
  actorAuthority,
  operationKind,
  baseReferences,
  ordering,
  payload,
  idempotencyKey,
  preconditions,
}) {
  return {
    schema_id: 'mdplace.semantic-command-preimage/v1',
    command_id: commandId,
    operation_id: operationId,
    actor_authority: actorAuthority,
    operation_kind: operationKind,
    base_references: baseReferences,
    ordering,
    payload,
    idempotency_key: idempotencyKey,
    preconditions,
  };
}

export function commandDigestFromAction(action) {
  return canonicalDigest(commandPreimage({
    commandId: action.command_id,
    operationId: action.operation_id,
    actorAuthority: action.actor,
    operationKind: action.operation_kind,
    baseReferences: action.base_references,
    ordering: action.ordering,
    payload: action.payload,
    idempotencyKey: action.idempotency_key,
    preconditions: action.preconditions,
  }));
}

export function commandDigestFromOperation(operation) {
  return canonicalDigest(commandPreimage({
    commandId: operation.command_id,
    operationId: operation.operation_id,
    actorAuthority: operation.actor_authority,
    operationKind: operation.operation_kind,
    baseReferences: operation.base_references,
    ordering: operation.ordering,
    payload: operation.payload,
    idempotencyKey: operation.idempotency.key,
    preconditions: operation.preconditions,
  }));
}

export function operationDigest(operation) {
  const preimage = {...operation};
  delete preimage.operation_digest;
  return canonicalDigest(preimage);
}

export function stateEntries(state) {
  return [...state.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([key, value]) => ({key, value}));
}

export function stateEntriesAreCanonical(entries) {
  return entries.every(({key}, index) => index === 0 || compareCanonicalText(entries[index - 1].key, key) < 0);
}

export function stateDigest(state) {
  return createHash('sha256').update(canonicalJson(stateEntries(state))).digest('hex');
}

export function stateLabel(state) {
  return canonicalJson(stateEntries(state));
}

export function stateFromEntries(entries) {
  return new Map(entries.map(({key, value}) => [key, value]));
}

export function snapshotHistoryDigest(history) {
  return createHash('sha256').update(canonicalJson(history)).digest('hex');
}

export function snapshotHistoryIsCanonical(snapshot) {
  const history = snapshot.history;
  if (history.length !== snapshot.sequence || snapshotHistoryDigest(history) !== snapshot.history_digest) return false;
  const operationIds = new Set();
  const idempotencyKeys = new Set();
  for (const [index, entry] of history.entries()) {
    if (entry.sequence !== index + 1 || operationIds.has(entry.operation_id) ||
        idempotencyKeys.has(entry.idempotency_key)) return false;
    operationIds.add(entry.operation_id);
    idempotencyKeys.add(entry.idempotency_key);
  }
  return (history.at(-1)?.operation_id ?? null) === snapshot.operation_id;
}

export function baseMatches(baseReferences, head, state, boundInputs = []) {
  if (baseReferences.length === 0) return false;
  if (baseReferences.some(({ordinal}, index) => ordinal !== index)) return false;
  const base = baseReferences[0];
  const headMatches = base.kind === 'semantic_head' && base.sequence === head.sequence &&
    base.operation_id === head.operationId && base.state_digest === stateDigest(state);
  const inputsMatch = baseReferences.slice(1).every(({kind, ref_id: refId, digest}, index) => {
    const input = boundInputs[index];
    return kind === 'bound_input' && input?.ref_id === refId && input.digest === digest;
  });
  return headMatches && inputsMatch && baseReferences.length === boundInputs.length + 1;
}

export function preconditionsMatch(preconditions, state) {
  return preconditions.every(({ordinal, key, expected_value: expectedValue}, index) =>
    ordinal === index && (state.get(key) ?? null) === expectedValue);
}

export function operationEffect(operation, state) {
  const nextState = new Map(state);
  const eventIds = new Set();
  for (const [index, event] of operation.payload.events.entries()) {
    if (event.schema_version !== '1.0.0') return {code: 'semantic.schema_version_unsupported', state};
    if (event.ordinal !== index || eventIds.has(event.event_id) ||
        event.event_kind !== operation.operation_kind) {
      return {code: 'semantic.event_invalid', state};
    }
    eventIds.add(event.event_id);
    switch (event.event_kind) {
      case 'semantic_assignment':
        nextState.set(event.payload.key, event.payload.value);
        break;
      case 'semantic_removal':
        if (!nextState.has(event.payload.key)) return {code: 'semantic.illegal_transition', state};
        nextState.delete(event.payload.key);
        break;
      case 'compatibility_marker':
        break;
      default:
        return {code: 'semantic.operation_unknown', state};
    }
  }
  return {code: null, state: nextState};
}

export function operationFromAction(action, state) {
  const effect = operationEffect({operation_kind: action.operation_kind, payload: action.payload}, state);
  if (effect.code !== null) return {code: effect.code, operation: null, state};
  const receiptId = `receipt:${action.command_id.slice('command:'.length)}`;
  const operation = {
    $schema: 'semantic-operation.schema.json',
    schema_id: 'mdplace.semantic-operation/v1',
    operation_id: action.operation_id,
    schema_version: '1.0.0',
    command_id: action.command_id,
    actor_authority: action.actor,
    operation_kind: action.operation_kind,
    base_references: action.base_references,
    ordering: action.ordering,
    payload: action.payload,
    idempotency: {key: action.idempotency_key, command_digest: commandDigestFromAction(action)},
    preconditions: action.preconditions,
    closure_receipt: {
      receipt_id: receiptId,
      command_id: action.command_id,
      operation_id: action.operation_id,
      outcome: 'accepted',
      sequence: action.ordering.sequence,
      state_digest: stateDigest(effect.state),
    },
  };
  operation.operation_digest = operationDigest(operation);
  return {
    code: null,
    state: effect.state,
    operation,
  };
}
