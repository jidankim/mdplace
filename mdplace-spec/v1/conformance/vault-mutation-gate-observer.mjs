import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {
  scenarioAuthorizedPlanDigest,
  scenarioCompensatingPlanDigest,
} from './vault-mutation-digests.mjs';
import {
  observeVirtualVaultProbe,
  virtualDescriptorIdentity,
} from './vault-mutation-virtual-vault.mjs';

const recoveryCodes = new Set([
  'journal.incomplete', 'receipt.echo_mismatch',
  'readback.identity_mismatch', 'receipt.readback_required',
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

function callerMayInvoke(caller, plan, recoveryMode) {
  if (recoveryMode !== 'none') return caller.role === 'foreground_recovery';
  if (caller.role === 'foreground_recovery') return false;
  if (caller.caller_id !== plan.caller_id) return false;
  if (caller.role === 'capture_adapter') return plan.operation === 'promote_capture';
  if (caller.role === 'folder_projection') return plan.operation !== 'promote_capture';
  return false;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recoveryEvidenceMatches(recovery, matrix, plan) {
  const boundaries = Array.isArray(matrix?.boundaries) ? matrix.boundaries.filter(isRecord) : [];
  const boundary = boundaries.find(({boundary_id: id}) => id === recovery.crash_boundary);
  const modeResults = Array.isArray(boundary?.mode_results) ? boundary.mode_results.filter(isRecord) : [];
  const modeResult = modeResults.find(({mode}) => mode === recovery.mode);
  return boundary !== undefined && modeResult !== undefined &&
    isDeepStrictEqual(recovery.durable_prefix, boundary.durable_prefix) &&
    recovery.declared_intent === modeResult.recovery_action &&
    recovery.declared_intent === plan.recovery_intent &&
    (modeResult.recovery_action !== 'exact_rollback' ||
      recovery.reverse_descriptor !== null &&
      isDeepStrictEqual(virtualDescriptorIdentity(recovery.reverse_descriptor),
        plan.expected_result_identity)) &&
    (modeResult.recovery_action !== 'compensate' ||
      plan.compensating_plan !== null && recovery.compensation_authorization !== null &&
      scenarioCompensatingPlanDigest(plan.compensating_plan) === plan.compensating_plan.plan_sha256 &&
      isDeepStrictEqual(recovery.compensation_authorization, plan.compensating_plan));
}

function planAuthorizationCode(scenario) {
  const plan = scenario.authorized_plan;
  const authorization = scenario.authorization;
  if (scenarioAuthorizedPlanDigest(plan) !== plan.plan_sha256 ||
      plan.plan_id !== authorization.plan_id || plan.plan_sha256 !== authorization.plan_sha256 ||
      plan.authority_receipt_sha256 !== authorization.authority_receipt_sha256 ||
      plan.idempotency_key !== authorization.idempotency_key || plan.operation !== scenario.operation ||
      plan.projection_scope !== (scenario.operation === 'promote_capture' ? null : 'vault') ||
      !isDeepStrictEqual(plan.expected_precondition_identity,
        scenario.probe.authorized_precondition_identity) ||
      !isDeepStrictEqual(plan.expected_result_identity, scenario.probe.authorized_result_identity)) {
    return 'plan.authorization_invalid';
  }
  if (plan.ownership_receipt_sha256 !== authorization.ownership_receipt_sha256) {
    return 'ownership.stale';
  }
  return null;
}

function projectionSerializationCode(scenario) {
  if (scenario.authorized_plan.projection_scope !== 'vault') return null;
  const active = scenario.projection_state.state !== 'idle';
  if (!active) return scenario.recovery.mode === 'none' ? null : 'recovery.authorization_invalid';
  const samePlan = scenario.projection_state.active_plan_id === scenario.authorized_plan.plan_id &&
    scenario.projection_state.active_plan_sha256 === scenario.authorized_plan.plan_sha256;
  if (scenario.recovery.mode !== 'none') return samePlan ? null : 'recovery.authorization_invalid';
  return samePlan ? null : 'projection.concurrent_apply_denied';
}

function idempotencyConflictExists(scenario) {
  const record = scenario.idempotency_record;
  return record !== null && record.idempotency_key === scenario.authorized_plan.idempotency_key &&
    record.plan_sha256 !== scenario.authorized_plan.plan_sha256;
}

function invalidRecoveryObservation() {
  return {
    verdict: 'fail', codes: ['recovery.evidence_mismatch'], outputs: ['recovery denied'],
    operations: ['reconcile exact durable prefix', 'halt without guessing'],
    receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
    terminal_state: 'terminal_manual_repair', illegal_transition: false,
  };
}

function invalidRecoveryAuthorizationObservation() {
  return {
    verdict: 'fail', codes: ['recovery.authorization_invalid'], outputs: ['recovery denied'],
    operations: ['authenticate exact Authorized Mutation Plan', 'halt without guessing'],
    receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
    terminal_state: 'terminal_manual_repair', illegal_transition: false,
  };
}

function recoveryBudgetRemainingObservation() {
  return {
    verdict: 'fail', codes: ['recovery.interruption_budget_remaining'],
    outputs: ['Vault Mutation Recovery remains required'],
    operations: ['persist the advanced interruption count', 'retain exact recovery evidence'],
    receipts: ['MutationRecoveryRequiredReceipt'], filesystem_effects: ['preserve observed physical state'],
    terminal_state: 'recovery_required', illegal_transition: false,
  };
}

function recoveryObservation(recovery, matrix, plan) {
  if (!recoveryEvidenceMatches(recovery, matrix, plan)) return invalidRecoveryAuthorizationObservation();
  if (recovery.declared_intent === 'terminal_manual_repair') {
    return {
      verdict: 'fail', codes: ['recovery.manual_repair_required'],
      outputs: ['Terminal Manual Repair report'],
      operations: ['reconcile exact durable prefix', 'halt without guessing or duplicating an effect'],
      receipts: ['TerminalManualRepairReport'], filesystem_effects: ['preserve observed physical state'],
      terminal_state: 'terminal_manual_repair', illegal_transition: false,
    };
  }
  if (recovery.declared_intent === 'exact_rollback' && recovery.reverse_descriptor !== null) {
    return {
      verdict: 'pass', codes: [], outputs: ['exact rollback completed'],
      operations: ['reconcile exact durable prefix', 'prove reverse Descriptor Identity', 'perform exact rollback'],
      receipts: ['MutationRollbackReceipt'], filesystem_effects: ['reverse only the declared effect'],
      terminal_state: 'rolled_back', illegal_transition: false,
    };
  }
  if (recovery.declared_intent === 'compensate' && recovery.compensation_authorization !== null) {
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
  if (!callerMayInvoke(scenario.caller, scenario.authorized_plan, scenario.recovery.mode)) {
    return {
      verdict: 'fail', codes: ['authority.denied'], outputs: ['mutation denied'],
      operations: preconditionOperations, receipts: ['MutationDeniedReceipt'], filesystem_effects: ['none'],
      terminal_state: 'denied', illegal_transition: false,
    };
  }
  const authorizationCode = planAuthorizationCode(scenario);
  const projectionCode = projectionSerializationCode(scenario);
  const probeObservation = observeVirtualVaultProbe(scenario.probe);
  if (scenario.recovery.mode !== 'none') {
    if (authorizationCode !== null || projectionCode !== null) return invalidRecoveryAuthorizationObservation();
    if (!probeObservation.valid) return invalidRecoveryObservation();
    if (scenario.recovery.mode === 'repeated_interruption' &&
        scenario.recovery.crash_boundary !== 'after_commit' &&
        scenario.recovery.interruption_count < scenario.recovery.interruption_budget) {
      return recoveryBudgetRemainingObservation();
    }
    const matrixRead = await readPackageFile(packageRoot, 'contracts/vault-mutation-gate/crash-boundary-matrix.json');
    if (matrixRead.status !== 'present') return invalidRecoveryObservation();
    let matrix;
    try {
      matrix = JSON.parse(matrixRead.content.toString('utf8'));
    } catch {
      return invalidRecoveryObservation();
    }
    return recoveryObservation(scenario.recovery, matrix, scenario.authorized_plan);
  }
  const code = scenario.plan_state === 'stale'
    ? 'plan.stale'
    : authorizationCode ?? (idempotencyConflictExists(scenario) ? 'idempotency.conflict' : probeObservation.code);
  const codes = [...new Set([projectionCode, code].filter((value) => value !== null))];
  if (codes.length > 0) {
    const requiresRecovery = codes.every((candidate) => recoveryCodes.has(candidate));
    return {
      verdict: 'fail', codes, outputs: [requiresRecovery ? 'Vault Mutation Recovery required' : 'mutation denied'],
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
