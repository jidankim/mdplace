import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {
  policyNarrowingViolation,
  processingPolicyDigest,
  recoveryJournalDigest,
  sha256Json,
  sourceProfileApprovalDigest,
  sourceProfileDigest,
} from './processing-policy-core.mjs';
import {processingDenialCode, sourceProfileBindingCode} from './processing-policy-decision.mjs';

function receipt(document, decision, code, policy, profile = null) {
  const profileReference = profile !== null && typeof profile.profile_id === 'string' &&
    typeof profile.profile_version === 'string'
    ? {profile_id: profile.profile_id, profile_version: profile.profile_version, profile_sha256: sourceProfileDigest(profile)}
    : null;
  return canonicalJson({
    schema_id: 'mdplace.processing-policy-receipt/v1',
    receipt_id: `receipt:${document.scenario_id.toLowerCase()}`,
    scenario_id: document.scenario_id,
    operation: document.operation,
    decision,
    code,
    policy_ref: {
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      policy_sha256: processingPolicyDigest(policy),
    },
    source_profile_ref: profileReference,
  });
}

function observed(document, {verdict, code = null, output, operations, terminal, illegal = false, effects = ['none']}) {
  const profile = document.source_profile === null ? null : document.source_profile;
  return {
    verdict,
    codes: code === null ? [] : [code],
    outputs: [output],
    operations,
    receipts: [receipt(document, verdict === 'pass' ? 'allowed' : 'denied', code, document.policy, profile)],
    filesystem_effects: effects,
    network_effects: ['none'],
    terminal_state: terminal,
    illegal_transition: illegal,
  };
}

function denied(document, code, operation = 'processing_decision', illegal = false) {
  const intake = operation === 'intake_decision';
  const recovery = operation === 'recovery';
  const staleBinding = code.startsWith('source_profile.') &&
    (code.includes('mismatch') || code.includes('readback'));
  return observed(document, {
    verdict: 'fail', code, output: intake ? 'intake denied' : recovery ? 'binding recovery denied' : 'processing denied',
    operations: intake
      ? ['validate Source Profile binding', 'apply default-deny Processing Policy']
      : ['validate processing request', 'apply default-deny Processing Policy'],
    terminal: intake ? staleBinding ? 'stale' : document.lifecycle.source_profile_state
      : recovery ? 'recovery_required' : 'denied', illegal,
  });
}

async function schemaCode(packageRoot, path, value) {
  if (value === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, path, value));
  } catch {
    return 'schema.instance_missing';
  }
}

async function receiptSchemaCode(document, packageRoot) {
  for (const approvalReceipt of document.approval_receipts) {
    if (await schemaCode(packageRoot, 'contracts/schemas/approval-receipt.schema.json', approvalReceipt) !== null) {
      return 'policy.approval_readback_failed';
    }
  }
  for (const redactionReceipt of document.redaction_receipts) {
    if (await schemaCode(packageRoot, 'contracts/schemas/redaction-receipt.schema.json', redactionReceipt) !== null) {
      return 'policy.redaction_unproven';
    }
  }
  return null;
}

async function observeProcessing(document, packageRoot) {
  const requestCode = await schemaCode(packageRoot, 'contracts/schemas/processing-request.schema.json', document.request);
  if (requestCode !== null) return denied(document, requestCode);
  const code = processingDenialCode(document);
  if (code !== null) return denied(document, code);
  return observed(document, {
    verdict: 'pass', output: 'processing allowed',
    operations: ['validate processing request', 'apply default-deny Processing Policy'], terminal: 'allowed',
  });
}

async function observeIntake(document, packageRoot) {
  if (document.source_profile === null) return denied(document, 'source_profile.binding_required', 'intake_decision', true);
  const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', document.source_profile);
  if (profileCode !== null) return denied(document, profileCode, 'intake_decision');
  const bindingCode = sourceProfileBindingCode(document);
  if (bindingCode !== null) return denied(document, bindingCode, 'intake_decision', bindingCode === 'source_profile.binding_required');
  const requestCode = await schemaCode(packageRoot, 'contracts/schemas/processing-request.schema.json', document.request);
  if (requestCode !== null) return denied(document, requestCode, 'intake_decision');
  const policyCode = processingDenialCode(document);
  if (policyCode !== null) return denied(document, policyCode, 'intake_decision');
  return observed(document, {
    verdict: 'pass', output: 'intake allowed',
    operations: ['validate Source Profile binding', 'apply default-deny Processing Policy'], terminal: 'active',
  });
}

