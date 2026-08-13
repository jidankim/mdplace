import {createHash} from 'node:crypto';

import {checkTransitionTable} from './package-checks.mjs';
import {verifyControlPlaneReceipt} from './control-plane-authentication.mjs';
import {vaultOwnerRecoveryApprovalFields} from './control-plane-contract-values.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const agentStatePath = 'contracts/control-plane/agent-state.json';
const agentStateSchemaPath = 'contracts/schemas/agent-state.schema.json';
const profilePath = 'contracts/control-plane/launchagent-supervision-profile.json';
const profileSchemaPath = 'contracts/schemas/launchagent-supervision-profile.schema.json';
const tablePath = 'contracts/transitions/launchagent-supervision-lifecycle.json';
const tableSchemaPath = 'contracts/schemas/transition-table.schema.json';
const doctorPath = 'conformance/evidence/control-plane-doctor-report.json';
const doctorSchemaPath = 'contracts/schemas/control-plane-doctor-report.schema.json';
const reportPath = 'conformance/evidence/control-plane-lifecycle-report.json';
const reportSchemaPath = 'contracts/schemas/control-plane-lifecycle-report.schema.json';

const restartDelays = [1000, 5000, 30000];
const wakeChecks = ['exclusive_writer', 'vault_filesystem', 'filesystem_drift'];
const readinessGates = [
  'exclusive_writer', 'vault_filesystem', 'semantic_kernel', 'compatibility', 'derived_views', 'work_journal',
];
const lifecycleStates = ['supervised', 'backoff', 'circuit_open', 'recovering'];
const lifecycleCommands = [
  'unexpected_exit', 'backoff_elapsed', 'restart_ceiling_reached', 'wake_revalidate',
  'emit_doctor_report', 'approve_owner_recovery', 'complete_recovery',
];

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'control-plane-lifecycle', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function transition(table, state, command) {
  return Array.isArray(table?.transitions)
    ? table.transitions.find((row) => row?.from_state === state && row?.command_or_event === command)
    : undefined;
}

async function readDocument(packageRoot, path, schemaPath, missingCode, schemaCode, codes) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') {
    codes.push(missingCode);
    return {document: null, content: null};
  }
  let document;
  try {
    document = JSON.parse(read.content.toString('utf8'));
  } catch {
    codes.push(schemaCode);
    return {document: null, content: read.content};
  }
  try {
    if (schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document)) !== null) {
      codes.push(schemaCode);
    }
  } catch {
    codes.push(schemaCode);
  }
  return {document, content: read.content};
}

function profileCodes(profile) {
  const codes = [];
  if (profile?.max_automatic_restart_attempts !== 3 ||
      !sameList(profile?.automatic_restart_delay_ticks, restartDelays)) {
    codes.push('control.lifecycle_backoff_invalid');
  }
  const breaker = profile?.persistent_circuit_breaker;
  if (breaker?.storage !== 'durable_agent_state' || breaker?.trip_on_failure_count !== 3 ||
      breaker?.requires_owner_approval !== true || !sameList(breaker?.qualifying_failure_classes, [
        'unexpected_exit', 'integrity_failure', 'wake_revalidation_failure',
      ])) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  const wake = profile?.wake_revalidation;
  if (!sameList(wake?.checks, wakeChecks) || wake?.work_admission_while_pending !== 'diagnostic_only' ||
      wake?.work_admission_after_pass !== 'work_admitting') {
    codes.push('control.lifecycle_wake_invalid');
  }
  if (profile?.lifecycle_table !== tablePath) codes.push('control.lifecycle_binding_invalid');
  return codes;
}

