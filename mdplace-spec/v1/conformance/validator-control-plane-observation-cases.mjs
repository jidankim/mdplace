import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeControlPlaneScenario} from './control-plane-observer.mjs';
import {observeFixture} from './fixture-observer.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function controlPlaneFixtures() {
  const manifest = JSON.parse(await readFile(new URL('../package-manifest.yaml', import.meta.url)));
  const paths = manifest.artifacts
    .map(({path}) => path)
    .filter((path) => path.startsWith('conformance/scenarios/control-plane/') && path.endsWith('.json'));
  return Promise.all(paths.map(async (path) => ({
    path,
    fixture: JSON.parse(await readFile(new URL(`./${path.slice('conformance/'.length)}`, import.meta.url))),
  })));
}

function assertDigestIsExposed(result, digest, seam) {
  assert.ok(result.outputs.includes(`semantic_state_digest:${digest}`),
    `${seam} must expose the unchanged Semantic Kernel digest`);
}

test('all 25 control-plane fixtures expose their unchanged Semantic Kernel digest through public seams', async () => {
  const fixtures = await controlPlaneFixtures();
  assert.equal(fixtures.length, 25);
  for (const {path, fixture} of fixtures) {
    const digest = fixture.subject.document.initial.semantic_state_digest;
    assertDigestIsExposed(await observeFixture(fixture, packageRoot), digest, `observeFixture(${path})`);
    assertDigestIsExposed(await observeControlPlaneScenario(fixture.subject, packageRoot), digest,
      `observeControlPlaneScenario(${path})`);
  }
});

test('schema rejection preserves the stateful Semantic Kernel digest', async () => {
  const [{fixture}] = await controlPlaneFixtures();
  const subject = structuredClone(fixture.subject);
  subject.document.unknown_document_field = true;
  const digest = subject.document.initial.semantic_state_digest;

  const result = await observeControlPlaneScenario(subject, packageRoot);

  assert.deepEqual(result.codes, ['schema.unknown_field']);
  assert.deepEqual(result.filesystem_effects, ['none']);
  assertDigestIsExposed(result, digest, 'schema rejection');
});
