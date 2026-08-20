import {createHash} from 'node:crypto';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  classifyRedistributionShards,
  corpusManifestDigest,
  generatorBindingDigest,
  lineageBelongsToPartition,
  sha256Json,
} from './reference-vault-core.mjs';
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
};

async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {status: read.status, document: null, content: null};
  try {
    return {status: 'present', document: JSON.parse(read.content.toString('utf8')), content: read.content};
  } catch {
    return {status: 'invalid', document: null, content: read.content};
  }
}

async function validatedArtifact(packageRoot, artifact) {
  const {path, schemaPath, unavailableCode, invalidCode} = artifact;
  const read = await readJson(packageRoot, path);
  if (read.status === 'invalid') return {code: invalidCode, document: null, content: read.content};
  if (read.status !== 'present') return {code: unavailableCode, document: null, content: null};
  try {
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, read.document));
    if (code !== null) return {code: invalidCode, document: null, content: read.content};
  } catch {
    return {code: invalidCode, document: null, content: read.content};
  }
  return {code: null, document: read.document, content: read.content};
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

function observedResult(operation, manifestDigest, lifecycleRow) {
  if (operation === 'validate_lifecycle' && !lifecycleRow.allowed) {
    return {
      verdict: 'fail',
      codes: [lifecycleRow.failure_result.code],
      outputs: [`transition_sha256:${sha256Json(lifecycleRow)}`],
      operations: [`observe ${operation}`],
      receipts: lifecycleRow.failure_result.emitted_records,
      filesystem_effects: lifecycleRow.failure_result.filesystem_effects,
      terminal_state: lifecycleRow.terminal_state,
      illegal_transition: true,
    };
  }
  const resultByOperation = {
    generate: {outputs: [`manifest_sha256:${manifestDigest}`], receipts: ['GeneratorReceipt'], effects: ['none'], state: 'generated'},
    redistribute: {outputs: ['redistribution accepted'], receipts: ['RedistributionReceipt'], effects: ['none'], state: 'redistributed'},
    recover: {outputs: ['recovery accepted'], receipts: ['ReferenceVaultRecoveryReceipt'], effects: ['none'], state: 'recovered'},
  };
  const observed = operation === 'validate_lifecycle' ? {
      outputs: [`transition_sha256:${sha256Json(lifecycleRow)}`],
      receipts: lifecycleRow.emitted_records,
      effects: lifecycleRow.filesystem_effects,
      state: lifecycleRow.terminal_state,
    } : resultByOperation[operation];
  return {
    verdict: 'pass',
    codes: [],
    outputs: observed.outputs,
    operations: [`observe ${operation}`],
    receipts: observed.receipts,
    filesystem_effects: observed.effects,
    terminal_state: observed.state,
    illegal_transition: false,
  };
}

function bindingCode(document, manifest) {
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
  if (manifest.generator_binding.generator_id !== binding.generator_id ||
      manifest.generator_binding.generator_version !== binding.generator_version ||
      manifest.generator_binding.seed_sha256 !== binding.seed_sha256 ||
      manifest.generator_binding.binding_sha256 !== binding.binding_sha256) return 'generator.binding_invalid';
  return null;
}

function corpusCode(document, manifest) {
  for (const [dimension, count] of Object.entries(exactCounts)) {
    if (document.scale.counts[dimension] !== count) return `corpus.${dimension}_count_mismatch`;
  }
  if (document.scale.candidate_bytes > document.scale.candidate_size_limit_bytes) {
    return 'corpus.candidate_size_exceeded';
  }
  const accounts = new Map(document.coverage_accounts.map((entry) => [entry.dimension, entry.accounted]));
  if (document.coverage_accounts.length !== 5 || accounts.size !== document.coverage_accounts.length ||
      Object.entries(exactCounts).some(([dimension, count]) => accounts.get(dimension) !== count)) {
    return 'corpus.coverage_unaccounted';
  }
  const partitions = document.partition_lineages.map(({partition_id: id}) => id);
  const lineages = document.partition_lineages.flatMap(({lineage_group_ids: ids}) => ids);
  if (new Set(partitions).size !== 3 || new Set(lineages).size !== lineages.length) return 'corpus.lineage_crossing';
  const sealedPartitions = new Map(manifest.partitions.map((partition) => [partition.partition_id, partition]));
  for (const entry of document.partition_lineages) {
    const sealed = sealedPartitions.get(entry.partition_id);
    if (sealed === undefined || entry.membership_sha256_before !== sealed.membership_sha256 ||
        entry.membership_sha256_after !== sealed.membership_sha256) {
      return entry.membership_sha256_before === entry.membership_sha256_after ?
        'corpus.partition_membership_unbound' : 'corpus.partition_membership_mutated';
    }
    if (entry.lineage_group_ids.some((lineageId) => !lineageBelongsToPartition(lineageId, sealed.lineage_range))) {
      return 'corpus.lineage_crossing';
    }
  }
  return null;
}

