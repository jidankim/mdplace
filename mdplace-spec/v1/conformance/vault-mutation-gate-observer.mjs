import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const denialByFault = new Map([
  ['symlink_swap', 'path.symlink_detected'],
  ['pathname_swap', 'descriptor.identity_drift'],
  ['traversal', 'path.traversal_denied'],
  ['collision', 'target.collision'],
  ['ownership_drift', 'ownership.stale'],
  ['malformed_plan', 'schema.required_field'],
  ['stale_plan', 'plan.stale'],
  ['stale_hash', 'descriptor.hash_mismatch'],
  ['identity_drift', 'descriptor.identity_mismatch'],
  ['size_drift', 'descriptor.size_mismatch'],
  ['incomplete_journal', 'journal.incomplete'],
  ['receipt_echo_mismatch', 'receipt.echo_mismatch'],
  ['readback_mismatch', 'readback.identity_mismatch'],
  ['misleading_success', 'receipt.readback_required'],
  ['idempotency_conflict', 'idempotency.conflict'],
]);

const recoveryFaults = new Set([
  'incomplete_journal',
  'receipt_echo_mismatch',
  'readback_mismatch',
  'misleading_success',
]);

const preconditionOperations = [
  'open trusted root descriptor',
  'resolve every component with openat and O_NOFOLLOW',
  'capture first fstat',
  'read and hash content through the same handle',
  'capture second fstat',
  'compare device inode size and content hash',
];

const committedOperations = [
  ...preconditionOperations,
  'publish and sync validated Mutation Journal entry',
  'perform only the declared operation through retained descriptors',
  'sync data metadata and parent directory',
  'publish and sync Operation Receipt echo',
  'read back through the retained descriptor',
  'publish and sync commit evidence',
];

