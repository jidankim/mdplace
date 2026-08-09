import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {relative, resolve, sep} from 'node:path';

import {authorityMatches, manifestFields, transitionFields} from './validator-rules.mjs';

const requiredReleaseSlots = [
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

function result(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function listFiles(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
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

export function checkManifest(packageRoot, manifest) {
  const codes = [];
  if (Object.keys(manifest).some((field) => !manifestFields.has(field))) codes.push('schema.unknown_field');
  if ([...manifestFields].some((field) => !(field in manifest))) codes.push('schema.required_field');
  if (manifest.schema_id !== 'mdplace.package-manifest/v1' || manifest.package_series !== 'mdplace-spec/v1') {
    codes.push('schema.const');
  }
  if (!/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.release_version ?? '') ||
      !/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.validator_version ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifest.normative_digest ?? '')) {
    codes.push('schema.pattern');
  }
  const artifactPaths = manifest.artifacts?.map(({path}) => path) ?? [];
  if (new Set(artifactPaths).size !== artifactPaths.length) codes.push('artifact.duplicate_path');
  if (artifactPaths.some((path) => /^(?:production|runtime|src)\//.test(path))) {
    codes.push('package.production_code_forbidden');
  }
  if (requiredReleaseSlots.some((slot) => !manifest.layout?.required_release_slots?.includes(slot))) {
    codes.push('package.required_release_slot_undeclared');
  }
  if (manifest.lifecycle_state === 'released' &&
      requiredReleaseSlots.some((slot) => !existsSync(resolve(packageRoot, slot)))) {
    codes.push('package.required_release_slot_missing');
  }
  if (manifest.normative_vocabulary !== '../../CONTEXT.md' ||
      manifest.conformance?.validator !== 'conformance/validator.mjs') {
    codes.push('package.contract_binding_invalid');
  }
  return result('package-manifest', codes);
}

export async function checkArtifactBindings(packageRoot, manifest) {
  const codes = [];
  const artifacts = manifest.artifacts ?? [];
  const listedPaths = new Set(artifacts.map(({path}) => path));
  for (const artifact of artifacts) {
    if (/^(?:\/|.*(?:^|\/)\.\.(?:\/|$))/.test(artifact.path)) {
      codes.push('artifact.path_invalid');
      continue;
    }
    const artifactPath = resolve(packageRoot, artifact.path);
    if (!existsSync(artifactPath)) {
      codes.push('artifact.missing');
      continue;
    }
    if (sha256(await readFile(artifactPath)) !== artifact.sha256) codes.push('artifact.hash_mismatch');
    if (artifact.authority !== expectedAuthority(artifact.path)) codes.push('artifact.authority_mismatch');
  }
  const actualPaths = (await listFiles(packageRoot))
    .map((path) => relative(packageRoot, path).split(sep).join('/'))
    .filter((path) => path !== 'package-manifest.yaml');
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
  const entries = requirements.requirements ?? [];
  const ids = entries.map(({id}) => id);
  if (new Set(ids).size !== ids.length) codes.push('requirements.duplicate_id');
  if (ids.some((id) => !/^REQ-[A-Z][A-Z0-9]{1,7}-[0-9]{3}$/.test(id))) codes.push('requirements.invalid_id');
  const glossary = await readFile(resolve(packageRoot, '../../CONTEXT.md'), 'utf8');
  const canonicalTerms = new Set([...glossary.matchAll(/^\*\*(.+)\*\*:/gm)].map((match) => match[1]));
  if (entries.flatMap(({canonical_terms: terms = []}) => terms).some((term) => !canonicalTerms.has(term))) {
    codes.push('vocabulary.unknown_term');
  }
  for (const requirement of entries) {
    if (requirement.normative_anchor) {
      const [path] = requirement.normative_anchor.split('#');
      const prose = await readFile(resolve(packageRoot, path), 'utf8');
      if (!prose.includes(`## ${requirement.id}:`)) codes.push('requirements.anchor_unresolved');
    }
  }
  return result('requirements', codes);
}

export function checkTransitionTable(table) {
  const codes = [];
  const rows = table.transitions ?? [];
  if (rows.some((row) => [...transitionFields].some((field) => !(field in row)))) codes.push('schema.required_field');
  if (rows.some((row) => Object.keys(row).some((field) => !transitionFields.has(field)))) codes.push('schema.unknown_field');
  if (rows.some((row) => !authorityMatches(row.command_or_event, row.actor_authority))) {
    codes.push('transition.ambiguous_authority');
  }
  const expectedPairs = (table.states ?? []).flatMap((state) => (table.commands ?? []).map((command) => `${state}:${command}`));
  const actualPairs = rows.map((row) => `${row.from_state}:${row.command_or_event}`);
  if (actualPairs.length !== expectedPairs.length || new Set(actualPairs).size !== expectedPairs.length ||
      expectedPairs.some((pair) => !actualPairs.includes(pair))) {
    codes.push('transition.incomplete_matrix');
  }
  const transitionIds = rows.map(({transition_id: transitionId}) => transitionId);
  if (new Set(transitionIds).size !== transitionIds.length) codes.push('transition.duplicate_id');
  return result('package-lifecycle', codes);
}

export async function checkSchemas(packageRoot) {
  const codes = [];
  const schemaRoot = resolve(packageRoot, 'contracts/schemas');
  const schemaPaths = (await listFiles(schemaRoot)).filter((path) => path.endsWith('.json'));
  const schemaIds = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    const objectTyped = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'));
    if (objectTyped && node.additionalProperties !== false && node.unevaluatedProperties !== false) {
      codes.push('schema.object_open');
    }
    for (const value of Object.values(node)) visit(value);
  };
  for (const path of schemaPaths) {
    const schema = JSON.parse(await readFile(path, 'utf8'));
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') codes.push('schema.draft_invalid');
    if (typeof schema.$id !== 'string' || schema.$id.length === 0) codes.push('schema.id_missing');
    else schemaIds.push(schema.$id);
    visit(schema);
  }
  if (new Set(schemaIds).size !== schemaIds.length) codes.push('schema.duplicate_id');
  return result('contract-schemas', codes);
}