function redistributionCode(redistribution, partitionLineages, manifest) {
  if (redistribution === null) return 'corpus.redistribution_illegal';
  if (redistribution.expected_base_manifest_sha256 !== manifest.manifest_sha256 ||
      redistribution.observed_base_manifest_sha256 !== manifest.manifest_sha256) {
    return 'corpus.redistribution_stale';
  }
  if (redistribution.source_partition !== redistribution.target_partition) return 'corpus.redistribution_illegal';
  if (!redistribution.whole_lineage) return 'corpus.partial_lineage';
  const sourceLineages = partitionLineages.find(({partition_id: id}) =>
    id === redistribution.source_partition)?.lineage_group_ids ?? [];
  if (!sourceLineages.includes(redistribution.lineage_group_id)) return 'corpus.lineage_crossing';
  const {sourceShard, targetShard, sourceLineageBound} = classifyRedistributionShards(redistribution, manifest);
  if (sourceShard === undefined || targetShard === undefined || sourceShard === targetShard) {
    return 'corpus.redistribution_illegal';
  }
  if (!sourceLineageBound) return 'corpus.lineage_crossing';
  return null;
}

function recoveryCode(recovery, evidenceArtifact) {
  const {report, content, generatorBindingSha256, manifestSha256} = evidenceArtifact;
  if (recovery === null || content === null ||
      createHash('sha256').update(content).digest('hex') !== recovery.evidence_sha256 ||
      report.binding_sha256 !== generatorBindingSha256 ||
      report.first_manifest_sha256 !== manifestSha256) return 'generator.recovery_unproven';
  const evidence = report.recovery_cases.find(({evidence_id: id}) => id === recovery.evidence_id);
  if (evidence === undefined || evidence.crash_stage !== recovery.crash_stage ||
      evidence.decision !== recovery.decision ||
      evidence.generator_binding_sha256 !== generatorBindingSha256 ||
      evidence.manifest_sha256 !== (recovery.crash_stage === 'before_manifest' ? null : manifestSha256)) {
    return 'generator.recovery_unproven';
  }
  return null;
}

async function lifecycleResult(packageRoot, lifecycle, actorRole) {
  if (lifecycle === null) return {code: 'generator.lifecycle_illegal', row: null};
  const tableArtifact = await validatedArtifact(packageRoot, {
    path: lifecycle.table_ref,
    schemaPath: 'contracts/schemas/transition-table.schema.json',
    unavailableCode: 'generator.lifecycle_illegal',
    invalidCode: 'generator.lifecycle_illegal',
  });
  if (tableArtifact.code !== null) return {code: tableArtifact.code, row: null};
  const row = tableArtifact.document.transitions.find(({from_state: state, command_or_event: command}) =>
    state === lifecycle.from_state && command === lifecycle.command);
  if (row === undefined || lifecycle.transition_sha256 !== sha256Json(row)) {
    return {code: 'generator.lifecycle_illegal', row: null};
  }
  if (!row.actor_authority.roles.includes(actorRole)) return {code: 'generator.authority_denied', row: null};
  return {code: null, row};
}

export async function observeReferenceVaultScenario(subject, packageRoot) {
  let schemaErrors;
  try {
    schemaErrors = await validateAgainstSchemaPath(packageRoot, subject.schema, subject.document);
  } catch {
    return observedFailure(subject?.document?.operation ?? 'unknown', 'fixture.schema_unresolved');
  }
  const schemaCode = schemaErrorCode(schemaErrors);
  if (schemaCode !== null) return observedFailure(subject.document?.operation ?? 'unknown', schemaCode);
  const document = subject.document;
  if (document.operation !== 'validate_lifecycle' && document.actor_role !== roleByOperation[document.operation]) {
    return observedFailure(document.operation, 'generator.authority_denied');
  }
  const manifestArtifact = await validatedArtifact(packageRoot, {
    path: 'contracts/reference-vault/corpus-manifest.json',
    schemaPath: 'contracts/schemas/corpus-manifest.schema.json',
    unavailableCode: 'generator.manifest_unavailable',
    invalidCode: 'generator.manifest_invalid',
  });
  if (manifestArtifact.code !== null) return observedFailure(document.operation, manifestArtifact.code);
  const manifest = manifestArtifact.document;
  if (manifest.manifest_sha256 !== corpusManifestDigest(manifest)) {
    return observedFailure(document.operation, 'generator.manifest_invalid');
  }

  let firstCode = bindingCode(document, manifest) ?? corpusCode(document, manifest);
  let lifecycleRow = null;
  if (firstCode === null && document.operation === 'redistribute') {
    firstCode = redistributionCode(document.redistribution, document.partition_lineages, manifest);
  }
  if (firstCode === null && document.operation === 'recover') {
    const evidence = await validatedArtifact(packageRoot, {
      path: 'conformance/evidence/reference-vault-recovery-report.json',
      schemaPath: 'contracts/schemas/reference-vault-recovery-report.schema.json',
      unavailableCode: 'generator.recovery_evidence_invalid',
      invalidCode: 'generator.recovery_evidence_invalid',
    });
    firstCode = evidence.code ?? recoveryCode(document.recovery, {
      report: evidence.document,
      content: evidence.content,
      generatorBindingSha256: document.generator_binding.binding_sha256,
      manifestSha256: manifest.manifest_sha256,
    });
  }
  if (firstCode === null && document.operation === 'validate_lifecycle') {
    const lifecycle = await lifecycleResult(packageRoot, document.lifecycle, document.actor_role);
    firstCode = lifecycle.code;
    lifecycleRow = lifecycle.row;
  }
  if (firstCode !== null) return observedFailure(document.operation, firstCode);
  return observedResult(document.operation, manifest.manifest_sha256, lifecycleRow);
}
