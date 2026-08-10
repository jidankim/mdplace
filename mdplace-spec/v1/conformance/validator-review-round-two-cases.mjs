import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {link, mkdir, mkdtemp, readFile, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {validateJsonSchema} from './json-schema.mjs';
import {checkArtifactBindings, checkRequirements} from './package-checks.mjs';
import {writePackageFile} from './safe-path.mjs';
import {checkTraceability, runConformance} from './traceability-checks.mjs';
import {amendmentEvidenceMatches} from './amendment-evidence.mjs';
import {releaseEvidenceMatches} from './transition-evidence.mjs';
import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function writeJson(root, path, value) {
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(root, name) {
  return readJson(root, `conformance/fixtures/positive/${name}.json`);
}

async function rebindArtifact(root, path) {
  const manifest = await readJson(root, 'package-manifest.yaml');
  const artifact = manifest.artifacts.find((entry) => entry.path === path);
  artifact.sha256 = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  await writeJson(root, 'package-manifest.yaml', manifest);
}

async function rewriteSourceManifest(root, mutate) {
  const path = 'conformance/release-targets/amendment/source/package-manifest.yaml';
  const manifest = await readJson(root, path);
  mutate(manifest);
  manifest.normative_digest = createHash('sha256').update(manifest.artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path: artifactPath, sha256}) => `${artifactPath}\0${sha256}\n`).join('')).digest('hex');
  await writeJson(root, path, manifest);
  return manifest.normative_digest;
}

test('local schema references reject inherited JSON Pointer tokens', () => {
  const errors = validateJsonSchema({$defs: {}, $ref: '#/$defs/__proto__'}, {unexpected: true});

  assert.ok(errors.some(({keyword}) => keyword === 'invalidSchema'));
});

test('schema reference and oneOf applicators evaluate sibling keywords', () => {
  const referenceErrors = validateJsonSchema({
    $defs: {text: {type: 'string'}},
    $ref: '#/$defs/text',
    minLength: 3,
  }, 'x');
  const oneOfErrors = validateJsonSchema({
    oneOf: [{type: 'string'}, {type: 'number'}],
    minLength: 3,
  }, 'x');

  assert.ok(referenceErrors.some(({keyword}) => keyword === 'minLength'));
  assert.ok(oneOfErrors.some(({keyword}) => keyword === 'minLength'));
});

test('schema validation bounds uniqueItems evaluation', () => {
  const values = Array.from({length: 10_000}, (_, index) => ({index}));
  const errors = validateJsonSchema({type: 'array', uniqueItems: true}, values);

  assert.ok(errors.some(({keyword}) => keyword === 'resourceLimit'));
});

test('evidence output refuses a hard-linked external inode', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'mdplace-safe-hardlink-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-hardlink-'));
  await mkdir(join(packageRoot, 'conformance/evidence'), {recursive: true});
  const external = join(externalRoot, 'report.json');
  await writeFile(external, 'preserve hard link\n');
  await link(external, join(packageRoot, 'conformance/evidence/validation-report.json'));

  const result = await writePackageFile(
    packageRoot,
    'conformance/evidence/validation-report.json',
    'replacement\n',
  );

  assert.equal(result.status, 'unsafe');
  assert.equal(await readFile(external, 'utf8'), 'preserve hard link\n');
});

