import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {observeCodexAdapterScenario} from './codex-adapter-observer.mjs';

test('valid Codex fixture crosses the closed boundary as inert advice', async (t) => {
  // Given a positive Codex fixture at the public schema and observer seams.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/valid-noninteractive-proposal.json'),
    'utf8',
  ));
  const boundary = JSON.parse(fixture.subject.document.boundary_json);

  // When the boundary and resulting receipt are validated.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);
  const boundaryCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-boundary.schema.json',
    boundary,
  ));
  const receiptCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-receipt.schema.json',
    receipt,
  ));

  // Then the fixture is accepted as inert advice through closed, schema-valid artifacts.
  assert.equal(boundaryCode, null);
  assert.equal(receiptCode, null);
  assert.deepEqual(observed.codes, []);
  assert.equal(observed.terminal_state, 'accepted');
  assert.deepEqual(observed.filesystem_effects, ['none']);
});

test('illegal Codex lifecycle fixture is valid input and an observed denial', async (t) => {
  // Given a closed fixture for a forbidden capability-proof transition.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/illegal-capability-proof-transition-denied.json'),
    'utf8',
  ));

  // When the scenario schema and public observer evaluate the declared transition.
  const scenarioCode = schemaErrorCode(await validateAgainstSchemaPath(
    packageRoot,
    'contracts/schemas/codex-adapter-scenario.schema.json',
    fixture.subject.document,
  ));
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);

  // Then the fixture itself is valid while the lifecycle operation fails closed.
  assert.equal(scenarioCode, null);
  assert.deepEqual(observed.codes, ['codex.illegal_transition']);
  assert.equal(observed.terminal_state, 'denied');
  assert.deepEqual(observed.network_effects, ['none']);
});

test('committed package proves the independent Codex Intelligence Adapter profile', async (t) => {
  // Given the committed specification package with its Codex Intelligence Adapter artifacts.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));

  // When the public package validator evaluates the complete package.
  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  // Then the Codex Intelligence Adapter profile is independently validated and passing.
  assert.deepEqual(
    report.checks.find(({id}) => id === 'codex-intelligence-adapter-profile'),
    {id: 'codex-intelligence-adapter-profile', verdict: 'pass', codes: []},
  );
});
