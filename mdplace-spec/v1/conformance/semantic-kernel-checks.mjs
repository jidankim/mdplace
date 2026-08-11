import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';
import {semanticKernelEvidenceCodes} from './semantic-kernel-evidence.mjs';

const scenarioCategories = new Set([
  'positive', 'negative', 'exact_boundary', 'stale_state',
  'authority_denial', 'illegal_transition', 'crash_recovery',
]);

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'semantic-kernel-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

export async function checkSemanticKernelContract(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const registry = await readJson(packageRoot, 'contracts/semantic-operation-kinds.json');
  const table = await readJson(packageRoot, 'contracts/transitions/semantic-kernel-lifecycle.json');
  const recovery = await readJson(packageRoot, 'conformance/evidence/semantic-kernel-recovery-report.json');
  const roots = [
    [registry, 'contracts/schemas/semantic-operation-kind-registry.schema.json'],
    [table, 'contracts/schemas/transition-table.schema.json'],
    [recovery, 'contracts/schemas/semantic-kernel-recovery-report.schema.json'],
  ];
  for (const [document, schemaPath] of roots) {
    const code = await schemaCode(packageRoot, schemaPath, document);
    if (code !== null) codes.push(code);
  }
  const expectedKinds = [
    ['semantic_assignment', 'assign_value', 'core_v1'],
    ['semantic_removal', 'remove_value', 'core_v1'],
    ['compatibility_marker', 'preserve_state', 'recognized_noop_v1'],
  ];
  if (!Array.isArray(registry?.kinds) || expectedKinds.some(([kind, effect, compatibility], index) => {
    const entry = registry.kinds[index];
    return entry?.operation_kind !== kind || entry?.replay_effect !== effect ||
      entry?.forward_compatibility !== compatibility;
  })) {
    codes.push('semantic.operation_registry_invalid');
  }

  const entries = Array.isArray(conformance?.fixtures)
    ? conformance.fixtures.filter(({fixture_id: id}) => typeof id === 'string' && id.startsWith('FIX-SK-'))
    : [];
  if (entries.length !== 30) codes.push('semantic.scenario_count_invalid');
  if ([...scenarioCategories].some((category) => !entries.some((entry) => entry.category === category))) {
    codes.push('semantic.scenario_category_missing');
  }
  const scenarioIds = [];
  const deniedPairs = new Set();
  const baseCoverage = new Set();
  const observedCodes = new Set();
  const observedOutputs = new Set();
  for (const entry of entries) {
    if (!/^scenarios\/semantic-kernel\/[a-z0-9][a-z0-9-]*\.json$/.test(entry.path ?? '')) {
      codes.push('semantic.scenario_path_invalid');
      continue;
    }
    const fixture = await readJson(packageRoot, `conformance/${entry.path}`);
    if (fixture?.subject?.kind !== 'semantic_kernel' ||
        fixture.subject.schema !== 'contracts/schemas/semantic-kernel-scenario.schema.json') {
      codes.push('semantic.scenario_subject_invalid');
      continue;
    }
    const code = await schemaCode(packageRoot, fixture.subject.schema, fixture.subject.document);
    if (code !== null) codes.push(code);
    scenarioIds.push(fixture.subject.document?.scenario_id);
    for (const expectedCode of fixture.expected?.codes ?? []) observedCodes.add(expectedCode);
    for (const output of fixture.expected?.outputs ?? []) observedOutputs.add(output);
    const {action, initial} = fixture.subject.document;
    const base = action?.kind === 'append' ? action.base_references?.[0] : undefined;
    if (base?.kind === 'semantic_head') {
      const direction = base.sequence < initial.head.sequence ? 'past'
        : base.sequence > initial.head.sequence ? 'future' : 'exact';
      if (fixture.expected?.verdict === 'pass' && direction === 'exact') baseCoverage.add('exact:accepted');
      if (fixture.expected?.codes?.includes('semantic.base_stale') && direction !== 'exact') {
        baseCoverage.add(`${direction}:rejected`);
      }
    }
    const requiredReceiptSchemaId = entry.category === 'crash_recovery'
      ? 'mdplace.semantic-recovery-receipt/v1'
      : fixture.expected?.verdict === 'fail' ? 'mdplace.semantic-rejection-receipt/v1' : null;
    if (requiredReceiptSchemaId !== null) {
      let validReceiptFound = false;
      for (const receipt of fixture.expected?.receipts ?? []) {
        if (typeof receipt !== 'string' || !receipt.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(receipt);
          if (parsed.schema_id === requiredReceiptSchemaId &&
              await schemaCode(packageRoot, 'contracts/schemas/semantic-receipt.schema.json', parsed) === null) {
            validReceiptFound = true;
          }
        } catch {
          // The closed receipt requirement below records the deterministic package failure.
        }
      }
      if (!validReceiptFound) codes.push('semantic.receipt_evidence_invalid');
    }
    if (entry.category === 'illegal_transition' && fixture.expected?.illegal_transition === true) {
      const command = fixture.subject.document?.action?.kind === 'append' ? 'append_operation' : 'recover_operation';
      deniedPairs.add(`${fixture.subject.document?.initial?.lifecycle_state}:${command}`);
    }
  }
  const expectedScenarioIds = Array.from({length: 30}, (_, index) => `SK-${String(index + 1).padStart(3, '0')}`);
  if (new Set(scenarioIds).size !== 30 || expectedScenarioIds.some((id) => !scenarioIds.includes(id))) {
    codes.push('semantic.scenario_identity_invalid');
  }
  const requiredCodes = [
    'semantic.base_stale', 'semantic.ordering_invalid', 'semantic.idempotency_incompatible',
    'semantic.operation_unknown', 'semantic.record_malformed', 'semantic.record_torn',
    'semantic.record_noncanonical', 'semantic.authority_denied', 'semantic.snapshot_stale',
    'semantic.precondition_failed', 'semantic.schema_version_unsupported',
    'semantic.recovery_required', 'semantic.recovery_not_required',
  ];
  const requiredOutputs = ['append accepted', 'append idempotent', 'replay accepted', 'view rebuilt', 'recovery completed'];
  if (requiredCodes.some((code) => !observedCodes.has(code)) ||
      requiredOutputs.some((output) => !observedOutputs.has(output))) {
    codes.push('semantic.required_behavior_uncovered');
  }
  if (['exact:accepted', 'past:rejected', 'future:rejected'].some((coverage) => !baseCoverage.has(coverage))) {
    codes.push('semantic.base_direction_uncovered');
  }
  const deniedRows = Array.isArray(table?.transitions)
    ? table.transitions.filter(({allowed}) => allowed === false).map(({from_state: state, command_or_event: command}) => `${state}:${command}`)
    : [];
  if (deniedRows.some((pair) => !deniedPairs.has(pair))) codes.push('semantic.illegal_transition_uncovered');

  const fixtureIds = entries.map(({fixture_id: id}) => id);
  if (recovery?.validator_version !== manifest?.validator_version ||
      recovery?.scenario_count !== 30 ||
      !Array.isArray(recovery?.scenario_ids) ||
      recovery.scenario_ids.length !== fixtureIds.length ||
      fixtureIds.some((id) => !recovery.scenario_ids.includes(id))) {
    codes.push('semantic.recovery_evidence_invalid');
  }
  codes.push(...await semanticKernelEvidenceCodes(packageRoot, recovery, entries));
  const decision = Array.isArray(traceability?.decisions)
    ? traceability.decisions.find(({decision_id: id}) => id === 'DEC-002')
    : undefined;
  if (decision?.url !== 'https://github.com/jidankim/mdplace/issues/2#issuecomment-5012541174' ||
      decision?.status !== 'accepted' || decision?.use !== 'input_without_reopening') {
    codes.push('semantic.decision_invalid');
  }
  return result(codes);
}