function callerMayInvoke(caller, operation, recoveryMode) {
  if (recoveryMode !== 'none') return caller.role === 'foreground_recovery';
  if (caller.role === 'foreground_recovery') return false;
  if (caller.role === 'capture_adapter') return operation === 'promote_capture';
  if (caller.role === 'folder_projection') return operation !== 'promote_capture';
  return false;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recoveryEvidenceMatches(recovery, matrix) {
  const boundaries = Array.isArray(matrix?.boundaries) ? matrix.boundaries.filter(isRecord) : [];
  const boundary = boundaries.find(({boundary_id: id}) => id === recovery.crash_boundary);
  const modeResults = Array.isArray(boundary?.mode_results) ? boundary.mode_results.filter(isRecord) : [];
  const modeResult = modeResults.find(({mode}) => mode === recovery.mode);
  return boundary !== undefined && modeResult !== undefined &&
    isDeepStrictEqual(recovery.durable_prefix, boundary.durable_prefix) &&
    recovery.declared_intent === modeResult.recovery_action &&
    (modeResult.recovery_action !== 'exact_rollback' || recovery.safe_reverse) &&
    (modeResult.recovery_action !== 'compensate' || recovery.compensation_authorized);
}

function invalidRecoveryObservation() {
  return {
    verdict: 'fail', codes: ['recovery.evidence_mismatch'], outputs: ['recovery denied'],
    operations: ['reconcile exact durable prefix', 'halt without guessing'],
    receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
    terminal_state: 'terminal_manual_repair', illegal_transition: false,
  };
}

function descriptorProbeIsValid(probe) {
  return probe.trusted_root_opened && probe.resolution === 'openat_each_component' && probe.nofollow &&
    !probe.pathname_reopened && probe.receipt_echo === 'complete' && probe.readback === 'match' &&
    isDeepStrictEqual(probe.expected_precondition_identity, probe.first_fstat) &&
    isDeepStrictEqual(probe.first_fstat, probe.second_fstat) &&
    probe.same_handle_hash === probe.expected_precondition_identity.content_sha256 &&
    isDeepStrictEqual(probe.receipt_precondition_identity, probe.expected_precondition_identity) &&
    isDeepStrictEqual(probe.receipt_result_identity, probe.expected_result_identity) &&
    isDeepStrictEqual(probe.readback_identity, probe.expected_result_identity);
}

function recoveryObservation(recovery, matrix) {
  if (!recoveryEvidenceMatches(recovery, matrix)) return invalidRecoveryObservation();
  if (recovery.declared_intent === 'terminal_manual_repair') {
    return {
      verdict: 'fail', codes: ['recovery.manual_repair_required'],
      outputs: ['Terminal Manual Repair report'],
      operations: ['reconcile exact durable prefix', 'halt without guessing or duplicating an effect'],
      receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
      terminal_state: 'terminal_manual_repair', illegal_transition: false,
    };
  }
  if (recovery.declared_intent === 'exact_rollback' && recovery.safe_reverse) {
    return {
      verdict: 'pass', codes: [], outputs: ['exact rollback completed'],
      operations: ['reconcile exact durable prefix', 'prove reverse Descriptor Identity', 'perform exact rollback'],
      receipts: ['MutationRollbackReceipt'], filesystem_effects: ['reverse only the declared effect'],
      terminal_state: 'rolled_back', illegal_transition: false,
    };
  }
  if (recovery.declared_intent === 'compensate' && recovery.compensation_authorized) {
    return {
      verdict: 'pass', codes: [], outputs: ['authorized compensation completed'],
      operations: ['reconcile exact durable prefix', 'validate separate compensation authorization', 'perform compensation'],
      receipts: ['MutationCompensationReceipt'], filesystem_effects: ['perform only the authorized compensating effect'],
      terminal_state: 'compensated', illegal_transition: false,
    };
  }
  if (recovery.declared_intent === 'resume') {
    return {
      verdict: 'pass', codes: [], outputs: ['operation resumed and committed'],
      operations: ['reconcile exact durable prefix', 'resume at the next uncommitted event', ...committedOperations],
      receipts: ['OperationReceipt', 'MutationCommitEvidence'], filesystem_effects: ['perform the declared effect at most once'],
      terminal_state: 'committed', illegal_transition: false,
    };
  }
  return {
    verdict: 'fail', codes: ['recovery.authorization_missing'], outputs: ['recovery denied'],
    operations: ['reconcile exact durable prefix', 'halt without guessing'],
    receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
    terminal_state: 'terminal_manual_repair', illegal_transition: false,
  };
}

export async function observeVaultMutationScenario(subject, packageRoot) {
  const errors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  const schemaCode = schemaErrorCode(errors);
  if (schemaCode !== null) {
    return {
      verdict: 'fail', codes: [schemaCode], outputs: ['Authorized Mutation Plan rejected'],
      operations: ['parse closed scenario boundary'], receipts: ['MutationDeniedReceipt'],
      filesystem_effects: ['none'], terminal_state: 'denied', illegal_transition: false,
    };
  }
  const scenario = subject.document;
  if (!scenario.operation_declared) {
    return {
      verdict: 'fail', codes: ['plan.operation_undeclared'], outputs: ['mutation denied'],
      operations: preconditionOperations, receipts: ['MutationDeniedReceipt'], filesystem_effects: ['none'],
      terminal_state: 'denied', illegal_transition: true,
    };
  }
  if (!callerMayInvoke(scenario.caller, scenario.operation, scenario.recovery.mode)) {
    return {
      verdict: 'fail', codes: ['authority.denied'], outputs: ['mutation denied'],
      operations: preconditionOperations, receipts: ['MutationDeniedReceipt'], filesystem_effects: ['none'],
      terminal_state: 'denied', illegal_transition: false,
    };
  }
  const probeValid = descriptorProbeIsValid(scenario.probe);
  if (scenario.recovery.mode !== 'none') {
    if (!probeValid) return invalidRecoveryObservation();
    const matrixRead = await readPackageFile(packageRoot, 'contracts/vault-mutation-gate/crash-boundary-matrix.json');
    if (matrixRead.status !== 'present') return invalidRecoveryObservation();
    let matrix;
    try {
      matrix = JSON.parse(matrixRead.content.toString('utf8'));
    } catch {
      return invalidRecoveryObservation();
    }
    return recoveryObservation(scenario.recovery, matrix);
  }
  const faultCode = denialByFault.get(scenario.fault);
  if (faultCode !== undefined || !probeValid || scenario.plan_state !== 'authorized') {
    const code = faultCode ?? (scenario.plan_state === 'stale' ? 'plan.stale' : 'descriptor.probe_invalid');
    const requiresRecovery = recoveryFaults.has(scenario.fault);
    return {
      verdict: 'fail', codes: [code], outputs: [requiresRecovery ? 'Vault Mutation Recovery required' : 'mutation denied'],
      operations: preconditionOperations,
      receipts: [requiresRecovery ? 'MutationRecoveryRequiredReceipt' : 'MutationDeniedReceipt'],
      filesystem_effects: [requiresRecovery ? 'preserve only the declared observed effect' : 'none'],
      terminal_state: requiresRecovery ? 'recovery_required' : 'denied',
      illegal_transition: false,
    };
  }
  return {
    verdict: 'pass', codes: [], outputs: ['declared operation committed'], operations: committedOperations,
    receipts: ['OperationReceipt', 'MutationCommitEvidence'], filesystem_effects: ['perform only the declared effect'],
    terminal_state: 'committed', illegal_transition: false,
  };
}