function lifecycleTableCodes(table) {
  const codes = [];
  const transitionCheck = checkTransitionTable(table, 'control-plane-lifecycle-matrix');
  if (!sameList(table?.states, lifecycleStates) || !sameList(table?.commands, lifecycleCommands) ||
      transitionCheck.verdict !== 'pass' ||
      (table?.transitions ?? []).some((row) => row?.failure_result?.state_effect !== 'unchanged')) {
    codes.push('control.lifecycle_transition_matrix_invalid');
  }

  const unexpectedExit = transition(table, 'supervised', 'unexpected_exit');
  const ceiling = transition(table, 'backoff', 'restart_ceiling_reached');
  const afterCeiling = transition(table, 'circuit_open', 'backoff_elapsed');
  const wake = transition(table, 'supervised', 'wake_revalidate');
  const approval = transition(table, 'circuit_open', 'approve_owner_recovery');
  const recovery = transition(table, 'recovering', 'complete_recovery');
  if (unexpectedExit?.allowed !== true || unexpectedExit.terminal_state !== 'backoff' ||
      !unexpectedExit.preconditions?.includes('the persisted automatic restart attempt count is below the profile maximum') ||
      !unexpectedExit.preconditions?.includes('work admission changes to diagnostic_only before restart scheduling') ||
      ceiling?.allowed !== true || ceiling.terminal_state !== 'circuit_open' ||
      !ceiling.emitted_records?.includes('PersistentCircuitBreakerTripReceipt') ||
      afterCeiling?.allowed !== false || afterCeiling.failure_result?.code !== 'control.restart_ceiling_reached') {
    codes.push('control.lifecycle_backoff_invalid');
  }
  if (wake?.allowed !== true || wake.terminal_state !== 'recovering' ||
      !sameList(wake.preconditions?.slice(-3), [
        'wake revalidation observes the retained Exclusive Writer Lock',
        'wake revalidation observes the bound vault filesystem profile',
        'wake revalidation observes the current filesystem drift result',
      ]) || !wake.filesystem_effects?.includes('no work admission while wake validation is pending') ||
      recovery?.allowed !== true || recovery.terminal_state !== 'supervised' ||
      !recovery.preconditions?.includes('all three wake revalidation checks passed for the same persistent Agent core')) {
    codes.push('control.lifecycle_wake_invalid');
  }
  if (approval?.allowed !== true || approval.terminal_state !== 'recovering' ||
      !sameList(approval.actor_authority?.roles, ['vault_owner']) ||
      !approval.preconditions?.includes('a durable doctor report binds the current circuit version') ||
      !approval.preconditions?.includes('the vault owner approval binds that doctor report and recovery action')) {
    codes.push('control.lifecycle_recovery_approval_invalid');
  }
  return codes;
}

function doctorCodes(profile, doctor) {
  const codes = [];
  if (doctor?.persistent_agent_id !== profile?.persistent_agent_id || doctor?.vault_id !== profile?.vault_id ||
      doctor?.circuit?.state !== 'circuit_open' || doctor?.circuit?.storage !== 'durable_agent_state' ||
      doctor?.circuit?.failure_count !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      doctor?.circuit?.trip_threshold !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      !profile?.persistent_circuit_breaker?.qualifying_failure_classes?.includes(doctor?.circuit?.last_failure_class) ||
      doctor?.work_admission_mode !== 'diagnostic_only' ||
      !sameList(doctor?.allowed_recovery_actions, ['revalidate_same_agent_core'])) {
    codes.push('control.lifecycle_doctor_incomplete');
  }
  if (!Array.isArray(doctor?.startup_failure_receipts) || doctor.startup_failure_receipts.length === 0 ||
      !sameList(doctor?.readiness_observations?.map(({ordinal, gate}) => `${ordinal}:${gate}`),
        readinessGates.map((gate, index) => `${index + 1}:${gate}`)) ||
      !sameList(doctor?.wake_observations?.map(({check}) => check), wakeChecks) ||
      !doctor?.work_journal_head?.head_digest || !doctor?.semantic_kernel?.digest || !doctor?.blocked_code) {
    codes.push('control.lifecycle_doctor_incomplete');
  }
  return codes;
}

