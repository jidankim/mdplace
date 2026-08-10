import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

import {amendmentEvidenceMatches} from './amendment-evidence.mjs';
import {conformanceDigestForArtifacts} from './digest-bindings.mjs';
import {validateJsonSchema} from './json-schema.mjs';
import {observeTransition} from './transition-observer.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

async function writeJson(root, path, value) {
  await writeFile(join(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function normativeDigest(artifacts) {
  return createHash('sha256').update(artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`).join('')).digest('hex');
}

async function bindTargetFile(targetRoot, manifest, path, content, mediaType = 'application/json') {
  await writeFile(join(targetRoot, path), content);
  let artifact = manifest.artifacts.find((entry) => entry.path === path);
  if (artifact === undefined) {
    artifact = {path, authority: 'normative', media_type: mediaType, sha256: ''};
    manifest.artifacts.push(artifact);
  }
  artifact.sha256 = createHash('sha256').update(content).digest('hex');
}

async function amendedFixture(packageRoot, mutate) {
  const targetRoot = join(packageRoot, 'conformance/release-targets/amendment/target');
  const manifest = await readJson(targetRoot, 'package-manifest.yaml');
  await mutate(targetRoot, manifest);
  manifest.normative_digest = normativeDigest(manifest.artifacts);
  manifest.conformance_digest = conformanceDigestForArtifacts(manifest.artifacts);
  await writeJson(targetRoot, 'package-manifest.yaml', manifest);
  const fixture = await readJson(packageRoot, 'conformance/fixtures/positive/authorized-amend.json');
  fixture.subject.amendment_evidence.target_digest = manifest.normative_digest;
  return fixture;
}

test('schema validation rejects nested bounded repetition before evaluation', () => {
  const errors = validateJsonSchema(
    {type: 'string', pattern: '^(a{0,1000}){0,1000}$'},
    `${'a'.repeat(1023)}b`,
  );

  assert.ok(errors.some(({keyword}) => keyword === 'resourceLimit'));
});

test('transition preconditions apply the complete package-manifest schema', async () => {
  const packageRoot = await copyCommittedPackage();
  const manifest = await readJson(packageRoot, 'package-manifest.yaml');
  manifest.layout.unexpected = true;
  await writeJson(packageRoot, 'package-manifest.yaml', manifest);
  const fixture = await readJson(packageRoot, 'conformance/fixtures/positive/authorized-submit.json');

  const result = await observeTransition(fixture, packageRoot);

  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.codes, ['transition.precondition_failed']);
});

test('amendment evidence independently verifies the target conformance digest', async () => {
  const packageRoot = await copyCommittedPackage();
  const targetPath = 'conformance/release-targets/amendment/target/package-manifest.yaml';
  const manifest = await readJson(packageRoot, targetPath);
  manifest.conformance_digest = '0'.repeat(64);
  await writeJson(packageRoot, targetPath, manifest);
  const fixture = await readJson(packageRoot, 'conformance/fixtures/positive/authorized-amend.json');

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('amendment evidence rejects an uncataloged requirement heading', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = await amendedFixture(packageRoot, async (targetRoot, manifest) => {
    const path = 'normative/package-contract.md';
    const content = `${await readFile(join(targetRoot, path), 'utf8')}
## REQ-HIDE-999: Uncataloged requirement

The implementation MUST accept hidden meaning.
`;
    await bindTargetFile(targetRoot, manifest, path, content, 'text/markdown');
  });

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('amendment evidence rejects a reassigned existing requirement anchor', async () => {
  const packageRoot = await copyCommittedPackage();
  let reassignedId;
  const fixture = await amendedFixture(packageRoot, async (targetRoot, manifest) => {
    const path = 'normative/requirements.json';
    const requirements = await readJson(targetRoot, path);
    reassignedId = requirements.requirements[0].id;
    requirements.requirements[0].normative_anchor = requirements.requirements[1].normative_anchor;
    await bindTargetFile(targetRoot, manifest, path, `${JSON.stringify(requirements, null, 2)}\n`);
  });
  fixture.subject.amendment_evidence.changed_requirement_ids.push(reassignedId);

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('amendment evidence rejects an undeclared new normative artifact', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = await amendedFixture(packageRoot, async (targetRoot, manifest) => {
    await bindTargetFile(
      targetRoot,
      manifest,
      'normative/undeclared-new-meaning.md',
      '# Undeclared meaning\n\nThe implementation MUST accept hidden meaning.\n',
      'text/markdown',
    );
  });

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('amendment evidence rejects an unreported structured contract change', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = await amendedFixture(packageRoot, async (targetRoot, manifest) => {
    await bindTargetFile(targetRoot, manifest, 'contracts/marker.json', '{"snapshot":"changed contract"}\n');
  });

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});