test('package and amendment artifact readers refuse hard-linked files', async () => {
  const packageRoot = await copyCommittedPackage();
  const relativePath = 'conformance/release-targets/amendment/target/normative/requirements.json';
  const target = join(packageRoot, relativePath);
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-artifact-'));
  const external = join(externalRoot, 'requirements.json');
  await writeFile(external, await readFile(target));
  await unlink(target);
  await link(external, target);

  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  const amendment = await fixture(packageRoot, 'authorized-amend');
  assert.ok((await checkArtifactBindings(packageRoot, manifest)).check.codes.includes('artifact.path_unsafe'));
  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('traceability rejects a nonexistent normative fragment', async () => {
  const packageRoot = await copyCommittedPackage();
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  const traceability = await readJson(packageRoot, 'traceability.yaml');
  const conformance = await readJson(packageRoot, 'conformance/manifest.yaml');
  const invalidAnchor = 'normative/package-contract.md#does-not-exist';
  requirements.requirements[0].normative_anchor = invalidAnchor;
  traceability.records[0].normative_anchors = [invalidAnchor];

  const result = await checkTraceability(packageRoot, requirements, traceability, conformance);

  assert.ok(result.codes.includes('traceability.anchor_unresolved'));
});

test('requirement anchors reject another requirement existing fragment', async () => {
  const packageRoot = await copyCommittedPackage();
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  requirements.requirements[0].normative_anchor = requirements.requirements[1].normative_anchor;

  const result = await checkRequirements(packageRoot, requirements);

  assert.ok(result.codes.includes('requirements.anchor_unresolved'));
});

test('artifact verification independently recomputes the conformance-pack digest', async () => {
  const packageRoot = await copyCommittedPackage();
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  manifest.conformance_digest = '0'.repeat(64);

  const {check} = await checkArtifactBindings(packageRoot, manifest);

  assert.ok(check.codes.includes('package.conformance_digest_mismatch'));
});

test('conformance requires an oracle for every denied lifecycle row', async () => {
  const packageRoot = await copyCommittedPackage();
  const conformance = await readJson(packageRoot, 'conformance/manifest.yaml');
  const requirements = await readJson(packageRoot, 'normative/requirements.json');
  conformance.fixtures = conformance.fixtures.filter(({fixture_id: id}) => id !== 'FIX-PKG-ILLEGAL-002');

  const result = await runConformance(
    packageRoot,
    conformance,
    requirements.requirements.map(({id}) => id),
    {verifyPublishedReports: false},
  );

  assert.ok(result.check.codes.includes('conformance.illegal_transition_uncovered'));
});

test('informative evidence contents do not determine the package verdict', async () => {
  const packageRoot = await copyCommittedPackage();
  const path = 'conformance/evidence/version-amendment-report.json';
  const report = await readJson(packageRoot, path);
  report.source_release.path = 'releases/observed-but-nonauthoritative';
  await writeJson(packageRoot, path, report);
  await rebindArtifact(packageRoot, path);

  const result = runPreparedPackage(packageRoot);

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).verdict, 'pass');
});

test('amendment evidence permits an additive-only target', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  const sourceRoot = join(packageRoot, 'conformance/release-targets/amendment/source');
  const targetRoot = join(packageRoot, 'conformance/release-targets/amendment/target');
  const requirements = await readJson(targetRoot, 'normative/requirements.json');
  requirements.requirements.splice(requirements.requirements.findIndex(({id}) => id === 'REQ-PKG-012'), 1);
  await writeJson(sourceRoot, 'normative/requirements.json', requirements);
  let insideRemovedRequirement = false;
  const sourceContract = (await readFile(join(targetRoot, 'normative/package-contract.md'), 'utf8'))
    .split(/\r?\n/).filter((line) => {
      if (line.startsWith('## REQ-PKG-012:')) insideRemovedRequirement = true;
      else if (line.startsWith('## ')) insideRemovedRequirement = false;
      return !insideRemovedRequirement;
    }).join('\n');
  await writeFile(join(sourceRoot, 'normative/package-contract.md'), sourceContract);
  const manifest = await readJson(sourceRoot, 'package-manifest.yaml');
  for (const path of ['normative/requirements.json', 'normative/package-contract.md']) {
    const artifact = manifest.artifacts.find((entry) => entry.path === path);
    artifact.sha256 = createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex');
  }
  amendment.subject.amendment_evidence.source_digest = await rewriteSourceManifest(packageRoot, (source) => {
    source.artifacts = manifest.artifacts;
  });
  amendment.subject.amendment_evidence.changed_requirement_ids = [];
  amendment.subject.amendment_evidence.new_requirement_ids = ['REQ-PKG-012'];

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), true);
});

