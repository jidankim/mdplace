import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {processingPolicyDigest, processingPolicyReceiptDigest, sourceProfileDigest} from './processing-policy-core.mjs';
import {processingAttemptReceiptDigest} from './processing-policy-attempts.mjs';
import {processingPolicyEvidenceCodes} from './processing-policy-evidence.mjs';
import {observeProcessingPolicyScenario} from './processing-policy-observer.mjs';
import {observeProcessingPolicyLifecycleTransition} from './processing-policy-result.mjs';
import {readPackageFile} from './safe-path.mjs';

const requiredCategories = [
  'positive', 'negative', 'exact_boundary', 'stale_state',
  'authority_denial', 'illegal_transition', 'crash_recovery',
];

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'core-processing-policy-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

async function schemaCode(packageRoot, schemaPath, document) {
  if (document === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document));
  } catch {
    return 'schema.instance_missing';
  }
}

function tableIsComplete(table) {
  const rows = table?.transitions ?? [];
  const keys = rows.map(({from_state: state, command_or_event: command}) => `${state}\u0000${command}`);
  return rows.length === table?.states?.length * table?.commands?.length && new Set(keys).size === rows.length &&
    table.states.every((state) => table.commands.every((command) => keys.includes(`${state}\u0000${command}`)));
}

function sortedDigests(values) {
  return [...new Set(values)].sort();
}

export async function checkCoreProcessingPolicyContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const [rules, policyTable, profileTable, recovery, claimsIndex, trustStore] = await Promise.all([
    readJson(packageRoot, 'contracts/processing-policy-rules.json'),
    readJson(packageRoot, 'contracts/transitions/processing-policy-lifecycle.json'),
    readJson(packageRoot, 'contracts/transitions/source-profile-lifecycle.json'),
    readJson(packageRoot, 'conformance/evidence/core-processing-policy-recovery-report.json'),
    readJson(packageRoot, 'claims-and-evidence.yaml'),
    readJson(packageRoot, 'contracts/processing-policy-trust-store.json'),
  ]);
  const roots = [
    [rules, 'contracts/schemas/processing-policy-rules.schema.json'],
    [policyTable, 'contracts/schemas/transition-table.schema.json'],
    [profileTable, 'contracts/schemas/transition-table.schema.json'],
    [recovery, 'contracts/schemas/core-processing-policy-recovery-report.schema.json'],
    [trustStore, 'contracts/schemas/processing-policy-trust-store.schema.json'],
  ];
  for (const [document, schemaPath] of roots) {
    const code = await schemaCode(packageRoot, schemaPath, document);
    if (code !== null) codes.push(code);
  }

  const declaredEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const classified = await Promise.all(declaredEntries.map(async (entry) => {
    const fixture = typeof entry?.path === 'string' ? await readJson(packageRoot, `conformance/${entry.path}`) : null;
    const owned = (typeof entry?.fixture_id === 'string' && entry.fixture_id.startsWith('FIX-CPP-')) ||
      (typeof entry?.path === 'string' && entry.path.startsWith('scenarios/core-processing-policy/')) ||
      fixture?.subject?.kind === 'processing_policy' ||
      fixture?.subject?.schema === 'contracts/schemas/processing-policy-scenario.schema.json';
    return {entry, fixture, owned};
  }));
  const owned = classified.filter(({owned: isOwned}) => isOwned);
  const entries = owned.map(({entry}) => entry);
  if (entries.length !== 50) codes.push('policy.scenario_count_invalid');
  if (requiredCategories.some((category) => !entries.some((entry) => entry.category === category))) {
    codes.push('policy.scenario_category_missing');
  }
  const scenarioIds = [];
  const operations = new Set();
  const claimEntries = Array.isArray(claimsIndex?.claims) ? claimsIndex.claims : [];
  let externalCompatibilityEvidence = false;
  for (const {entry, fixture} of owned) {
    if (!entry.fixture_id?.startsWith('FIX-CPP-') ||
        !/^scenarios\/core-processing-policy\/[a-z0-9][a-z0-9-]*\.json$/.test(entry.path ?? '') ||
        fixture?.fixture_id !== entry.fixture_id || fixture?.category !== entry.category ||
        fixture?.subject?.kind !== 'processing_policy' ||
        fixture?.subject?.schema !== 'contracts/schemas/processing-policy-scenario.schema.json') {
      codes.push('policy.scenario_manifest_pair_invalid');
      continue;
    }
    const scenarioCode = await schemaCode(packageRoot, fixture.subject.schema, fixture.subject.document);
    if (scenarioCode !== null) {
      codes.push(scenarioCode);
      continue;
    }
    const document = fixture.subject.document;
    scenarioIds.push(document.scenario_id);
    operations.add(document.operation);
    const trust = trustStore?.scenarios?.filter(({scenario_id: id}) => id === document.scenario_id) ?? [];
    const expectedPolicies = [document.policy, document.descendant_policy].filter(Boolean).map((policy) => ({
      policy_id: policy.policy_id, policy_version: policy.policy_version,
      policy_sha256: processingPolicyDigest(policy), lifecycle_state: document.lifecycle.policy_state,
    }));
    const expectedProfiles = document.source_profile === null ? [] : [{
      profile_id: document.source_profile.profile_id, profile_version: document.source_profile.profile_version,
      profile_sha256: sourceProfileDigest(document.source_profile), lifecycle_state: document.lifecycle.source_profile_state,
    }];
    if (trust.length !== 1 || trust[0].vault_id !== document.policy.vault_id ||
        !isDeepStrictEqual(trust[0].policy_bindings, expectedPolicies) ||
        !isDeepStrictEqual(trust[0].source_profile_bindings, expectedProfiles) ||
        !isDeepStrictEqual(trust[0].approval_receipt_sha256s,
          sortedDigests(document.approval_receipts.map(({receipt_sha256: digest}) => digest))) ||
        !isDeepStrictEqual(trust[0].redaction_receipt_sha256s,
          sortedDigests(document.redaction_receipts.map(({receipt_sha256: digest}) => digest))) ||
        !isDeepStrictEqual(trust[0].attempt_receipt_sha256s,
          sortedDigests(document.attempt_receipts.map(({receipt_sha256: digest}) => digest)))) {
      codes.push('policy.trust_store_invalid');
    }
    if (document.source_profile !== null) {
      const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', document.source_profile);
      if (profileCode !== null) codes.push(profileCode);
      if (Object.hasOwn(document.source_profile, 'compatibility_evidence')) codes.push('source_profile.compatibility_evidence_embedded');
    }
    if (document.compatibility_claim_ref !== null) {
      const claim = claimEntries.find(({claim_id: id}) => id === document.compatibility_claim_ref);
      const claimManifest = typeof claim?.manifest_ref === 'string' ? await readJson(packageRoot, claim.manifest_ref) : null;
      const claimRead = typeof claim?.manifest_ref === 'string'
        ? await readPackageFile(packageRoot, claim.manifest_ref)
        : {status: 'missing'};
      const digest = claimRead.status === 'present'
        ? createHash('sha256').update(claimRead.content).digest('hex')
        : null;
      if (claimManifest?.claim_id === document.compatibility_claim_ref && digest === claim?.sha256) {
        externalCompatibilityEvidence = true;
      } else {
        codes.push('source_profile.compatibility_claim_invalid');
      }
    }
    for (const approvalReceipt of document.approval_receipts) {
      if (await schemaCode(packageRoot, 'contracts/schemas/approval-receipt.schema.json', approvalReceipt) !== null) {
        codes.push('policy.approval_receipt_invalid');
      }
    }
    for (const redactionReceipt of document.redaction_receipts) {
      if (await schemaCode(packageRoot, 'contracts/schemas/redaction-receipt.schema.json', redactionReceipt) !== null) {
        codes.push('policy.redaction_receipt_invalid');
      }
    }
    for (const attemptReceipt of document.attempt_receipts) {
      if (await schemaCode(packageRoot, 'contracts/schemas/processing-attempt-receipt.schema.json', attemptReceipt) !== null ||
          attemptReceipt.receipt_sha256 !== processingAttemptReceiptDigest(attemptReceipt)) {
        codes.push('policy.attempt_receipt_invalid');
      }
    }
    for (const receiptValue of fixture.expected?.receipts ?? []) {
      let receipt;
      try {
        receipt = JSON.parse(receiptValue);
      } catch {
        codes.push('policy.receipt_invalid');
        continue;
      }
      const receiptCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy-receipt.schema.json', receipt);
      if (receiptCode !== null || receipt.receipt_sha256 !== processingPolicyReceiptDigest(receipt)) {
        codes.push('policy.receipt_invalid');
      }
    }
    for (const recoveryCase of document.recovery_denials) {
      for (const approvalReceipt of recoveryCase.approval_receipts) {
        if (await schemaCode(packageRoot, 'contracts/schemas/approval-receipt.schema.json', approvalReceipt) !== null) {
          codes.push('policy.recovery_denial_invalid');
        }
      }
      const caseSubject = structuredClone(fixture.subject);
      caseSubject.document.recovery_denials = [];
      caseSubject.document.recovery = recoveryCase.recovery;
      caseSubject.document.approval_receipts = recoveryCase.approval_receipts;
      const observed = await observeProcessingPolicyScenario(caseSubject, packageRoot);
      if (!isDeepStrictEqual(observed, recoveryCase.expected)) codes.push('policy.recovery_denial_invalid');
    }
    if (fixture.expected?.network_effects?.length !== 1 || fixture.expected.network_effects[0] !== 'none') {
      codes.push('policy.network_effects_invalid');
    }
  }
  const expectedScenarioIds = Array.from({length: 50}, (_, index) => `CPP-${String(index + 1).padStart(3, '0')}`);
  if (new Set(scenarioIds).size !== 50 || expectedScenarioIds.some((id) => !scenarioIds.includes(id))) {
    codes.push('policy.scenario_identity_invalid');
  }
  if (['processing_decision', 'intake_decision', 'policy_pair', 'recover_binding'].some((operation) => !operations.has(operation))) {
    codes.push('policy.required_operation_uncovered');
  }
  if (!externalCompatibilityEvidence) codes.push('source_profile.compatibility_evidence_external_missing');
  if (!tableIsComplete(policyTable) || !tableIsComplete(profileTable)) codes.push('policy.lifecycle_incomplete');
  const declaredDenials = owned.flatMap(({fixture}) => fixture?.subject?.document?.lifecycle_denials ?? []);
  const tables = new Map([policyTable, profileTable].map((table) => [table?.table_id, table]));
  const observedDenials = declaredDenials.map((attempt) =>
    observeProcessingPolicyLifecycleTransition(tables.get(attempt.table_id), attempt));
  if (declaredDenials.length !== 22 || observedDenials.some((observed, index) =>
    !isDeepStrictEqual(observed, declaredDenials[index].expected))) {
    codes.push('policy.lifecycle_denial_coverage_missing');
  }
  const recoveryDenialIds = owned.flatMap(({fixture}) =>
    fixture?.subject?.document?.recovery_denials?.map(({case_id: id}) => id) ?? []);
  if (!isDeepStrictEqual(recoveryDenialIds.sort(), [
    'ambiguous_approval_receipt', 'mismatched_binding', 'missing_recovery', 'torn_journal',
  ])) codes.push('policy.recovery_denial_coverage_missing');
  const transition = (state, command) => profileTable?.transitions?.find((row) =>
    row.from_state === state && row.command_or_event === command);
  if (transition('unbound', 'activate_source_profile')?.failure_result?.state_effect !== 'recovery_required' ||
      transition('active', 'invalidate_source_profile')?.terminal_state !== 'stale' ||
      transition('recovery_required', 'recover_unapproved_source_profile')?.terminal_state !== 'unbound' ||
      transition('recovery_required', 'recover_approved_source_profile')?.terminal_state !== 'active') {
    codes.push('source_profile.lifecycle_semantics_invalid');
  }
  const profileStates = new Set(owned.map(({fixture}) => fixture?.subject?.document?.lifecycle?.source_profile_state));
  if (!profileStates.has('stale') || !profileStates.has('revoked')) codes.push('source_profile.lifecycle_coverage_missing');
  if (recovery?.validator_version !== manifest?.validator_version || recovery?.scenario_count !== 50) {
    codes.push('policy.recovery_evidence_invalid');
  }
  codes.push(...await processingPolicyEvidenceCodes(packageRoot, recovery, entries, rules));

  const decision = Array.isArray(traceability?.decisions)
    ? traceability.decisions.find((entry) => entry?.decision_id === 'DEC-008')
    : undefined;
  if (decision?.url !== 'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093' ||
      decision?.status !== 'accepted' || decision?.use !== 'input_without_reopening') {
    codes.push('policy.decision_invalid');
  }
  const cppRecords = Array.isArray(traceability?.records)
    ? traceability.records.filter((entry) =>
      typeof entry?.requirement_id === 'string' && entry.requirement_id.startsWith('REQ-CPP-'))
    : [];
  if (cppRecords.length !== 7 || cppRecords.some(({decision_ids: ids}) =>
    !Array.isArray(ids) || ids.length !== 1 || ids[0] !== 'DEC-008')) {
    codes.push('policy.traceability_decision_invalid');
  }
  return result(codes);
}
