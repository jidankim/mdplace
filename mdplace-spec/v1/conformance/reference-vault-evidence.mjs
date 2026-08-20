import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {checkTransitionTable} from './package-checks.mjs';
import {readPackageFile} from './safe-path.mjs';

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {document: null, content: null};
  try {
    return {document: JSON.parse(read.content.toString('utf8')), content: read.content};
  } catch {
    return {document: null, content: read.content};
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

function sha256(content) {
  return content === null ? null : createHash('sha256').update(content).digest('hex');
}

function expectedOutcome(fixtureId) {
  if (fixtureId === 'FIX-RVG-REC-001') return 'restart_from_binding';
  if (fixtureId === 'FIX-RVG-REC-002') return 'retain_redistributed_manifest';
  if (fixtureId === 'FIX-RVG-REC-003') return 'denied';
  return 'not_applicable';
}

export async function referenceVaultEvidenceCodes(packageRoot, generator, scale, manifest) {
  const codes = [];
  const [
    {document: conformance},
    {document: traceability},
    {document: recovery},
    {document: generationTable, content: generationBytes},
    {document: redistributionTable, content: redistributionBytes},
  ] = await Promise.all([
    readJson(packageRoot, 'conformance/manifest.yaml'),
    readJson(packageRoot, 'traceability.yaml'),
    readJson(packageRoot, 'conformance/evidence/reference-vault-recovery-report.json'),
    readJson(packageRoot, 'contracts/transitions/reference-vault-generation-lifecycle.json'),
    readJson(packageRoot, 'contracts/transitions/reference-vault-redistribution-lifecycle.json'),
  ]);
  const roots = [
    [recovery, 'contracts/schemas/reference-vault-recovery-report.schema.json'],
    [generationTable, 'contracts/schemas/transition-table.schema.json'],
    [redistributionTable, 'contracts/schemas/transition-table.schema.json'],
  ];
  for (const [document, schemaPath] of roots) {
    const code = await schemaCode(packageRoot, schemaPath, document);
    if (code !== null) codes.push(code);
  }
  if (generationTable === null || redistributionTable === null || recovery === null) return codes;
  if (checkTransitionTable(generationTable, 'reference-vault-generation-lifecycle').verdict !== 'pass' ||
      checkTransitionTable(redistributionTable, 'reference-vault-redistribution-lifecycle').verdict !== 'pass') {
    codes.push('generator.lifecycle_incomplete');
  }

  const fixtures = (conformance?.fixtures ?? []).filter(({fixture_id: id}) => id?.startsWith('FIX-RVG-'));
  const categories = new Set(fixtures.map(({category}) => category));
  const requiredCategories = [
    'positive', 'negative', 'below_boundary', 'exact_boundary', 'over_boundary',
    'stale_state', 'authority_denial', 'illegal_transition', 'crash_recovery',
  ];
  if (fixtures.length !== 32 || requiredCategories.some((category) => !categories.has(category)) ||
      ['below_boundary', 'exact_boundary', 'over_boundary'].some((category) =>
        fixtures.filter((fixture) => fixture.category === category).length !== 6)) {
    codes.push('corpus.fixture_inventory_invalid');
  }
  const fixtureIds = fixtures.map(({fixture_id: id}) => id);
  const reportResults = recovery.scenario_results ?? [];
  if (!isDeepStrictEqual(reportResults.map(({fixture_id: id}) => id), fixtureIds) ||
      reportResults.some((entry, index) => entry.expected_verdict !== fixtures[index]?.expected_verdict ||
        entry.recovery_outcome !== expectedOutcome(entry.fixture_id))) {
    codes.push('generator.recovery_fixture_binding_invalid');
  }
  const boundaryIds = (category) => fixtures.filter((fixture) => fixture.category === category)
    .map(({fixture_id: id}) => id);
  if (!isDeepStrictEqual(recovery.boundary_coverage, {
    below: boundaryIds('below_boundary'),
    exact: boundaryIds('exact_boundary'),
    over: boundaryIds('over_boundary'),
  })) codes.push('corpus.boundary_evidence_invalid');

  const expectedIsolation = manifest.partitions.map(({partition_id, membership_sha256}) =>
    ({partition_id, membership_sha256, isolated: true}));
  if (!isDeepStrictEqual(recovery.lineage_isolation?.partitions, expectedIsolation) ||
      recovery.lineage_isolation?.cross_partition_lineages !== 0 ||
      recovery.lineage_isolation?.redistribution_unit !== 'whole_lineage_group_within_partition') {
    codes.push('corpus.lineage_evidence_invalid');
  }
  if (recovery.validator_version !== '1.2.0' || recovery.generator_id !== generator.generator_id ||
      recovery.generator_version !== generator.generator_version ||
      recovery.seed_sha256 !== generator.determinism.seed_sha256 ||
      recovery.binding_sha256 !== generator.determinism.binding_sha256 ||
      recovery.scale_manifest_sha256 !== scale.scale_sha256 ||
      recovery.first_manifest_sha256 !== manifest.manifest_sha256 ||
      recovery.repeated_manifest_sha256 !== manifest.manifest_sha256 || !recovery.digest_identical ||
      recovery.generation_table_sha256 !== sha256(generationBytes) ||
      recovery.redistribution_table_sha256 !== sha256(redistributionBytes)) {
    codes.push('generator.seeded_evidence_invalid');
  }
  if (!isDeepStrictEqual(recovery.recovery_outcomes, [
    'restart_from_binding', 'retain_redistributed_manifest', 'denied',
  ]) || !isDeepStrictEqual(recovery.filesystem_effects, ['none'])) {
    codes.push('generator.recovery_evidence_invalid');
  }

  const decision = (traceability?.decisions ?? []).find(({decision_id: id}) => id === 'DEC-010');
  const records = (traceability?.records ?? []).filter(({requirement_id: id}) => id?.startsWith('REQ-RVG-'));
  if (decision?.url !== 'https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153' ||
      decision?.status !== 'accepted' || decision?.use !== 'input_without_reopening' ||
      records.length !== 10 || records.some(({decision_ids: ids}) => !isDeepStrictEqual(ids, ['DEC-010']))) {
    codes.push('generator.traceability_invalid');
  }
  if (recovery.materialization !== 'deferred' || recovery.performance_claim !== 'none') {
    codes.push('generator.scope_boundary_invalid');
  }
  return codes;
}
