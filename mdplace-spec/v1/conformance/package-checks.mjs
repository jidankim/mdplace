import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {listPackageFiles, inspectPackageEntry, readPackageFile} from './safe-path.mjs';
import {authorityMatches, manifestFields, packageArtifactPathAllowed, transitionFields} from './validator-rules.mjs';

export const requiredReleaseSlots = [
  'README.md',
  'product.md',
  'architecture.md',
  'contracts/',
  'operations.md',
  'security-and-privacy.md',
  'performance.md',
  'conformance/manifest.yaml',
  'conformance/fixtures/',
  'conformance/scenarios/',
  'conformance/benchmarks/',
  'conformance/manual-acceptance.md',
  'traceability.yaml',
  'claims-and-evidence.yaml',
  'package-manifest.yaml',
];

export const requiredSchemaPaths = [
  'contracts/schemas/package-manifest.schema.json',
  'contracts/schemas/requirements.schema.json',
  'contracts/schemas/transition-table.schema.json',
  'contracts/schemas/conformance-manifest.schema.json',
  'contracts/schemas/conformance-fixture.schema.json',
  'contracts/schemas/traceability.schema.json',
  'contracts/schemas/validation-report.schema.json',
  'contracts/schemas/version-amendment-report.schema.json',
  'contracts/schemas/recovery-report.schema.json',
];

export const requiredCandidateFoundationSlots = [
  'README.md',
  'normative/package-contract.md',
  'normative/requirements.json',
  'contracts/schemas/',
  'contracts/transitions/',
  'conformance/',
  'traceability.yaml',
  'package-manifest.yaml',
];

function result(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectedAuthority(path) {
  return path.startsWith('normative/') ||
    path.startsWith('contracts/') ||
    path === 'traceability.yaml' ||
    path === 'conformance/manifest.yaml' ||
    path.startsWith('conformance/release-targets/') ||
    path.startsWith('conformance/fixtures/') ||
    path.startsWith('conformance/scenarios/')
    ? 'normative'
    : 'informative';
}

export async function checkManifest(packageRoot, manifest) {
  const codes = [];
  if (!isRecord(manifest)) return result('package-manifest', ['schema.constraint']);
  if (Object.keys(manifest).some((field) => !manifestFields.has(field))) codes.push('schema.unknown_field');
  if ([...manifestFields].some((field) => !Object.hasOwn(manifest, field))) codes.push('schema.required_field');
  if (manifest.schema_id !== 'mdplace.package-manifest/v1' || manifest.package_series !== 'mdplace-spec/v1') {
    codes.push('schema.const');
  }
  if (!/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.release_version ?? '') ||
      !/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.validator_version ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.normative_digest ?? '')) {
    codes.push('schema.pattern');
  }
  const artifactPaths = Array.isArray(manifest.artifacts) ? manifest.artifacts.map((artifact) => artifact?.path) : [];
  if (!Array.isArray(manifest.artifacts) || !isRecord(manifest.layout) || !isRecord(manifest.conformance)) {
    codes.push('schema.constraint');
  }
  if (new Set(artifactPaths).size !== artifactPaths.length) codes.push('artifact.duplicate_path');
  if (artifactPaths.some((path) => !packageArtifactPathAllowed(path))) {
    codes.push('package.production_code_forbidden');
  }
  const declaredReleaseSlots = Array.isArray(manifest.layout?.required_release_slots)
    ? manifest.layout.required_release_slots
    : [];
  if (requiredReleaseSlots.some((slot) => !declaredReleaseSlots.includes(slot))) {
    codes.push('package.required_release_slot_undeclared');
  }
  const declaredFoundationSlots = Array.isArray(manifest.layout?.candidate_foundation_slots)
    ? manifest.layout.candidate_foundation_slots
    : [];
  if (requiredCandidateFoundationSlots.some((slot) => !declaredFoundationSlots.includes(slot))) {
    codes.push('package.required_foundation_slot_undeclared');
  }
  if (manifest.lifecycle_state === 'released') {
    const slotResults = await Promise.all(requiredReleaseSlots.map((slot) =>
      inspectPackageEntry(packageRoot, slot, slot.endsWith('/') ? 'directory' : 'file')));
    if (slotResults.some(({status}) => status !== 'present')) codes.push('package.required_release_slot_missing');
  }
  if (manifest.normative_vocabulary !== '../../CONTEXT.md' ||
      manifest.conformance?.validator !== 'conformance/validator.mjs') {
    codes.push('package.contract_binding_invalid');
  }
  return result('package-manifest', codes);
}

export async function checkArtifactBindings(packageRoot, manifest) {
  const codes = [];
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : [];
  if (!Array.isArray(manifest?.artifacts)) codes.push('schema.constraint');
  if (artifacts.length > 2_048) codes.push('artifact.count_limit');
  const listedPaths = new Set(artifacts.map((artifact) => artifact?.path).filter((path) => typeof path === 'string'));
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string') {
      codes.push('schema.constraint');
      continue;
    }
    if (!packageArtifactPathAllowed(artifact.path)) {
      codes.push('package.production_code_forbidden');
      continue;
    }
    const read = await readPackageFile(packageRoot, artifact.path);
    if (read.status === 'unsafe') {
      codes.push('artifact.path_unsafe');
      continue;
    }
    if (read.status === 'absent') {
      codes.push('artifact.missing');
      continue;
    }
    if (read.status === 'too_large') {
      codes.push('artifact.size_limit');
      continue;
    }
    if (sha256(read.content) !== artifact.sha256) codes.push('artifact.hash_mismatch');
    if (artifact.authority !== expectedAuthority(artifact.path)) codes.push('artifact.authority_mismatch');
  }
  const listing = await listPackageFiles(packageRoot);
  if (listing.status === 'unsafe') codes.push('artifact.path_unsafe');
  if (listing.status === 'resource_limit') codes.push('artifact.count_limit');
  const actualPaths = listing.paths.filter((path) => path !== 'package-manifest.yaml');
  if (actualPaths.some((path) => !listedPaths.has(path))) codes.push('artifact.unlisted');
  const normativeBindings = artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256: digest}) => `${path}\0${digest}\n`)
    .join('');
  const normativeDigest = sha256(normativeBindings);
  if (normativeDigest !== manifest.normative_digest) codes.push('package.normative_digest_mismatch');
  return {check: result('artifact-bindings', codes), normativeDigest};
}