async function observePolicyPair(document, packageRoot) {
  const childCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy.schema.json', document.descendant_policy);
  if (childCode !== null) return denied(document, childCode, 'policy_pair');
  const violation = policyNarrowingViolation(document.policy, document.descendant_policy);
  if (violation !== null) return denied(document, violation, 'policy_pair');
  return observed(document, {
    verdict: 'pass', output: 'policy narrowing accepted',
    operations: ['validate parent policy binding', 'compare every permission dimension'], terminal: 'active',
  });
}

function observeRecovery(document) {
  const recovery = document.recovery;
  const {crash_point: point} = recovery;
  if (document.lifecycle.source_profile_state !== 'recovery_required') {
    return denied(document, 'source_profile.recovery_not_required', 'recovery', true);
  }
  const beforeApproval = point === 'before_approval_receipt_publish';
  const afterBinding = point === 'after_binding_publish';
  const profile = document.source_profile;
  const journalMatches = recovery.journal_sha256 === recoveryJournalDigest(recovery) && profile !== null &&
    recovery.source_profile_sha256 === sourceProfileDigest(profile);
  if (!journalMatches) return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
  if (beforeApproval) {
    if (recovery.approval_payload_sha256 !== null || recovery.approval_receipt_id !== null ||
        recovery.observed_binding_sha256 !== null) {
      return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
    }
  } else {
    const approvalMatches = profile.approval.approved === true && profile.approval.role === 'vault_owner' &&
      profile.approval.delegated === false &&
      recovery.approval_payload_sha256 === sourceProfileApprovalDigest(profile) &&
      recovery.approval_receipt_id === profile.approval.receipt_id &&
      document.observed_binding !== null &&
      recovery.observed_binding_sha256 === sha256Json(document.observed_binding) &&
      sourceProfileBindingCode(document, false) === null;
    if (!approvalMatches) return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
  }
  return observed(document, {
    verdict: 'pass', output: beforeApproval
      ? 'binding recovery returned unbound'
      : afterBinding ? 'published binding recovery preserved idempotently' : 'binding recovery completed',
    operations: beforeApproval
      ? ['read binding journal', 'discard unapproved Source Profile']
      : afterBinding
        ? ['read binding journal', 'validate approval receipt', 'read back published Source Profile binding']
        : ['read binding journal', 'validate approval receipt', 'read back exact Source Profile binding'],
    terminal: beforeApproval ? 'unbound' : 'active',
    effects: beforeApproval
      ? ['discard unapproved binding staging']
      : afterBinding ? ['preserve approved binding'] : ['publish or preserve approved binding'],
  });
}

export async function observeProcessingPolicyScenario(subject, packageRoot) {
  const scenarioCode = await schemaCode(packageRoot, subject.schema, subject.document);
  if (scenarioCode !== null) {
    const document = subject.document;
    return denied(document, scenarioCode, document.operation ?? 'processing_decision');
  }
  const policyCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy.schema.json', subject.document.policy);
  if (policyCode !== null) return denied(subject.document, policyCode, subject.document.operation);
  const receiptCode = await receiptSchemaCode(subject.document, packageRoot);
  if (receiptCode !== null) return denied(subject.document, receiptCode, subject.document.operation);
  switch (subject.document.operation) {
    case 'processing_decision': return observeProcessing(subject.document, packageRoot);
    case 'intake_decision': return observeIntake(subject.document, packageRoot);
    case 'policy_pair': return observePolicyPair(subject.document, packageRoot);
    case 'recover_binding': {
      const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', subject.document.source_profile);
      return profileCode === null ? observeRecovery(subject.document) : denied(subject.document, profileCode, 'recovery');
    }
    default: throw new Error('scenario schema allowed an unknown operation');
  }
}
