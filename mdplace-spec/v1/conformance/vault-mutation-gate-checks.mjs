import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {
  authorizedMutationPlanDigest,
  mutationJournalDigest,
  mutationJournalEntryDigest,
  operationReceiptDigest,
} from './vault-mutation-digests.mjs';
import {
  boundaryModeEvidenceIsValid,
  matrixRecoveryRowsAreValid,
} from './vault-mutation-recovery-checks.mjs';

const requiredFaults = new Set([
  'symlink_swap', 'pathname_swap', 'traversal', 'collision', 'ownership_drift',
  'unauthorized_caller', 'undeclared_operation', 'malformed_plan', 'stale_plan',
  'stale_hash', 'identity_drift', 'size_drift', 'incomplete_journal',
  'receipt_echo_mismatch', 'readback_mismatch', 'misleading_success', 'idempotency_conflict',
]);

const requiredCategories = new Set([
  'positive', 'negative', 'exact_boundary', 'stale_state', 'authority_denial',
  'illegal_transition', 'crash_recovery',
]);

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'vault-mutation-gate-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {document: null, content: null};
  try {
    return {document: JSON.parse(read.content.toString('utf8')), content: read.content};
  } catch {
    return {document: null, content: read.content};
  }
}

function tableIsComplete(table) {
  const states = Array.isArray(table?.states) ? table.states : [];
  const commands = Array.isArray(table?.commands) ? table.commands : [];
  const rows = Array.isArray(table?.transitions) ? table.transitions : [];
  const validRows = rows.filter(isRecord);
  const pairs = validRows.map(({from_state: state, command_or_event: command}) => `${state}:${command}`);
  return validRows.length === rows.length && rows.length === states.length * commands.length &&
    new Set(pairs).size === rows.length &&
    states.every((state) => commands.every((command) => pairs.includes(`${state}:${command}`)));
}

const committedJournalEvents = [
  'prepared', 'validated', 'data_mutated', 'metadata_synced',
  'receipt_published', 'echo_published', 'readback_verified', 'committed',
];

function journalEventOrderIsValid(journal) {
  if (!Array.isArray(journal?.entries) || !journal.entries.every(isRecord)) return false;
  const events = journal.entries.map(({event}) => event);
  const terminalRecoveryEvent = new Map([
    ['recovery_required', null],
    ['rolled_back', 'rolled_back'],
    ['compensated', 'compensated'],
    ['terminal_manual_repair', 'terminal_manual_repair'],
  ]).get(journal.state);
  if (journal.state === 'recovery_required' || terminalRecoveryEvent !== undefined) {
    const recoveryIndex = events.indexOf('recovery_required');
    const prefix = events.slice(0, recoveryIndex);
    const suffix = events.slice(recoveryIndex);
    const expectedSuffix = terminalRecoveryEvent === null
      ? ['recovery_required']
      : ['recovery_required', terminalRecoveryEvent];
    return recoveryIndex > 0 && isDeepStrictEqual(prefix, committedJournalEvents.slice(0, prefix.length)) &&
      isDeepStrictEqual(suffix, expectedSuffix);
  }
  const allowedLengths = new Map([
    ['prepared', [1]],
    ['validated', [2]],
    ['mutated', [3, 4]],
    ['receipt_recorded', [5, 6]],
    ['readback_verified', [7]],
    ['committed', [8]],
  ]).get(journal.state) ?? [];
  return allowedLengths.includes(events.length) &&
    isDeepStrictEqual(events, committedJournalEvents.slice(0, events.length));
}

