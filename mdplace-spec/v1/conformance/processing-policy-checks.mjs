import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {processingPolicyEvidenceCodes} from './processing-policy-evidence.mjs';
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

export async function checkCoreProcessingPolicyContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const [rules, policyTable, profileTable, recovery] = await Promise.all([
    readJson(packageRoot, 'contracts/processing-policy-rules.json'),
    readJson(packageRoot, 'contracts/transitions/processing-policy-lifecycle.json'),
    readJson(packageRoot, 'contracts/transitions/source-profile-lifecycle.json'),
    readJson(packageRoot, 'conformance/evidence/core-processing-policy-recovery-report.json'),
  ]);
  const roots = [
    [rules, 'contracts/schemas/processing-policy-rules.schema.json'],
    [policyTable, 'contracts/schemas/transition-table.schema.json'],
    [profileTable, 'contracts/schemas/transition-table.schema.json'],
    [recovery, 'contracts/schemas/core-processing-policy-recovery-report.schema.json'],
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
    if (document.source_profile !== null) {
      const profileCode = await schemaCode(packageRoot, 'contracts/schemas/source-profile.schema.json', document.source_profile);
      if (profileCode !== null) codes.push(profileCode);
      if (Object.hasOwn(document.source_profile, 'compatibility_evidence')) codes.push('source_profile.compatibility_evidence_embedded');
    }
    if (document.compatibility_claim_ref !== null) externalCompatibilityEvidence = true;
    for (const receiptValue of fixture.expected?.receipts ?? []) {
      let receipt;
      try {
        receipt = JSON.parse(receiptValue);
      } catch {
        codes.push('policy.receipt_invalid');
        continue;
      }
      const receiptCode = await schemaCode(packageRoot, 'contracts/schemas/processing-policy-receipt.schema.json', receipt);
      if (receiptCode !== null) codes.push('policy.receipt_invalid');
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