function agentStateCodes(profile, agentState) {
  const codes = [];
  const supervision = agentState?.supervision_state;
  if (agentState?.persistent_agent_id !== profile?.persistent_agent_id ||
      agentState?.vault_id !== profile?.vault_id || agentState?.supervision_profile !== profilePath ||
      supervision?.circuit?.storage !== 'durable_agent_state' ||
      supervision?.circuit?.trip_threshold !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      !['supervised', 'backoff', 'circuit_open', 'recovering'].includes(supervision?.state)) {
    codes.push('control.lifecycle_agent_state_invalid');
  }
  if (supervision?.state === 'backoff' &&
      (agentState?.control_channel_state !== 'diagnostic_only' || supervision.next_restart_tick === null)) {
    codes.push('control.lifecycle_backoff_invalid');
  }
  if ((supervision?.state === 'circuit_open' || supervision?.state === 'recovering') &&
      agentState?.control_channel_state === 'work_admitting') {
    codes.push('control.lifecycle_wake_invalid');
  }
  if (supervision?.circuit?.state === 'open' &&
      (supervision.circuit.failure_count !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
       agentState?.doctor_report === null ||
       (supervision.state === 'recovering' && agentState?.owner_recovery_authorization === null))) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  return codes;
}

function reportCodes(profile, doctor, report, contents) {
  const codes = [];
  const profileDigest = contents.profile === null ? null : sha256(contents.profile);
  const tableDigest = contents.table === null ? null : sha256(contents.table);
  const doctorDigest = contents.doctor === null ? null : sha256(contents.doctor);
  if (report?.persistent_agent_id !== profile?.persistent_agent_id || report?.vault_id !== profile?.vault_id ||
      report?.profile_binding?.path !== profilePath || report?.profile_binding?.sha256 !== profileDigest ||
      report?.lifecycle_table_binding?.path !== tablePath || report?.lifecycle_table_binding?.sha256 !== tableDigest ||
      report?.doctor_report_binding?.path !== doctorPath || report?.doctor_report_binding?.sha256 !== doctorDigest ||
      report?.doctor_report_binding?.report_id !== doctor?.report_id ||
      report?.doctor_report_binding?.circuit_version !== doctor?.circuit?.version) {
    codes.push('control.lifecycle_binding_invalid');
  }
  const approval = report?.vault_owner_recovery_approval;
  if (approval?.principal_id !== 'person:owner-001' || approval?.vault_id !== profile?.vault_id ||
      approval?.persistent_agent_id !== profile?.persistent_agent_id || approval?.doctor_report_id !== doctor?.report_id ||
      approval?.doctor_report_digest !== doctorDigest || approval?.circuit_version !== doctor?.circuit?.version ||
      approval?.selected_action !== 'revalidate_same_agent_core' ||
      !verifyControlPlaneReceipt('vault_owner_recovery_approval', vaultOwnerRecoveryApprovalFields(approval), approval,
        profile?.persistent_agent_id) || report?.work_admission_after_approval !== 'diagnostic_only' ||
      !sameList(report?.required_same_core_revalidation, [
        'exclusive_writer', 'readiness_gate_chain', 'wake_revalidation',
      ])) {
    codes.push('control.lifecycle_recovery_approval_invalid');
  }
  return codes;
}

export async function checkControlPlaneLifecycle(packageRoot) {
  const codes = [];
  const [agentState, profile, table, doctor, report] = await Promise.all([
    readDocument(packageRoot, agentStatePath, agentStateSchemaPath,
      'control.lifecycle_agent_state_missing', 'control.lifecycle_agent_state_schema_invalid', codes),
    readDocument(packageRoot, profilePath, profileSchemaPath,
      'control.lifecycle_profile_missing', 'control.lifecycle_profile_schema_invalid', codes),
    readDocument(packageRoot, tablePath, tableSchemaPath,
      'control.lifecycle_table_missing', 'control.lifecycle_table_schema_invalid', codes),
    readDocument(packageRoot, doctorPath, doctorSchemaPath,
      'control.lifecycle_doctor_missing', 'control.lifecycle_doctor_schema_invalid', codes),
    readDocument(packageRoot, reportPath, reportSchemaPath,
      'control.lifecycle_report_missing', 'control.lifecycle_report_schema_invalid', codes),
  ]);

  codes.push(...profileCodes(profile.document));
  codes.push(...agentStateCodes(profile.document, agentState.document));
  codes.push(...lifecycleTableCodes(table.document));
  codes.push(...doctorCodes(profile.document, doctor.document));
  codes.push(...reportCodes(profile.document, doctor.document, report.document, {
    profile: profile.content, table: table.content, doctor: doctor.content,
  }));
  return result(codes);
}
