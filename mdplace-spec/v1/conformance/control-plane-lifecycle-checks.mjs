import {createHash} from 'node:crypto';

import {checkTransitionTable} from './package-checks.mjs';
import {
  verifyControlPlaneReceipt,
  verifyVaultOwnerRecoveryApproval,
} from './control-plane-authentication.mjs';
import {
  qualifyingFailureReceiptFields,
  vaultOwnerRecoveryApprovalFields,
  workAdmissionSuspensionReceiptFields,
} from './control-plane-contract-values.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

const agentStatePath = 'contracts/control-plane/agent-state.json';
const agentStateSchemaPath = 'contracts/schemas/agent-state.schema.json';
const profilePath = 'contracts/control-plane/launchagent-supervision-profile.json';
const profileSchemaPath = 'contracts/schemas/launchagent-supervision-profile.schema.json';
const tablePath = 'contracts/transitions/launchagent-supervision-lifecycle.json';
const controlChannelTablePath = 'contracts/transitions/control-channel-lifecycle.json';
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
const lifecycleStates = ['supervised', 'backoff', 'circuit_open', 'recovering', 'wake_revalidating'];
const lifecycleCommands = [
  'unexpected_exit', 'qualifying_failure', 'backoff_elapsed', 'restart_ceiling_reached', 'wake_revalidate',
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
  const qualifyingFailure = transition(table, 'supervised', 'qualifying_failure');
  const directCeiling = transition(table, 'supervised', 'restart_ceiling_reached');
  const backoffElapsed = transition(table, 'backoff', 'backoff_elapsed');
  const backoffCeiling = transition(table, 'backoff', 'restart_ceiling_reached');
  const afterCeiling = transition(table, 'circuit_open', 'backoff_elapsed');
  const recoveryFailure = transition(table, 'recovering', 'qualifying_failure');
  const wakeFailure = transition(table, 'wake_revalidating', 'qualifying_failure');
  const wakeCeiling = transition(table, 'wake_revalidating', 'restart_ceiling_reached');
  const wake = transition(table, 'supervised', 'wake_revalidate');
  const approval = transition(table, 'circuit_open', 'approve_owner_recovery');
  const recovery = transition(table, 'recovering', 'complete_recovery');
  if (unexpectedExit?.allowed !== true || unexpectedExit.terminal_state !== 'backoff' ||
      !unexpectedExit.preconditions?.includes('the resulting failure ordinal is strictly below the profile maximum') ||
      !unexpectedExit.preconditions?.includes('work admission changes to diagnostic_only before restart scheduling') ||
      qualifyingFailure?.allowed !== true || qualifyingFailure.terminal_state !== 'backoff' ||
      !qualifyingFailure.preconditions?.includes(
        'the resulting failure ordinal is 1 or 2 and strictly below the profile maximum') ||
      !qualifyingFailure.emitted_records?.includes('QualifyingFailureReceipt') ||
      directCeiling?.allowed !== true || directCeiling.terminal_state !== 'circuit_open' ||
      !directCeiling.preconditions?.includes(
        'the authenticated linked failure receipt has ordinal 3 and the durable prior count is 2') ||
      !directCeiling.emitted_records?.includes('QualifyingFailureReceipt') ||
      !directCeiling.emitted_records?.includes('PersistentCircuitBreakerTripReceipt') ||
      directCeiling.idempotency?.retry_result !==
        'return the original qualifying-failure, circuit-trip, and doctor receipts' ||
      backoffElapsed?.allowed !== true || !backoffElapsed.preconditions?.includes(
        'the persisted automatic restart attempt count is strictly below the profile maximum') ||
      backoffCeiling?.allowed !== false || backoffCeiling.terminal_state !== 'backoff' ||
      backoffCeiling.failure_result?.code !== 'control.illegal_transition' ||
      afterCeiling?.allowed !== false || afterCeiling.failure_result?.code !== 'control.restart_ceiling_reached') {
    codes.push('control.lifecycle_backoff_invalid');
  }
  if (recoveryFailure?.allowed !== true || recoveryFailure.terminal_state !== 'circuit_open' ||
      !recoveryFailure.emitted_records?.includes('RecoveryFailureReceipt') ||
      !recoveryFailure.filesystem_effects?.includes('no automatic launch')) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  if (wakeFailure?.allowed !== true || wakeFailure.terminal_state !== 'backoff' ||
      !wakeFailure.preconditions?.includes(
        'the resulting failure ordinal is 1 or 2 and strictly below the profile maximum') ||
      wakeCeiling?.allowed !== true || wakeCeiling.terminal_state !== 'circuit_open' ||
      !wakeCeiling.emitted_records?.includes('QualifyingFailureReceipt') ||
      !wakeCeiling.emitted_records?.includes('PersistentCircuitBreakerTripReceipt')) {
    codes.push('control.lifecycle_backoff_invalid');
  }
  if (wake?.allowed !== true || wake.terminal_state !== 'wake_revalidating' ||
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

function controlChannelTableCodes(table) {
  const codes = [];
  const demotion = transition(table, 'work_admitting', 'close_control_channel');
  if (demotion?.allowed !== true || demotion.terminal_state !== 'diagnostic_only' ||
      !demotion.preconditions?.includes(
        'the current work-admitting channel version is bound to the suspension receipt') ||
      !sameList(demotion.base_references, ['current Control Channel version', 'vault identity']) ||
      !sameList(demotion.emitted_records, ['ControlChannelWorkAdmissionSuspendedReceipt']) ||
      !sameList(demotion.filesystem_effects, [
        'atomically demote Control Channel from work-admitting to diagnostic-only',
      ]) || demotion.idempotency?.retry_result !==
        'return the original work-admission suspension receipt for the exact binding') {
    codes.push('control.lifecycle_work_admission_suspension_invalid');
  }
  return codes;
}

function doctorCodes(profile, doctor) {
  const codes = [];
  const failureReceipts = doctor?.startup_failure_receipts;
  const observedTicks = restartDelays.map((_, index) =>
    restartDelays.slice(0, index + 1).reduce((total, delay) => total + delay, 0));
  const lastFailure = Array.isArray(failureReceipts) ? failureReceipts.at(-1) : undefined;
  if (doctor?.persistent_agent_id !== profile?.persistent_agent_id || doctor?.vault_id !== profile?.vault_id ||
      doctor?.circuit?.state !== 'circuit_open' || doctor?.circuit?.storage !== 'durable_agent_state' ||
      doctor?.circuit?.failure_count !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      doctor?.circuit?.trip_threshold !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      !profile?.persistent_circuit_breaker?.qualifying_failure_classes?.includes(doctor?.circuit?.last_failure_class) ||
      doctor?.work_admission_mode !== 'diagnostic_only' ||
      !sameList(doctor?.allowed_recovery_actions, ['revalidate_same_agent_core'])) {
    codes.push('control.lifecycle_doctor_incomplete');
  }
  if (!Array.isArray(failureReceipts) ||
      failureReceipts.length !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      !failureReceipts.every((receipt, index) =>
        receipt.persistent_agent_id === profile.persistent_agent_id &&
        receipt.vault_id === profile.vault_id && receipt.failure_ordinal === index + 1 &&
        profile.persistent_circuit_breaker.qualifying_failure_classes.includes(receipt.failure_class) &&
        receipt.observed_tick === observedTicks[index] &&
        receipt.selected_delay_ticks === restartDelays[index] &&
        receipt.circuit_version === doctor.circuit.version &&
        receipt.prior_receipt_digest === (index === 0 ? null : failureReceipts[index - 1].signature_digest) &&
        verifyControlPlaneReceipt(
          'qualifying_failure', qualifyingFailureReceiptFields(receipt), receipt, profile.persistent_agent_id,
        )) ||
      new Set(failureReceipts.map(({receipt_id}) => receipt_id)).size !== failureReceipts.length ||
      new Set(failureReceipts.map(({signature_digest}) => signature_digest)).size !== failureReceipts.length ||
      lastFailure?.failure_class !== doctor?.circuit?.last_failure_class ||
      lastFailure?.signature_digest !== doctor?.circuit?.trip_receipt_digest ||
      lastFailure?.code !== 'control.restart_ceiling_reached' || doctor?.reported_tick !== lastFailure?.observed_tick ||
      !sameList(doctor?.readiness_observations?.map(({ordinal, gate}) => `${ordinal}:${gate}`),
        readinessGates.map((gate, index) => `${index + 1}:${gate}`)) ||
      !sameList(doctor?.wake_observations?.map(({check}) => check), wakeChecks) ||
      !doctor?.work_journal_head?.head_digest || !doctor?.semantic_kernel?.digest || !doctor?.blocked_code) {
    codes.push('control.lifecycle_doctor_incomplete');
  }
  return codes;
}

function agentStateCodes(profile, agentState, doctor, report, contents) {
  const codes = [];
  const supervision = agentState?.supervision_state;
  const wakeObservationDigest = agentState?.wake_revalidation === undefined
    ? null : sha256(canonicalJson(agentState.wake_revalidation));
  if (agentState?.persistent_agent_id !== profile?.persistent_agent_id ||
      agentState?.vault_id !== profile?.vault_id || agentState?.supervision_profile !== profilePath ||
      supervision?.circuit?.storage !== 'durable_agent_state' ||
      supervision?.circuit?.trip_threshold !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
      !['supervised', 'backoff', 'circuit_open', 'recovering', 'wake_revalidating'].includes(supervision?.state)) {
    codes.push('control.lifecycle_agent_state_invalid');
  }
  if (supervision?.state === 'backoff' &&
      (agentState?.control_channel_state !== 'diagnostic_only' || supervision.next_restart_tick === null ||
       supervision.circuit?.state !== 'closed')) {
    codes.push('control.lifecycle_backoff_invalid');
  }
  if (supervision?.state === 'supervised' &&
      (supervision.next_restart_tick !== null || supervision.circuit?.state !== 'closed')) {
    codes.push('control.lifecycle_agent_state_invalid');
  }
  if (supervision?.state === 'wake_revalidating' &&
      (supervision.next_restart_tick !== null || supervision.circuit?.state !== 'closed' ||
       agentState?.control_channel_state !== 'diagnostic_only' ||
       agentState?.owner_recovery_authorization !== null ||
       agentState?.work_admission_suspension?.receipt_id !==
         report?.work_admission_suspension_receipt?.receipt_id ||
       agentState?.work_admission_suspension?.signature_digest !==
         report?.work_admission_suspension_receipt?.signature_digest ||
       agentState?.work_admission_suspension?.control_channel_version !==
         report?.work_admission_suspension_receipt?.control_channel_version ||
       agentState?.work_admission_suspension?.wake_observation_digest !== wakeObservationDigest ||
       report?.work_admission_suspension_receipt?.wake_observation_digest !== wakeObservationDigest)) {
    codes.push('control.lifecycle_wake_invalid');
  }
  if (supervision?.circuit?.state === 'open' &&
      !['circuit_open', 'recovering'].includes(supervision?.state)) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  if (supervision?.state === 'circuit_open' &&
      (supervision.circuit?.state !== 'open' || supervision.next_restart_tick !== null ||
       agentState?.owner_recovery_authorization !== null)) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  if (['circuit_open', 'recovering', 'wake_revalidating'].includes(supervision?.state) &&
      agentState?.control_channel_state === 'work_admitting') {
    codes.push('control.lifecycle_wake_invalid');
  }
  if (supervision?.circuit?.state === 'open' &&
      (supervision.circuit.failure_count !== profile?.persistent_circuit_breaker?.trip_on_failure_count ||
       agentState?.doctor_report === null ||
       (supervision.state === 'recovering' && agentState?.owner_recovery_authorization === null))) {
    codes.push('control.lifecycle_breaker_invalid');
  }
  if (supervision?.circuit?.state === 'open') {
    const doctorDigest = contents.doctor === null ? null : sha256(contents.doctor);
    const approval = report?.vault_owner_recovery_approval;
    if (agentState?.doctor_report?.report_id !== doctor?.report_id ||
        agentState?.doctor_report?.digest !== doctorDigest ||
        supervision.circuit.version !== doctor?.circuit?.version ||
        supervision.circuit.trip_receipt_digest !== doctor?.circuit?.trip_receipt_digest ||
        doctor?.vault_id !== agentState?.vault_id ||
        doctor?.persistent_agent_id !== agentState?.persistent_agent_id) {
      codes.push('control.lifecycle_binding_invalid');
    }
    if (supervision.state === 'recovering' &&
        (agentState?.owner_recovery_authorization?.receipt_id !== approval?.receipt_id ||
         agentState?.owner_recovery_authorization?.digest !== approval?.signature_digest ||
         approval?.circuit_version !== supervision.circuit.version ||
         approval?.vault_id !== agentState?.vault_id ||
         approval?.persistent_agent_id !== agentState?.persistent_agent_id)) {
      codes.push('control.lifecycle_recovery_approval_invalid');
    }
  }
  return codes;
}

function reportCodes(profile, doctor, report, contents) {
  const codes = [];
  const profileDigest = contents.profile === null ? null : sha256(contents.profile);
  const tableDigest = contents.table === null ? null : sha256(contents.table);
  const controlChannelTableDigest = contents.controlChannelTable === null
    ? null : sha256(contents.controlChannelTable);
  const doctorDigest = contents.doctor === null ? null : sha256(contents.doctor);
  if (report?.persistent_agent_id !== profile?.persistent_agent_id || report?.vault_id !== profile?.vault_id ||
      report?.profile_binding?.path !== profilePath || report?.profile_binding?.sha256 !== profileDigest ||
      report?.lifecycle_table_binding?.path !== tablePath || report?.lifecycle_table_binding?.sha256 !== tableDigest ||
      report?.control_channel_table_binding?.path !== controlChannelTablePath ||
      report?.control_channel_table_binding?.sha256 !== controlChannelTableDigest ||
      report?.doctor_report_binding?.path !== doctorPath || report?.doctor_report_binding?.sha256 !== doctorDigest ||
      report?.doctor_report_binding?.report_id !== doctor?.report_id ||
      report?.doctor_report_binding?.circuit_version !== doctor?.circuit?.version) {
    codes.push('control.lifecycle_binding_invalid');
  }
  const suspension = report?.work_admission_suspension_receipt;
  if (suspension?.persistent_agent_id !== profile?.persistent_agent_id ||
      suspension?.vault_id !== profile?.vault_id || suspension?.control_channel_version !== 1 ||
      suspension?.prior_mode !== 'work_admitting' || suspension?.resulting_mode !== 'diagnostic_only' ||
      suspension?.suspension_reason !== 'wake_revalidation' ||
      !verifyControlPlaneReceipt(
        'control_channel_work_admission_suspended',
        workAdmissionSuspensionReceiptFields(suspension), suspension, profile?.persistent_agent_id,
      )) {
    codes.push('control.lifecycle_work_admission_suspension_invalid');
  }
  const approval = report?.vault_owner_recovery_approval;
  if (approval?.principal_id !== 'person:owner-001' || approval?.vault_id !== profile?.vault_id ||
      approval?.persistent_agent_id !== profile?.persistent_agent_id || approval?.doctor_report_id !== doctor?.report_id ||
      approval?.doctor_report_digest !== doctorDigest || approval?.circuit_version !== doctor?.circuit?.version ||
      approval?.selected_action !== 'revalidate_same_agent_core' ||
      !verifyVaultOwnerRecoveryApproval(vaultOwnerRecoveryApprovalFields(approval), approval) ||
      report?.work_admission_after_approval !== 'diagnostic_only' ||
      !sameList(report?.required_same_core_revalidation, [
        'exclusive_writer', 'readiness_gate_chain', 'wake_revalidation',
      ])) {
    codes.push('control.lifecycle_recovery_approval_invalid');
  }
  return codes;
}

export async function checkControlPlaneLifecycle(packageRoot) {
  const codes = [];
  const [agentState, profile, table, controlChannelTable, doctor, report] = await Promise.all([
    readDocument(packageRoot, agentStatePath, agentStateSchemaPath,
      'control.lifecycle_agent_state_missing', 'control.lifecycle_agent_state_schema_invalid', codes),
    readDocument(packageRoot, profilePath, profileSchemaPath,
      'control.lifecycle_profile_missing', 'control.lifecycle_profile_schema_invalid', codes),
    readDocument(packageRoot, tablePath, tableSchemaPath,
      'control.lifecycle_table_missing', 'control.lifecycle_table_schema_invalid', codes),
    readDocument(packageRoot, controlChannelTablePath, tableSchemaPath,
      'control.lifecycle_control_channel_table_missing',
      'control.lifecycle_control_channel_table_schema_invalid', codes),
    readDocument(packageRoot, doctorPath, doctorSchemaPath,
      'control.lifecycle_doctor_missing', 'control.lifecycle_doctor_schema_invalid', codes),
    readDocument(packageRoot, reportPath, reportSchemaPath,
      'control.lifecycle_report_missing', 'control.lifecycle_report_schema_invalid', codes),
  ]);

  codes.push(...profileCodes(profile.document));
  codes.push(...agentStateCodes(profile.document, agentState.document, doctor.document, report.document, {
    doctor: doctor.content,
  }));
  codes.push(...lifecycleTableCodes(table.document));
  codes.push(...controlChannelTableCodes(controlChannelTable.document));
  codes.push(...doctorCodes(profile.document, doctor.document));
  codes.push(...reportCodes(profile.document, doctor.document, report.document, {
    profile: profile.content, table: table.content,
    controlChannelTable: controlChannelTable.content, doctor: doctor.content,
  }));
  return result(codes);
}
