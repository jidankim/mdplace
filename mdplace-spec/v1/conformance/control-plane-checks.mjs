import {checkTransitionTable} from './package-checks.mjs';
import {childWorkInvocationIsValid} from './child-work-validation.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {controlPlaneEvidenceCodes} from './control-plane-evidence.mjs';
import {readPackageFile} from './safe-path.mjs';

const instanceBindings = [
  ['contracts/control-plane/work-journal.json', 'contracts/schemas/work-journal.schema.json'],
  ['contracts/control-plane/scheduler-state.json', 'contracts/schemas/scheduler-state.schema.json'],
  ['contracts/control-plane/agent-state.json', 'contracts/schemas/agent-state.schema.json'],
  ['contracts/control-plane/control-command.json', 'contracts/schemas/control-channel-command.schema.json'],
  ['contracts/control-plane/child-work-invocation.json', 'contracts/schemas/child-work-invocation.schema.json'],
  ['contracts/control-plane/recovery-matrix.json', 'contracts/schemas/control-plane-recovery-matrix.schema.json'],
  ['conformance/evidence/control-plane-recovery-report.json', 'contracts/schemas/control-plane-recovery-report.schema.json'],
];

const transitionPaths = [
  'contracts/transitions/work-queue-lifecycle.json',
  'contracts/transitions/retry-lifecycle.json',
  'contracts/transitions/cancellation-lifecycle.json',
  'contracts/transitions/readiness-lifecycle.json',
  'contracts/transitions/agent-lifecycle.json',
  'contracts/transitions/control-channel-lifecycle.json',
  'contracts/transitions/exclusive-writer-lifecycle.json',
];

const transitionInventories = new Map([
  ['contracts/transitions/work-queue-lifecycle.json', {
    states: ['absent', 'queued', 'leased', 'executing', 'terminal'],
    commands: ['enqueue_work', 'dispatch_work', 'acknowledge_work', 'complete_work', 'recover_work'],
  }],
  ['contracts/transitions/retry-lifecycle.json', {
    states: ['executing', 'retry_wait', 'failed'],
    commands: ['record_retry', 'record_terminal_failure', 'retry_work'],
  }],
  ['contracts/transitions/cancellation-lifecycle.json', {
    states: ['queued', 'leased', 'executing', 'retry_wait', 'cancelled', 'succeeded', 'failed'],
    commands: ['cancel_work', 'resume_work'],
  }],
  ['contracts/transitions/readiness-lifecycle.json', {
    states: ['starting', 'ready', 'blocked'], commands: ['evaluate_readiness', 'dependency_lost'],
  }],
  ['contracts/transitions/agent-lifecycle.json', {
    states: ['stopped', 'starting', 'recovering', 'ready', 'draining', 'blocked'],
    commands: ['start_agent', 'crash_agent', 'recover_agent', 'stop_agent'],
  }],
  ['contracts/transitions/control-channel-lifecycle.json', {
    states: ['closed', 'open'], commands: ['open_control_channel', 'submit_control_command', 'close_control_channel'],
  }],
  ['contracts/transitions/exclusive-writer-lifecycle.json', {
    states: ['unheld', 'held'], commands: ['acquire_writer', 'retain_writer', 'release_writer'],
  }],
]);

const recoveryCaseIds = Array.from({length: 15}, (_, index) => `RC-CP-${String(index + 1).padStart(3, '0')}`);

