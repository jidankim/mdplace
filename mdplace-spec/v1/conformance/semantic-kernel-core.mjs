import {createHash} from 'node:crypto';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isRecognizedOperationKind(operationKind) {
  return operationKind === 'semantic_assignment' ||
    operationKind === 'semantic_removal' ||
    operationKind === 'compatibility_marker';
}

export function stateEntries(state) {
  return [...state.entries()]
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([key, value]) => ({key, value}));
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

export function baseMatches(baseReferences, head, state, boundInputs = []) {
  if (baseReferences.length === 0) return false;
  if (baseReferences.some(({ordinal}, index) => ordinal !== index)) return false;
  const base = baseReferences[0];
  const headMatches = base.kind === 'semantic_head' && base.sequence === head.sequence &&
    base.operation_id === head.operationId && base.state_digest === stateDigest(state);
  const inputsMatch = baseReferences.slice(1).every(({kind, ref_id: refId, digest}) =>
    kind === 'bound_input' && boundInputs.some((input) => input.ref_id === refId && input.digest === digest));
  return headMatches && inputsMatch && baseReferences.length === boundInputs.length + 1;
}

export function preconditionsMatch(preconditions, state) {
  return preconditions.every(({ordinal, key, expected_value: expectedValue}, index) =>
    ordinal === index && (state.get(key) ?? null) === expectedValue);
}

export function operationEffect(operation, state) {
  const nextState = new Map(state);
  switch (operation.operation_kind) {
    case 'semantic_assignment':
      if (typeof operation.payload.value !== 'string') return {code: 'semantic.payload_invalid', state};
      nextState.set(operation.payload.key, operation.payload.value);
      return {code: null, state: nextState};
    case 'semantic_removal':
      if (operation.payload.value !== null) return {code: 'semantic.payload_invalid', state};
      if (!nextState.has(operation.payload.key)) return {code: 'semantic.illegal_transition', state};
      nextState.delete(operation.payload.key);
      return {code: null, state: nextState};
    case 'compatibility_marker':
      if (operation.payload.value !== null) return {code: 'semantic.payload_invalid', state};
      return {code: null, state: nextState};
    default:
      return {code: 'semantic.operation_unknown', state};
  }
}

export function operationFromAction(action, state) {
  const effect = operationEffect({operation_kind: action.operation_kind, payload: action.payload}, state);
  if (effect.code !== null) return {code: effect.code, operation: null, state};
  const receiptId = `receipt:${action.command_id.slice('command:'.length)}`;
  return {
    code: null,
    state: effect.state,
    operation: {
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
      idempotency: {key: action.idempotency_key, command_digest: action.command_digest},
      preconditions: action.preconditions,
      closure_receipt: {
        receipt_id: receiptId,
        command_id: action.command_id,
        operation_id: action.operation_id,
        outcome: 'accepted',
        sequence: action.ordering.sequence,
        state_digest: stateDigest(effect.state),
      },
    },
  };
}
