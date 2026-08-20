import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  buildReferenceVaultManifest,
  corpusManifestDigest,
  generatorBindingDigest,
  scaleManifestDigest,
} from './reference-vault-core.mjs';
import {readPackageFile} from './safe-path.mjs';
import {referenceVaultEvidenceCodes} from './reference-vault-evidence.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'reference-vault-contract', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

function exactScaleIsAccounted(scale, manifest) {
  const partitionDimensions = ['captured_tab_notes', 'observed_note_versions', 'canonical_events', 'queued_candidates'];
  const accounts = new Map(manifest.coverage_accounts.map((account) => [account.dimension, account.accounted]));
  const partitionTotalsMatch = partitionDimensions.every((dimension) =>
    manifest.partitions.reduce((sum, partition) => sum + partition.counts[dimension], 0) === scale.counts[dimension]);
  return partitionTotalsMatch && manifest.global_counts.categories === scale.counts.categories &&
    manifest.coverage_accounts.length === accounts.size &&
    Object.entries(scale.counts).every(([dimension, count]) => accounts.get(dimension) === count) &&
    accounts.size === Object.keys(scale.counts).length;
}

function partitionsAreIsolated(manifest) {
  const expected = ['train', 'calibration', 'test'];
  const ids = manifest.partitions.map(({partition_id: id}) => id);
  const ranges = manifest.partitions.map(({lineage_range: range}) => range);
  return isDeepStrictEqual(ids, expected) && new Set(ranges).size === ranges.length &&
    manifest.partitions.every((partition) => partition.membership === 'immutable' &&
      partition.shards.reduce((sum, shard) => sum + shard.lineage_groups, 0) === partition.lineage_groups);
}

function interfaceTablesAreComplete(generator) {
  const generationIds = generator.generation_table.map(({step_id: id}) => id);
  const generationOrders = generator.generation_table.map(({order}) => order);
  const redistributionIds = generator.redistribution_table.map(({rule_id: id}) => id);
  const recoveryStages = generator.recovery_table.map(({crash_stage: stage}) => stage);
  return isDeepStrictEqual(generationIds, ['GEN-001', 'GEN-002', 'GEN-003', 'GEN-004', 'GEN-005', 'GEN-006']) &&
    isDeepStrictEqual(generationOrders, [1, 2, 3, 4, 5, 6]) &&
    isDeepStrictEqual(redistributionIds, ['RED-001', 'RED-002', 'RED-003', 'RED-004', 'RED-005', 'RED-006', 'RED-007', 'RED-008']) &&
    generator.redistribution_table.filter(({allowed}) => allowed).length === 3 &&
    generator.redistribution_table.filter(({allowed}) => !allowed).every(({failure_code: code}) => typeof code === 'string') &&
    isDeepStrictEqual(recoveryStages, ['before_manifest', 'after_manifest', 'before_redistribution', 'after_redistribution']);
}

export async function checkReferenceVaultContract(packageRoot) {
  const codes = [];
  const [scale, generator, manifest] = await Promise.all([
    readJson(packageRoot, 'contracts/reference-vault/scale-manifest.json'),
    readJson(packageRoot, 'contracts/reference-vault/generator-interface.json'),
    readJson(packageRoot, 'contracts/reference-vault/corpus-manifest.json'),
  ]);
  const roots = [
    [scale, 'contracts/schemas/scale-manifest.schema.json'],
    [generator, 'contracts/schemas/reference-vault-generator.schema.json'],
    [manifest, 'contracts/schemas/corpus-manifest.schema.json'],
  ];
  for (const [document, schemaPath] of roots) {
    const code = await schemaCode(packageRoot, schemaPath, document);
    if (code !== null) codes.push(code);
  }
  if (scale === null || generator === null || manifest === null) return result(codes);

  const seedDigest = createHash('sha256').update(generator.determinism.seed).digest('hex');
  if (scale.scale_sha256 !== scaleManifestDigest(scale) ||
      generator.scale_manifest.sha256 !== scale.scale_sha256) {
    codes.push('corpus.scale_binding_invalid');
  }
  if (generator.determinism.seed_sha256 !== seedDigest ||
      generator.determinism.binding_sha256 !== generatorBindingDigest(generator) ||
      manifest.generator_binding.binding_sha256 !== generator.determinism.binding_sha256) {
    codes.push('generator.binding_invalid');
  }
  if (!interfaceTablesAreComplete(generator)) codes.push('generator.table_incomplete');

  const first = buildReferenceVaultManifest(generator, scale);
  const repeated = buildReferenceVaultManifest(generator, scale);
  if (!isDeepStrictEqual(first, repeated) || first.manifest_sha256 !== repeated.manifest_sha256) {
    codes.push('generator.nondeterministic');
  }
  if (!isDeepStrictEqual(first, manifest) || manifest.manifest_sha256 !== corpusManifestDigest(manifest)) {
    codes.push('generator.manifest_digest_invalid');
  }
  if (!exactScaleIsAccounted(scale, manifest)) codes.push('corpus.coverage_unaccounted');
  if (!partitionsAreIsolated(manifest)) codes.push('corpus.lineage_crossing');
  if (scale.materialization !== 'deferred' || generator.materialization !== 'deferred' ||
      scale.performance_claim !== 'none' || generator.performance_claim !== 'none') {
    codes.push('generator.scope_boundary_invalid');
  }
  codes.push(...await referenceVaultEvidenceCodes(packageRoot, generator, scale, manifest));
  return result(codes);
}