export async function checkRequirements(packageRoot, requirements) {
  const codes = [];
  const entries = Array.isArray(requirements?.requirements) ? requirements.requirements : [];
  if (!Array.isArray(requirements?.requirements)) codes.push('schema.constraint');
  const ids = entries.map((entry) => entry?.id);
  if (new Set(ids).size !== ids.length) codes.push('requirements.duplicate_id');
  if (ids.some((id) => !/^REQ-[A-Z][A-Z0-9]{1,7}-[0-9]{3}$/.test(id))) codes.push('requirements.invalid_id');
  const glossary = await readFile(resolve(packageRoot, '../../CONTEXT.md'), 'utf8');
  const canonicalTerms = new Set([...glossary.matchAll(/^\*\*(.+)\*\*:/gm)].map((match) => match[1]));
  if (entries.flatMap((entry) => Array.isArray(entry?.canonical_terms) ? entry.canonical_terms : [])
    .some((term) => !canonicalTerms.has(term))) {
    codes.push('vocabulary.unknown_term');
  }
  for (const requirement of entries) {
    if (typeof requirement?.normative_anchor === 'string') {
      const [path] = requirement.normative_anchor.split('#');
      const prose = await readPackageFile(packageRoot, path);
      if (prose.status !== 'present' || !prose.content.toString('utf8').includes(`## ${requirement.id}:`)) {
        codes.push('requirements.anchor_unresolved');
      }
    }
  }
  return result('requirements', codes);
}

export function checkTransitionTable(table) {
  const codes = [];
  const rows = Array.isArray(table?.transitions) ? table.transitions : [];
  const states = Array.isArray(table?.states) ? table.states : [];
  const commands = Array.isArray(table?.commands) ? table.commands : [];
  if (!Array.isArray(table?.transitions) || !Array.isArray(table?.states) || !Array.isArray(table?.commands)) {
    codes.push('schema.constraint');
  }
  if (rows.some((row) => !isRecord(row) || [...transitionFields].some((field) => !Object.hasOwn(row, field)))) codes.push('schema.required_field');
  if (rows.some((row) => isRecord(row) && Object.keys(row).some((field) => !transitionFields.has(field)))) codes.push('schema.unknown_field');
  if (rows.some((row) => !authorityMatches(row?.command_or_event, row?.actor_authority))) {
    codes.push('transition.ambiguous_authority');
  }
  const expectedPairs = states.flatMap((state) => commands.map((command) => `${state}:${command}`));
  const actualPairs = rows.map((row) => `${row?.from_state}:${row?.command_or_event}`);
  if (actualPairs.length !== expectedPairs.length || new Set(actualPairs).size !== expectedPairs.length ||
      expectedPairs.some((pair) => !actualPairs.includes(pair))) {
    codes.push('transition.incomplete_matrix');
  }
  const transitionIds = rows.map((row) => row?.transition_id);
  if (new Set(transitionIds).size !== transitionIds.length) codes.push('transition.duplicate_id');
  return result('package-lifecycle', codes);
}

export async function checkSchemas(packageRoot) {
  const codes = [];
  const listing = await listPackageFiles(packageRoot);
  if (listing.status === 'unsafe') return result('contract-schemas', ['artifact.path_unsafe']);
  if (listing.status === 'resource_limit') return result('contract-schemas', ['schema.resource_limit']);
  const schemaPaths = listing.paths.filter((path) => path.startsWith('contracts/schemas/') && path.endsWith('.json'));
  if (requiredSchemaPaths.some((path) => !schemaPaths.includes(path))) {
    codes.push('schema.required_artifact');
  }
  if (schemaPaths.length > 128) codes.push('schema.resource_limit');
  const schemaIds = [];
  const visit = (node, depth = 0) => {
    if (node === null || typeof node !== 'object') return;
    if (depth > 128) {
      codes.push('schema.resource_limit');
      return;
    }
    const objectTyped = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
    if (objectTyped && node.additionalProperties !== false && node.unevaluatedProperties !== false) {
      codes.push('schema.object_open');
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  for (const path of schemaPaths) {
    const read = await readPackageFile(packageRoot, path);
    if (read.status !== 'present') {
      codes.push(read.status === 'too_large' ? 'schema.resource_limit' : 'artifact.path_unsafe');
      continue;
    }
    let schema;
    try {
      schema = JSON.parse(read.content.toString('utf8'));
    } catch {
      codes.push('boundary.invalid_json');
      continue;
    }
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') codes.push('schema.draft_invalid');
    if (typeof schema.$id !== 'string' || schema.$id.length === 0) codes.push('schema.id_missing');
    else schemaIds.push(schema.$id);
    visit(schema);
  }
  if (new Set(schemaIds).size !== schemaIds.length) codes.push('schema.duplicate_id');
  return result('contract-schemas', codes);
}