function sameOrder(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function duplicate(values) {
  return new Set(values).size !== values.length;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workJournalStateValid(journal) {
  if (!Array.isArray(journal?.work_items) || !Array.isArray(journal?.receipts)) return false;
  if (journal.work_items.some((work) => !record(work)) || journal.receipts.some((receipt) => !record(receipt))) return false;
  const workIds = journal.work_items.map((work) => work.work_id);
  const idempotencyKeys = journal.work_items.map((work) => work.idempotency_key);
  const receiptIds = journal.receipts.map((receipt) => receipt.receipt_id);
  const sequences = journal.receipts.map((receipt) => receipt.journal_sequence);
  if (duplicate(workIds) || duplicate(idempotencyKeys) || duplicate(receiptIds) || duplicate(sequences) ||
      sequences.some((sequence) => sequence > journal.head_sequence)) return false;
  const workById = new Map(journal.work_items.map((work) => [work.work_id, work]));
  if (journal.receipts.some((receipt) => {
    const work = workById.get(receipt.work_id);
    return work === undefined || receipt.work_version > work.work_version;
  })) return false;
  return journal.work_items.every((work) => {
    const leaseBound = ['leased', 'executing'].includes(work.state);
    const leaseValid = leaseBound
      ? work.lease !== null && work.lease.work_id === work.work_id &&
        work.lease.work_version === work.work_version && work.lease.expires_tick > work.lease.acquired_tick &&
        work.lease.expires_tick - work.lease.acquired_tick <= journal.limits.lease_duration_ticks
      : work.lease === null;
    const retryValid = work.state === 'retry_wait'
      ? Number.isInteger(work.retry_eligible_tick)
      : work.retry_eligible_tick === null;
    const terminal = ['cancelled', 'succeeded', 'failed'].includes(work.state);
    const resultValid = terminal
      ? work.result !== null && work.result.outcome === work.state && work.result.work_version === work.work_version &&
        work.result.journal_sequence <= journal.head_sequence &&
        work.result.authenticated === true && typeof work.result.signer_agent_id === 'string' &&
        work.result.signer_agent_id.startsWith('agent:')
      : work.result === null;
    return leaseValid && retryValid && resultValid &&
      work.recovery_interruption_count <= journal.limits.max_recovery_interruptions;
  });
}

function schedulerStateValid(scheduler) {
  if (!Array.isArray(scheduler?.eligible_queue) || !Array.isArray(scheduler?.active_leases)) return false;
  if (scheduler.eligible_queue.some((entry) => !record(entry)) || scheduler.active_leases.some((lease) => !record(lease))) return false;
  const queuedIds = scheduler.eligible_queue.map((entry) => entry.work_id);
  const leasedIds = scheduler.active_leases.map((lease) => lease.lease_id);
  const leasedWorkIds = scheduler.active_leases.map((lease) => lease.work_id);
  return !duplicate(queuedIds) && !duplicate(leasedIds) && !duplicate(leasedWorkIds) &&
    scheduler.active_leases.length <= scheduler.limits.max_concurrent_work &&
    queuedIds.every((id) => !leasedWorkIds.includes(id)) && scheduler.active_leases.every((lease) =>
      lease.status === 'active' && lease.expires_tick > lease.acquired_tick &&
      lease.expires_tick - lease.acquired_tick <= scheduler.limits.lease_duration_ticks);
}

function agentStateValid(agent) {
  const gateNames = ['exclusive_writer', 'vault_filesystem', 'semantic_kernel', 'compatibility', 'derived_views', 'work_journal', 'control_channel'];
  if (!Array.isArray(agent?.readiness_gates) || agent.readiness_gates.length !== gateNames.length ||
      agent.readiness_gates.some((gate, index) => !record(gate) || gate.ordinal !== index + 1 || gate.gate !== gateNames[index])) return false;
  if (agent.state !== 'ready') return true;
  return agent.writer_lock?.owner_agent_id === agent.persistent_agent_id && agent.writer_lock.epoch > 0 &&
    agent.writer_lock.retained === true && typeof agent.writer_lock.token_digest === 'string' &&
    agent.control_channel_state === 'open' && agent.readiness_gates.every((gate) =>
      gate.verdict === 'pass' && typeof gate.receipt_id === 'string');
}

function controlCommandStateValid(command) {
  const peer = command?.peer;
  if (peer?.peer_credentials_verified !== true || peer.local_transport !== true ||
      peer.peer_uid !== peer.effective_uid || peer.vault_scope !== command.vault_id) return false;
  const expectedBaseKind = ['cancel', 'resume'].includes(command.command_kind) ? 'work_item'
    : command.command_kind === 'enqueue' ? 'work_journal' : null;
  return expectedBaseKind === null || (Array.isArray(command.base_references) &&
    command.base_references.filter((base) => record(base) && base.kind === expectedBaseKind).length === 1);
}

const scenarioCategories = new Set([
  'positive', 'negative', 'exact_boundary', 'stale_state',
  'authority_denial', 'illegal_transition', 'crash_recovery',
]);

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'control-plane-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

export async function checkControlPlaneContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const instances = new Map();
  for (const [instancePath, schemaPath] of instanceBindings) {
    const instance = await readJson(packageRoot, instancePath);
    if (instance === null) {
      codes.push('control.instance_missing');
      continue;
    }
    instances.set(instancePath, instance);
    const schemaErrors = await validateAgainstSchemaPath(packageRoot, schemaPath, instance);
    const code = schemaErrorCode(schemaErrors);
    if (code !== null) codes.push(code);
  }
  for (const path of transitionPaths) {
    const table = await readJson(packageRoot, path);
    if (table === null) {
      codes.push('control.transition_missing');
      continue;
    }
    const check = checkTransitionTable(table, path);
    codes.push(...check.codes);
    const inventory = transitionInventories.get(path);
    if (inventory === undefined || !sameOrder(table.states, inventory.states) || !sameOrder(table.commands, inventory.commands)) {
      codes.push('control.transition_inventory_invalid');
    }
  }

  if (!workJournalStateValid(instances.get('contracts/control-plane/work-journal.json'))) {
    codes.push('control.work_journal_state_invalid');
  }
  if (!schedulerStateValid(instances.get('contracts/control-plane/scheduler-state.json'))) {
    codes.push('control.scheduler_state_invalid');
  }
  if (!agentStateValid(instances.get('contracts/control-plane/agent-state.json'))) {
    codes.push('control.agent_state_invalid');
  }
  if (!controlCommandStateValid(instances.get('contracts/control-plane/control-command.json'))) {
    codes.push('control.command_state_invalid');
  }
  if (!childWorkInvocationIsValid(instances.get('contracts/control-plane/child-work-invocation.json'))) {
    codes.push('control.child_work_state_invalid');
  }
  const recoveryMatrix = instances.get('contracts/control-plane/recovery-matrix.json');
  const recoveryRows = Array.isArray(recoveryMatrix?.rows) ? recoveryMatrix.rows : [];
  if (!sameOrder(recoveryRows.map((row) => row?.case_id), recoveryCaseIds) ||
      recoveryRows.some((row) => typeof row?.terminal_result !== 'string' ||
        !row.terminal_result.endsWith('with unchanged semantic truth'))) {
    codes.push('control.recovery_inventory_invalid');
  }

  const declaredEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const classifiedEntries = await Promise.all(declaredEntries.map(async (entry) => {
    const fixture = typeof entry?.path === 'string'
      ? await readJson(packageRoot, `conformance/${entry.path}`)
      : null;
    const controlPlane = (typeof entry?.fixture_id === 'string' && entry.fixture_id.startsWith('FIX-CP-')) ||
      (typeof entry?.path === 'string' && entry.path.startsWith('scenarios/control-plane/')) ||
      fixture?.subject?.kind === 'control_plane' ||
      fixture?.subject?.schema === 'contracts/schemas/control-plane-scenario.schema.json';
    return {entry, fixture, controlPlane};
  }));
  const controlEntries = classifiedEntries.filter(({controlPlane}) => controlPlane);
  if (controlEntries.length !== 25) codes.push('control.scenario_count_invalid');
  const scenarioIds = [];
  const categories = new Set();
  const authoritySources = new Set();
  for (const {entry, fixture} of controlEntries) {
    if (!entry?.fixture_id?.startsWith('FIX-CP-') ||
        !/^scenarios\/control-plane\/[a-z0-9][a-z0-9-]*\.json$/.test(entry?.path ?? '') ||
        fixture?.fixture_id !== entry.fixture_id || fixture?.category !== entry.category ||
        fixture?.subject?.kind !== 'control_plane' ||
        fixture?.subject?.schema !== 'contracts/schemas/control-plane-scenario.schema.json') {
      codes.push('control.scenario_manifest_pair_invalid');
      continue;
    }
    scenarioIds.push(fixture.subject.document?.scenario_id);
    categories.add(entry.category);
    if (fixture.subject.document?.action?.semantic_write_requested) {
      authoritySources.add(fixture.subject.document.action.authority_source);
    }
  }
  const expectedScenarioIds = Array.from({length: 25}, (_, index) => `CP-${String(index + 1).padStart(3, '0')}`);
  if (new Set(scenarioIds).size !== 25 ||
      expectedScenarioIds.some((id, index) => scenarioIds[index] !== id)) {
    codes.push('control.scenario_identity_invalid');
  }
  if ([...scenarioCategories].some((category) => !categories.has(category))) {
    codes.push('control.scenario_category_missing');
  }
  const requiredAuthoritySources = [
    'work_journal', 'scheduler', 'mdplace_agent', 'child_work',
    'control_channel', 'readiness', 'retry', 'queue',
  ];
  if (requiredAuthoritySources.some((source) => !authoritySources.has(source))) {
    codes.push('control.semantic_authority_coverage_missing');
  }

  const controlTrace = (Array.isArray(traceability?.records) ? traceability.records : [])
    .filter((record) => typeof record?.requirement_id === 'string' && record.requirement_id.startsWith('REQ-CP-'));
  for (const {entry, fixture} of controlEntries) {
    const expectedRequirementIds = controlTrace
      .filter(({positive_fixture_ids: positive = [], negative_fixture_ids: negative = []}) =>
        positive.includes(entry?.fixture_id) || negative.includes(entry?.fixture_id))
      .map(({requirement_id: id}) => id);
    if (!sameOrder(entry?.requirement_ids, expectedRequirementIds) ||
        !sameOrder(fixture?.requirement_ids, expectedRequirementIds)) {
      codes.push('control.fixture_traceability_invalid');
    }
  }

  const recovery = await readJson(packageRoot, 'conformance/evidence/control-plane-recovery-report.json');
  const fixtureIds = controlEntries.map(({entry}) => entry?.fixture_id);
  if (recovery?.validator_version !== manifest?.validator_version ||
      recovery?.scenario_count !== 25 ||
      !Array.isArray(recovery?.fixture_ids) ||
      recovery.fixture_ids.length !== 25 ||
      fixtureIds.some((id, index) => recovery.fixture_ids[index] !== id)) {
    codes.push('control.recovery_evidence_invalid');
  }
  codes.push(...await controlPlaneEvidenceCodes(packageRoot, recovery, controlEntries.map(({entry}) => entry)));

  const decisions = new Map((Array.isArray(traceability?.decisions) ? traceability.decisions : [])
    .filter(record).map((decision) => [decision.decision_id, decision]));
  const expectedDecisions = [
    ['DEC-026', 'https://github.com/jidankim/mdplace/issues/26#issuecomment-5187140948'],
    ['DEC-028', 'https://github.com/jidankim/mdplace/issues/28#issuecomment-5196131324'],
  ];
  if (expectedDecisions.some(([id, url]) => {
    const decision = decisions.get(id);
    return decision?.url !== url || decision?.status !== 'accepted' || decision?.use !== 'input_without_reopening';
  })) {
    codes.push('control.decision_invalid');
  }
  return result(codes);
}