test('amendment evidence binds the declared target version to a target manifest', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  amendment.subject.amendment_evidence.target_version = '1.2.0';
  amendment.subject.amendment_evidence.target_path = 'releases/1.2.0';

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('amendment evidence binds its source manifest as the transition base', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  amendment.subject.preconditions.manifest_ref = 'package-manifest.yaml';

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('amendment evidence derives changed IDs from anchored normative sections', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  const sourceRoot = join(packageRoot, 'conformance/release-targets/amendment/source');
  const contractPath = 'normative/package-contract.md';
  const contract = await readFile(join(sourceRoot, contractPath), 'utf8');
  await writeFile(
    join(sourceRoot, contractPath),
    contract.replace('Every canonical term named', 'Every silently rewritten canonical term named'),
  );
  const manifest = await readJson(sourceRoot, 'package-manifest.yaml');
  manifest.artifacts.find(({path}) => path === contractPath).sha256 = createHash('sha256')
    .update(await readFile(join(sourceRoot, contractPath))).digest('hex');
  amendment.subject.amendment_evidence.source_digest = await rewriteSourceManifest(packageRoot, (source) => {
    source.artifacts = manifest.artifacts;
  });

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('amendment evidence rejects changed unanchored normative material', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  const targetRoot = join(packageRoot, 'conformance/release-targets/amendment/target');
  const contractPath = 'normative/package-contract.md';
  const contract = await readFile(join(targetRoot, contractPath), 'utf8');
  await writeFile(join(targetRoot, contractPath), contract.replace('Every release is immutable', 'Every release is conditionally mutable'));
  const manifest = await readJson(targetRoot, 'package-manifest.yaml');
  manifest.artifacts.find(({path}) => path === contractPath).sha256 = createHash('sha256')
    .update(await readFile(join(targetRoot, contractPath))).digest('hex');
  manifest.normative_digest = createHash('sha256').update(manifest.artifacts
    .filter(({authority}) => authority === 'normative').sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`).join('')).digest('hex');
  await writeJson(targetRoot, 'package-manifest.yaml', manifest);
  amendment.subject.amendment_evidence.target_digest = manifest.normative_digest;

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('amendment evidence rejects a source manifest with an omitted released artifact', async () => {
  const packageRoot = await copyCommittedPackage();
  const amendment = await fixture(packageRoot, 'authorized-amend');
  amendment.subject.amendment_evidence.source_digest = await rewriteSourceManifest(packageRoot, (manifest) => {
    manifest.artifacts = manifest.artifacts.filter(({path}) => path !== 'normative/package-contract.md');
  });

  assert.equal(await amendmentEvidenceMatches(amendment.subject, packageRoot), false);
});

test('release evidence rejects a manifest-bound self-attested validation report', async () => {
  const packageRoot = await copyCommittedPackage();
  const release = await fixture(packageRoot, 'authorized-release');
  const path = 'conformance/evidence/validation-report.json';
  const report = await readJson(packageRoot, path);
  report.checks[0].codes = ['fabricated.pass'];
  await writeJson(packageRoot, path, report);
  await rebindArtifact(packageRoot, path);

  assert.equal(await releaseEvidenceMatches(release.subject, packageRoot), false);
});

test('release evidence binds the conformance pack rather than a result artifact', async () => {
  const packageRoot = await copyCommittedPackage();
  const release = await fixture(packageRoot, 'authorized-release');
  release.subject.release_evidence.release_assets.conformance_digest_ref =
    'package-manifest.yaml#/artifacts/conformance/evidence/validation-report.json/sha256';

  assert.equal(await releaseEvidenceMatches(release.subject, packageRoot), false);
});

test('release evidence rejects a non-resolving artifact digest reference', async () => {
  const packageRoot = await copyCommittedPackage();
  const release = await fixture(packageRoot, 'authorized-release');
  release.subject.release_evidence.release_assets.traceability_report_digest_ref =
    'package-manifest.yaml#/artifacts/conformance/evidence/traceability-report.json/sha256';

  assert.equal(await releaseEvidenceMatches(release.subject, packageRoot), false);
});
