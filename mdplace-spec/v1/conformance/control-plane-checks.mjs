import {checkTransitionTable} from './package-checks.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {controlPlaneEvidenceCodes} from './control-plane-evidence.mjs';
import {readPackageFile} from './safe-path.mjs';

const instanceBindings = [
  ['contracts/control-plane/work-journal.json', 'contracts/schemas/work-journal.schema.json'],
  ['contracts/control-plane/scheduler-state.json', 'contracts/schemas/scheduler-state.schema.json'],
  ['contracts/control-plane/agent-state.json', 'contracts/schemas/agent-state.schema.json'],
  ['contracts/control-plane/control-command.json', 'contracts/schemas/control-channel-command.schema.json'],
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
  for (const [instancePath, schemaPath] of instanceBindings) {
    const instance = await readJson(packageRoot, instancePath);
    if (instance === null) {
      codes.push('control.instance_missing');
      continue;
    }
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
    if (!entry.fixture_id?.startsWith('FIX-CP-') ||
        !/^scenarios\/control-plane\/[a-z0-9][a-z0-9-]*\.json$/.test(entry.path ?? '') ||
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

  const recovery = await readJson(packageRoot, 'conformance/evidence/control-plane-recovery-report.json');
  const fixtureIds = controlEntries.map(({entry}) => entry.fixture_id);
  if (recovery?.validator_version !== manifest?.validator_version ||
      recovery?.scenario_count !== 25 ||
      !Array.isArray(recovery?.fixture_ids) ||
      recovery.fixture_ids.length !== 25 ||
      fixtureIds.some((id, index) => recovery.fixture_ids[index] !== id)) {
    codes.push('control.recovery_evidence_invalid');
  }
  codes.push(...await controlPlaneEvidenceCodes(packageRoot, recovery, controlEntries.map(({entry}) => entry)));

  const decisions = new Map((Array.isArray(traceability?.decisions) ? traceability.decisions : [])
    .map((decision) => [decision.decision_id, decision]));
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
