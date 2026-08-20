import {createHash} from 'node:crypto';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {generatorBindingDigest} from './reference-vault-core.mjs';
import {readPackageFile} from './safe-path.mjs';

const exactCounts = {
  captured_tab_notes: 25000,
  observed_note_versions: 100000,
  categories: 1000,
  canonical_events: 1000000,
  queued_candidates: 1000,
};

const roleByOperation = {
  generate: 'reference_vault_generator',
  redistribute: 'vault_owner',
  recover: 'foreground_recovery',
  validate_lifecycle: 'conformance_validator',
};

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function observedFailure(operation, code) {
  const illegal = code === 'corpus.redistribution_illegal' || code === 'generator.lifecycle_illegal';
  return {
    verdict: 'fail',
    codes: [code],
    outputs: ['reference vault operation rejected'],
    operations: [`observe ${operation}`],
    receipts: ['ReferenceVaultDenied'],
    filesystem_effects: ['none'],
    terminal_state: code === 'generator.recovery_unproven' ? 'recovery_required' : 'unchanged',
    illegal_transition: illegal,
  };
}

function observedSuccess(operation, manifestDigest) {
  const resultByOperation = {
    generate: {output: `manifest_sha256:${manifestDigest}`, receipt: 'GeneratorReceipt', state: 'generated'},
    redistribute: {output: 'redistribution accepted', receipt: 'RedistributionReceipt', state: 'redistributed'},
    recover: {output: 'recovery accepted', receipt: 'ReferenceVaultRecoveryReceipt', state: 'recovered'},
    validate_lifecycle: {output: 'lifecycle transition accepted', receipt: 'ReferenceVaultTransitionReceipt', state: 'validated'},
  };
  const observed = resultByOperation[operation];
  return {
    verdict: 'pass',
    codes: [],
    outputs: [observed.output],
    operations: [`observe ${operation}`],
    receipts: [observed.receipt],
    filesystem_effects: ['none'],
    terminal_state: observed.state,
    illegal_transition: false,
  };
}

function bindingCode(document) {
  const binding = document.generator_binding;
  const seedDigest = createHash('sha256').update(binding.seed).digest('hex');
  const calculatedBinding = generatorBindingDigest({
    generator_id: binding.generator_id,
    generator_version: binding.generator_version,
    determinism: {algorithm: 'sha256-counter-v1', seed_sha256: binding.seed_sha256},
  });
  if (binding.seed_sha256 !== seedDigest || binding.binding_sha256 !== calculatedBinding) {
    return 'generator.binding_invalid';
  }
  const key = `${binding.generator_version}\u0000${binding.seed_sha256}`;
  const matching = document.binding_registry.filter((entry) =>
    `${entry.generator_version}\u0000${entry.seed_sha256}` === key);
  if (matching.length !== 1) return 'generator.binding_duplicate';
  if (matching[0].binding_sha256 !== binding.binding_sha256) return 'generator.binding_invalid';
  if (document.current_binding.generator_version !== binding.generator_version ||
      document.current_binding.binding_sha256 !== binding.binding_sha256) return 'generator.binding_stale';
  return null;
}

function corpusCode(document) {
  for (const [dimension, count] of Object.entries(exactCounts)) {
    if (document.scale.counts[dimension] !== count) return `corpus.${dimension}_count_mismatch`;
  }
  if (document.scale.candidate_bytes > document.scale.candidate_size_limit_bytes) {
    return 'corpus.candidate_size_exceeded';
  }
  const accounts = new Map(document.coverage_accounts.map((entry) => [entry.dimension, entry.accounted]));
  if (accounts.size !== 5 || Object.entries(exactCounts).some(([dimension, count]) => accounts.get(dimension) !== count)) {
    return 'corpus.coverage_unaccounted';
  }
  const partitions = document.partition_lineages.map(({partition_id: id}) => id);
  const lineages = document.partition_lineages.flatMap(({lineage_group_ids: ids}) => ids);
  if (new Set(partitions).size !== 3 || new Set(lineages).size !== lineages.length) return 'corpus.lineage_crossing';
  if (document.partition_lineages.some((entry) =>
    entry.membership_sha256_before !== entry.membership_sha256_after)) {
    return 'corpus.partition_membership_mutated';
  }
  return null;
}

function redistributionCode(redistribution, partitionLineages, sealedManifestDigest) {
  if (redistribution === null) return 'corpus.redistribution_illegal';
  if (redistribution.expected_base_manifest_sha256 !== sealedManifestDigest ||
      redistribution.observed_base_manifest_sha256 !== sealedManifestDigest) {
    return 'corpus.redistribution_stale';
  }
  if (redistribution.source_partition !== redistribution.target_partition) return 'corpus.redistribution_illegal';
  if (!redistribution.whole_lineage) return 'corpus.partial_lineage';
  const sourceLineages = partitionLineages.find(({partition_id: id}) =>
    id === redistribution.source_partition)?.lineage_group_ids ?? [];
  if (!sourceLineages.includes(redistribution.lineage_group_id)) return 'corpus.lineage_crossing';
  const prefix = `${redistribution.source_partition}-`;
  if (!redistribution.source_shard.startsWith(prefix) || !redistribution.target_shard.startsWith(prefix) ||
      redistribution.source_shard === redistribution.target_shard) return 'corpus.redistribution_illegal';
  return null;
}

function recoveryCode(recovery) {
  if (recovery === null || !recovery.journal_complete || !recovery.binding_verified) {
    return 'generator.recovery_unproven';
  }
  const decisionByStage = {
    before_manifest: 'restart_from_binding',
    after_manifest: 'retain_sealed_manifest',
    before_redistribution: 'discard_unsealed_plan',
    after_redistribution: 'retain_redistributed_manifest',
  };
  if (recovery.decision !== decisionByStage[recovery.crash_stage] ||
      (recovery.crash_stage !== 'before_manifest' && !recovery.manifest_verified)) {
    return 'generator.recovery_unproven';
  }
  return null;
}

async function lifecycleCode(packageRoot, lifecycle) {
  if (lifecycle === null) return 'generator.lifecycle_illegal';
  const table = await readJson(packageRoot, lifecycle.table_ref);
  const row = table?.transitions?.find(({from_state: state, command_or_event: command}) =>
    state === lifecycle.from_state && command === lifecycle.command);
  return row?.allowed === true ? null : 'generator.lifecycle_illegal';
}

export async function observeReferenceVaultScenario(subject, packageRoot) {
  const schemaErrors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  const schemaCode = schemaErrorCode(schemaErrors);
  if (schemaCode !== null) return observedFailure(subject.document?.operation ?? 'unknown', schemaCode);
  const document = subject.document;
  if (document.actor_role !== roleByOperation[document.operation]) {
    return observedFailure(document.operation, 'generator.authority_denied');
  }
  const manifest = await readJson(packageRoot, 'contracts/reference-vault/corpus-manifest.json');
  const firstCode = bindingCode(document) ?? corpusCode(document) ??
    (document.operation === 'redistribute' ? redistributionCode(
      document.redistribution,
      document.partition_lineages,
      manifest?.manifest_sha256,
    ) : null) ??
    (document.operation === 'recover' ? recoveryCode(document.recovery) : null) ??
    (document.operation === 'validate_lifecycle' ? await lifecycleCode(packageRoot, document.lifecycle) : null);
  if (firstCode !== null) return observedFailure(document.operation, firstCode);
  return observedSuccess(document.operation, manifest?.manifest_sha256 ?? '0'.repeat(64));
}
