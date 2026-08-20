import {createHash} from 'node:crypto';

import {canonicalJson} from './semantic-kernel-core.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Json(value) {
  return sha256(canonicalJson(value));
}

export function scaleManifestDigest(scale) {
  const {scale_sha256: _digest, ...payload} = scale;
  return sha256Json(payload);
}

export function generatorBindingDigest(generator) {
  return sha256Json({
    algorithm: generator.determinism.algorithm,
    generator_id: generator.generator_id,
    generator_version: generator.generator_version,
    seed_sha256: generator.determinism.seed_sha256,
  });
}

export function corpusManifestDigest(manifest) {
  const {manifest_sha256: _digest, ...payload} = manifest;
  return sha256Json(payload);
}

function partition(generator, definition) {
  const membership = {
    binding_sha256: generator.determinism.binding_sha256,
    partition_id: definition.partition_id,
    lineage_range: definition.lineage_range,
    lineage_groups: definition.lineage_groups,
  };
  return {
    ...definition,
    membership: 'immutable',
    shards: [
      {shard_id: `${definition.partition_id}-a`, lineage_groups: Math.floor(definition.lineage_groups / 2)},
      {shard_id: `${definition.partition_id}-b`, lineage_groups: Math.ceil(definition.lineage_groups / 2)},
    ],
    membership_sha256: sha256Json(membership),
  };
}

export function buildReferenceVaultManifest(generator, scale) {
  const partitions = [
    partition(generator, {
      partition_id: 'train',
      lineage_range: 'lineage:000001..lineage:016000',
      lineage_groups: 16000,
      counts: {
        captured_tab_notes: 18000,
        observed_note_versions: 72000,
        canonical_events: 720000,
        queued_candidates: 720,
      },
    }),
    partition(generator, {
      partition_id: 'calibration',
      lineage_range: 'lineage:016001..lineage:019000',
      lineage_groups: 3000,
      counts: {
        captured_tab_notes: 3500,
        observed_note_versions: 14000,
        canonical_events: 140000,
        queued_candidates: 140,
      },
    }),
    partition(generator, {
      partition_id: 'test',
      lineage_range: 'lineage:019001..lineage:022000',
      lineage_groups: 3000,
      counts: {
        captured_tab_notes: 3500,
        observed_note_versions: 14000,
        canonical_events: 140000,
        queued_candidates: 140,
      },
    }),
  ];
  const manifest = {
    $schema: '../schemas/corpus-manifest.schema.json',
    schema_id: 'mdplace.corpus-manifest/v1',
    manifest_id: 'corpus:reference-vault-v1',
    generator_binding: {
      generator_id: generator.generator_id,
      generator_version: generator.generator_version,
      seed_sha256: generator.determinism.seed_sha256,
      binding_sha256: generator.determinism.binding_sha256,
    },
    scale_manifest: {
      ref: 'contracts/reference-vault/scale-manifest.json',
      sha256: scale.scale_sha256,
    },
    partitions,
    global_counts: {categories: scale.counts.categories},
    coverage_accounts: [
      {dimension: 'captured_tab_notes', accounted: scale.counts.captured_tab_notes, accounting_rule: 'partition_sum'},
      {dimension: 'observed_note_versions', accounted: scale.counts.observed_note_versions, accounting_rule: 'partition_sum'},
      {dimension: 'categories', accounted: scale.counts.categories, accounting_rule: 'global_exact'},
      {dimension: 'canonical_events', accounted: scale.counts.canonical_events, accounting_rule: 'partition_sum'},
      {dimension: 'queued_candidates', accounted: scale.counts.queued_candidates, accounting_rule: 'partition_sum'},
    ],
    lineage_rules: {
      grouping: 'duplicate_recapture_history_same-source_and_near-related',
      partition_crossing: 'forbidden',
      redistribution_unit: 'whole_lineage_group_within_partition',
      membership_change: 'forbidden',
    },
  };
  return {...manifest, manifest_sha256: sha256Json(manifest)};
}