export async function checkVaultMutationGateContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const documents = new Map();
  const bindings = [
    ['contracts/vault-mutation-gate/authorized-plan.json', 'contracts/schemas/authorized-mutation-plan.schema.json'],
    ['contracts/vault-mutation-gate/operation-receipt.json', 'contracts/schemas/operation-receipt.schema.json'],
    ['contracts/vault-mutation-gate/mutation-journal.json', 'contracts/schemas/mutation-journal.schema.json'],
    ['contracts/vault-mutation-gate/crash-boundary-matrix.json', 'contracts/schemas/vault-mutation-crash-matrix.schema.json'],
    ['conformance/evidence/vault-mutation-recovery-report.json', 'contracts/schemas/vault-mutation-recovery-report.schema.json'],
  ];
  for (const [path, schema] of bindings) {
    const {document} = await readJson(packageRoot, path);
    if (document === null) {
      codes.push('vault_mutation.artifact_missing');
      continue;
    }
    documents.set(path, document);
    const schemaCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schema, document));
    if (schemaCode !== null) codes.push(schemaCode);
  }

  const plan = documents.get('contracts/vault-mutation-gate/authorized-plan.json');
  const receipt = documents.get('contracts/vault-mutation-gate/operation-receipt.json');
  const journal = documents.get('contracts/vault-mutation-gate/mutation-journal.json');
  const journalEntries = Array.isArray(journal?.entries) ? journal.entries : [];
  const digestsAreValid = plan !== undefined && receipt !== undefined && journal !== undefined &&
    authorizedMutationPlanDigest(plan) === plan?.immutable_inputs?.plan_sha256 &&
    journalEntries.every((entry) => isRecord(entry) &&
      mutationJournalEntryDigest(entry) === entry.entry_sha256) &&
    mutationJournalDigest(journal) === journal.journal_sha256 &&
    operationReceiptDigest(receipt) === receipt.receipt_sha256;
  if (!digestsAreValid) codes.push('vault_mutation.digest_invalid');
  const planBindingsMatch = plan !== undefined && receipt !== undefined && journal !== undefined &&
    receipt?.plan_id === plan?.plan_id && receipt?.plan_sha256 === plan?.immutable_inputs?.plan_sha256 &&
    receipt?.operation === plan?.operation && receipt?.caller_id === plan?.caller?.caller_id &&
    receipt?.ownership_receipt_sha256 === plan?.ownership?.exclusive_writer_receipt_sha256 &&
    receipt?.idempotency_key === plan?.idempotency_key &&
    isDeepStrictEqual(receipt?.source_components, plan?.source_components) &&
    isDeepStrictEqual(receipt?.target_components, plan?.target_components) &&
    isDeepStrictEqual(receipt?.precondition_identity, plan?.expected_precondition) &&
    isDeepStrictEqual(receipt?.result_identity, plan?.expected_result) &&
    journal?.plan_id === plan?.plan_id && journal?.plan_sha256 === plan?.immutable_inputs?.plan_sha256 &&
    journal?.ownership_receipt_sha256 === plan?.ownership?.exclusive_writer_receipt_sha256 &&
    journal?.idempotency_key === plan?.idempotency_key && receipt?.journal_sha256 === journal?.journal_sha256;
  if (!planBindingsMatch) codes.push('vault_mutation.echo_binding_invalid');
  const scheduledWorkBindingsMatch = plan?.scheduled_work !== null &&
    isDeepStrictEqual(journal?.scheduled_work, plan?.scheduled_work) &&
    isDeepStrictEqual(receipt?.scheduled_work, plan?.scheduled_work);
  if (!scheduledWorkBindingsMatch) codes.push('vault_mutation.scheduled_work_binding_invalid');
  const expectedCallerPrefix = new Map([
    ['capture_adapter', 'capture-adapter:'],
    ['folder_projection', 'folder-projection:'],
    ['foreground_recovery', 'foreground-recovery:'],
  ]).get(plan?.caller?.role);
  if (expectedCallerPrefix === undefined || !plan?.caller?.caller_id?.startsWith(expectedCallerPrefix)) {
    codes.push('vault_mutation.caller_binding_invalid');
  }
  const journalChainValid = journalEntries.length > 0 && journalEntries.every((entry, index) => isRecord(entry) &&
    entry.sequence === index + 1 && entry.durability === 'synced' &&
    (index === 0 ? entry.previous_sha256 === '0'.repeat(64) :
      entry.previous_sha256 === journalEntries[index - 1].entry_sha256)) &&
    (journal?.state !== 'committed' || journalEntries.at(-1)?.event === 'committed');
  if (!journalChainValid) codes.push('vault_mutation.journal_chain_invalid');
  if (journal === undefined || !journalEventOrderIsValid(journal)) {
    codes.push('vault_mutation.journal_order_invalid');
  }

  const {document: table} = await readJson(packageRoot, 'contracts/transitions/vault-mutation-gate-lifecycle.json');
  if (!tableIsComplete(table) || table?.states?.length !== 11 || table?.commands?.length !== 10) {
    codes.push('vault_mutation.lifecycle_incomplete');
  }

  const entries = (Array.isArray(conformance?.fixtures) ? conformance.fixtures : [])
    .filter((entry) => isRecord(entry) && typeof entry.fixture_id === 'string' &&
      entry.fixture_id.startsWith('FIX-VMG-'));
  const scenarios = [];
  for (const entry of entries) {
    const {document: fixture} = await readJson(packageRoot, `conformance/${entry.path}`);
    if (fixture?.subject?.kind !== 'vault_mutation_gate' || fixture.fixture_id !== entry.fixture_id ||
        !isRecord(fixture.subject.document)) {
      codes.push('vault_mutation.fixture_binding_invalid');
      continue;
    }
    scenarios.push(fixture.subject.document);
    if (entry.expected_verdict === 'fail' && fixture.expected.filesystem_effects?.some((effect) =>
      effect !== 'none' && effect !== 'preserve only the declared observed effect' &&
      effect !== 'preserve observed physical state')) {
      codes.push('vault_mutation.unsafe_negative_effect');
    }
  }
  const expectedIds = Array.from({length: 88}, (_, index) => `VMG-${String(index + 1).padStart(3, '0')}`);
  const scenarioIds = scenarios.map(({scenario_id: id}) => id);
  if (entries.length !== 88 || new Set(scenarioIds).size !== 88 || expectedIds.some((id) => !scenarioIds.includes(id))) {
    codes.push('vault_mutation.scenario_inventory_invalid');
  }
  if ([...requiredCategories].some((category) => !entries.some((entry) => entry.category === category))) {
    codes.push('vault_mutation.scenario_category_missing');
  }
  const faults = new Set(scenarios.map(({fault}) => fault));
  if ([...requiredFaults].some((fault) => !faults.has(fault))) codes.push('vault_mutation.negative_coverage_missing');

  const {document: matrix, content: matrixContent} = await readJson(
    packageRoot, 'contracts/vault-mutation-gate/crash-boundary-matrix.json');
  const expectedBoundaries = ['journal', 'validation', 'data', 'metadata', 'receipt', 'echo', 'readback', 'commit']
    .flatMap((event) => [`before_${event}`, `after_${event}`]);
  const matrixBoundaries = Array.isArray(matrix?.boundaries) ? matrix.boundaries.filter(isRecord) : [];
  const boundaryIds = matrixBoundaries.map(({boundary_id: id}) => id);
  const interruptionModes = ['cancel', 'cancel_and_resume', 'restart', 'repeated_interruption'];
  const expectedBoundaryModePairs = expectedBoundaries.flatMap((boundaryId) =>
    interruptionModes.map((mode) => `${boundaryId}:${mode}`));
  if (boundaryIds.length !== 16 || new Set(boundaryIds).size !== 16 ||
      expectedBoundaries.some((id) => !boundaryIds.includes(id)) ||
      !isDeepStrictEqual(matrix?.interruption_modes, interruptionModes) ||
      !matrixRecoveryRowsAreValid(matrix, expectedBoundaryModePairs)) {
    codes.push('vault_mutation.crash_matrix_incomplete');
  }
  const {document: recovery} = await readJson(packageRoot, 'conformance/evidence/vault-mutation-recovery-report.json');
  const matrixDigest = matrixContent === null ? null : createHash('sha256').update(matrixContent).digest('hex');
  const fixtureIds = entries.map(({fixture_id: id}) => id).sort();
  const reportIds = recovery?.scenario_results?.filter(isRecord).map(({fixture_id: id}) => id).sort() ?? [];
  if (recovery?.crash_matrix_sha256 !== matrixDigest ||
      JSON.stringify(recovery?.boundary_coverage) !== JSON.stringify(expectedBoundaries) ||
      !isDeepStrictEqual(recovery?.interruption_modes, interruptionModes) ||
      JSON.stringify(reportIds) !== JSON.stringify(fixtureIds)) {
    codes.push('vault_mutation.recovery_evidence_invalid');
  }
  if (!await boundaryModeEvidenceIsValid({
    packageRoot,
    recovery,
    matrix,
    entries,
    plan,
    expectedPairs: expectedBoundaryModePairs,
  })) codes.push('vault_mutation.boundary_mode_evidence_invalid');
  const recoveryOutcomes = new Set(recovery?.scenario_results?.filter(isRecord)
    .map(({recovery_outcome: outcome}) => outcome) ?? []);
  const requiredRecoveryOutcomes = ['recovered', 'rolled_back', 'compensated', 'terminal_manual_repair'];
  if (requiredRecoveryOutcomes.some((outcome) => !recoveryOutcomes.has(outcome)) ||
      recovery?.terminal_manual_repair?.fixture_id !== 'FIX-VMG-REC-007' ||
      !Array.isArray(recovery?.terminal_manual_repair?.unresolved_evidence) ||
      recovery.terminal_manual_repair.unresolved_evidence.length === 0 ||
      typeof recovery?.terminal_manual_repair?.required_authorization !== 'string') {
    codes.push('vault_mutation.recovery_outcome_incomplete');
  }

  const decisions = new Map((traceability?.decisions ?? []).filter(isRecord)
    .map((decision) => [decision.decision_id, decision]));
  const accepted = [
    ['DEC-007', 'https://github.com/jidankim/mdplace/issues/7#issuecomment-5181591072'],
    ['DEC-026', 'https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948'],
  ];
  if (accepted.some(([id, url]) => decisions.get(id)?.url !== url ||
      decisions.get(id)?.status !== 'accepted' || decisions.get(id)?.use !== 'input_without_reopening')) {
    codes.push('vault_mutation.decision_invalid');
  }
  const records = (traceability?.records ?? []).filter((record) =>
    isRecord(record) && record.requirement_id?.startsWith('REQ-VMG-'));
  if (records.length !== 10 || records.some(({decision_ids: ids}) =>
    JSON.stringify(ids) !== JSON.stringify(['DEC-007', 'DEC-026']))) {
    codes.push('vault_mutation.traceability_invalid');
  }
  if (manifest?.validator_version !== recovery?.validator_version) codes.push('vault_mutation.version_binding_invalid');
  return result(codes);
}
