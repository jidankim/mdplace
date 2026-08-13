import {createHash} from 'node:crypto';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  policyNarrowingViolation,
  recoveryJournalDigest,
  sha256Json,
  sourceProfileApprovalDigest,
  sourceProfileDigest,
} from './processing-policy-core.mjs';
import {
  approvalReadbackCode,
  processingDenialCode,
  sourceProfileBindingCode,
} from './processing-policy-decision.mjs';
import {
  processingPolicyDenied as denied,
  processingPolicyObserved as observed,
} from './processing-policy-result.mjs';
import {readPackageFile} from './safe-path.mjs';

async function schemaCode(packageRoot, path, value) {
  if (value === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, path, value));
  } catch {
    return 'schema.instance_missing';
  }
}

async function receiptSchemaCode(document, packageRoot) {
  if (new Set(document.approval_receipts.map(({receipt_id: id}) => id)).size !==
      document.approval_receipts.length) return 'policy.approval_readback_failed';
  if (new Set(document.redaction_receipts.map(({receipt_id: id}) => id)).size !==
      document.redaction_receipts.length) return 'policy.redaction_unproven';
  if (new Set(document.attempt_receipts.map(({receipt_id: id}) => id)).size !==
      document.attempt_receipts.length) return 'policy.retry_exceeded';
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
  for (const attemptReceipt of document.attempt_receipts) {
    if (await schemaCode(packageRoot, 'contracts/schemas/processing-attempt-receipt.schema.json', attemptReceipt) !== null) {
      return 'policy.retry_exceeded';
    }
  }
  return null;
}

async function trustedContext(packageRoot, scenarioId, vaultId) {
  const path = 'contracts/processing-policy-trust-store.json';
  const [read, manifestRead] = await Promise.all([
    readPackageFile(packageRoot, path),
    readPackageFile(packageRoot, 'package-manifest.yaml'),
  ]);
  if (read.status !== 'present' || manifestRead.status !== 'present') return null;
  let store;
  let manifest;
  try {
    store = JSON.parse(read.content.toString('utf8'));
    manifest = JSON.parse(manifestRead.content.toString('utf8'));
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(read.content).digest('hex');
  const bindings = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter(({path: artifactPath}) => artifactPath === path)
    : [];
  if (bindings.length !== 1 || bindings[0].authority !== 'normative' || bindings[0].sha256 !== digest) return null;
  if (await schemaCode(packageRoot, 'contracts/schemas/processing-policy-trust-store.schema.json', store) !== null) {
    return null;
  }
  const matches = store.scenarios.filter(({scenario_id: id, vault_id: trustedVault}) =>
    id === scenarioId && trustedVault === vaultId);
  if (matches.length !== 1) return null;
  return {
    context: matches[0],
    digest,
  };
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
  if (document.lifecycle.policy_state !== 'active' || document.policy.lifecycle_state !== 'active' ||
      document.descendant_policy.lifecycle_state !== 'active') return denied(document, 'policy.inactive', 'policy_pair');
  const parentApprovalCode = approvalReadbackCode(document, 'processing_policy', document.policy);
  if (parentApprovalCode !== null) return denied(document, `policy.${parentApprovalCode}`, 'policy_pair');
  const childApprovalCode = approvalReadbackCode(document, 'processing_policy', document.descendant_policy);
  if (childApprovalCode !== null) return denied(document, `policy.${childApprovalCode}`, 'policy_pair');
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
    recovery.source_profile_sha256 === sourceProfileDigest(profile) &&
    recovery.trust_store_sha256 === document.trust_store_sha256;
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
  if (subject?.document === null || typeof subject?.document !== 'object') {
    return {
      verdict: 'fail', codes: ['schema.instance_missing'], outputs: ['processing denied'],
      operations: ['validate scenario boundary'], receipts: [], filesystem_effects: ['none'],
      network_effects: ['none'], terminal_state: 'denied', illegal_transition: false,
    };
  }
  const scenarioCode = await schemaCode(packageRoot, subject.schema, subject.document);
  if (scenarioCode !== null) {
    const document = subject.document;
    return denied(document, scenarioCode, document.operation ?? 'processing_decision');
  }
  const policyCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy.schema.json', subject.document.policy);
  if (policyCode !== null) return denied(subject.document, policyCode, subject.document.operation);
  const trust = await trustedContext(packageRoot, subject.document.scenario_id, subject.document.policy.vault_id);
  if (trust === null) {
    const code = subject.document.operation === 'recover_binding'
      ? 'source_profile.recovery_evidence_invalid'
      : 'policy.approval_readback_failed';
    return denied(subject.document, code, subject.document.operation === 'recover_binding' ? 'recovery' : subject.document.operation);
  }
  const document = {...subject.document, trusted_context: trust.context, trust_store_sha256: trust.digest};
  if (document.operation === 'recover_binding' && document.recovery === null) {
    return denied(document, 'source_profile.recovery_evidence_invalid', 'recovery');
  }
  const receiptCode = await receiptSchemaCode(document, packageRoot);
  if (receiptCode !== null) {
    return denied(document, document.operation === 'recover_binding'
      ? 'source_profile.recovery_evidence_invalid'
      : receiptCode, document.operation === 'recover_binding' ? 'recovery' : document.operation);
  }
  switch (document.operation) {
    case 'processing_decision': return observeProcessing(document, packageRoot);
    case 'intake_decision': return observeIntake(document, packageRoot);
    case 'policy_pair': return observePolicyPair(document, packageRoot);
    case 'recover_binding': {
      const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', document.source_profile);
      return profileCode === null ? observeRecovery(document) : denied(document, profileCode, 'recovery');
    }
    default: throw new Error('scenario schema allowed an unknown operation');
  }
}
