import {cp, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

import {conformanceDigestForArtifacts} from './digest-bindings.mjs';

const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));
const committedPackage = fileURLToPath(new URL('../', import.meta.url));

export async function preparePackage(files) {
  const workspace = await mkdtemp(join(tmpdir(), 'mdplace-spec-validator-'));
  const packageRoot = join(workspace, 'mdplace-spec/v1');
  await mkdir(packageRoot, {recursive: true});
  await writeFile(join(workspace, 'CONTEXT.md'), '**Specification Package**:\nFixture definition.\n_Avoid_: Implementation bundle\n');
  const packageOverrides = files['package-manifest.yaml'] ?? {};
  const packageFiles = Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'package-manifest.yaml'));
  if (!('normative/package-contract.md' in packageFiles)) packageFiles['normative/package-contract.md'] = 'Fixture contract.\n';
  const manifestSchemaPath = 'contracts/schemas/package-manifest.schema.json';
  if (!(manifestSchemaPath in packageFiles)) {
    packageFiles[manifestSchemaPath] = await readFile(join(committedPackage, manifestSchemaPath), 'utf8');
  }
  for (const document of Object.values(packageFiles)) {
    const schemaPath = document?.subject?.kind === 'artifact' ? document.subject.schema : null;
    if (typeof schemaPath === 'string' && !(schemaPath in packageFiles)) {
      packageFiles[schemaPath] = await readFile(join(committedPackage, schemaPath), 'utf8');
    }
  }
  const contents = Object.fromEntries(Object.entries(packageFiles).map(([path, document]) => [
    path,
    typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`,
  ]));
  const artifacts = Object.entries(contents).map(([path, content]) => ({
    path,
    authority: path === 'README.md' || path.endsWith('.mjs') ? 'informative' : 'normative',
    media_type: path.endsWith('.md') ? 'text/markdown' : path.endsWith('.mjs') ? 'text/javascript' : 'application/json',
    sha256: createHash('sha256').update(content).digest('hex'),
  }));
  const normativeDigest = createHash('sha256').update(
    artifacts
      .filter(({authority}) => authority === 'normative')
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(({path, sha256}) => `${path}\0${sha256}\n`)
      .join(''),
  ).digest('hex');
  const manifest = {
    $schema: 'contracts/schemas/package-manifest.schema.json',
    schema_id: 'mdplace.package-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    lifecycle_state: 'candidate',
    validator_version: '1.0.0',
    normative_vocabulary: '../../CONTEXT.md',
    authority: {normative_rule: 'binding', informative_rule: 'nonbinding', conflict_result: 'informative_ignored_for_conformance'},
    layout: {required_release_slots: ['README.md', 'product.md', 'architecture.md', 'contracts/', 'operations.md', 'security-and-privacy.md', 'performance.md', 'conformance/manifest.yaml', 'conformance/fixtures/', 'conformance/scenarios/', 'conformance/benchmarks/', 'conformance/manual-acceptance.md', 'traceability.yaml', 'claims-and-evidence.yaml', 'package-manifest.yaml'], candidate_foundation_slots: ['README.md', 'normative/package-contract.md', 'normative/requirements.json', 'contracts/schemas/', 'contracts/transitions/', 'conformance/', 'traceability.yaml', 'package-manifest.yaml']},
    artifacts,
    normative_digest: normativeDigest,
    conformance_digest: conformanceDigestForArtifacts(artifacts),
    amendment_policy: {immutable_after_release: true, in_place_mutation: 'forbidden', new_version_required: true, previous_release: null},
    conformance: {manifest: 'conformance/manifest.yaml', validator: 'conformance/validator.mjs', report: 'conformance/evidence/validation-report.json'},
    ...packageOverrides,
  };
  const allFiles = {...contents, 'package-manifest.yaml': `${JSON.stringify(manifest, null, 2)}\n`};
  for (const [path, content] of Object.entries(allFiles)) {
    const target = join(packageRoot, path);
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, content);
  }
  return packageRoot;
}

export function runPreparedPackage(packageRoot, arguments_ = []) {
  return spawnSync(process.execPath, [validator, packageRoot, ...arguments_], {encoding: 'utf8'});
}

export async function runPackage(files, arguments_ = []) {
  const packageRoot = await preparePackage(files);
  return {packageRoot, result: runPreparedPackage(packageRoot, arguments_)};
}

export async function copyCommittedPackage() {
  const workspace = await mkdtemp(join(tmpdir(), 'mdplace-spec-validator-copy-'));
  const packageRoot = join(workspace, 'mdplace-spec/v1');
  await cp(committedPackage, packageRoot, {recursive: true});
  await cp(fileURLToPath(new URL('../../../CONTEXT.md', import.meta.url)), join(workspace, 'CONTEXT.md'));
  return packageRoot;
}

export async function validatePackage(files) {
  return (await runPackage(files)).result;
}

export function completeTransition(overrides = {}) {
  return {
    transition_id: 'TR-PKG-001',
    command_or_event: 'submit',
    from_state: 'draft',
    allowed: true,
    actor_authority: {roles: ['package_author'], quorum: 1, distinct_actors: false, delegation: 'permitted'},
    preconditions: ['package validates'],
    base_references: ['normative_digest'],
    emitted_records: ['PackageCandidateSubmitted'],
    filesystem_effects: ['none'],
    idempotency: {key_fields: ['idempotency_key'], retry_result: 'return original receipt'},
    terminal_state: 'candidate',
    failure_result: {code: 'transition.precondition_failed', state_effect: 'unchanged', emitted_records: ['PackageTransitionDenied'], filesystem_effects: ['none']},
    recovery: 'Correct the input and retry.',
    ...overrides,
  };
}
