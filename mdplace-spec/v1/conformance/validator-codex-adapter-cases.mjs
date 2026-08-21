import assert from 'node:assert/strict';
import {readFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';
import {codexSha256} from './codex-adapter-core.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {observeCodexAdapterScenario} from './codex-adapter-observer.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';

function rebindProof(document, kind, proof) {
  const proofJson = canonicalJson(proof);
  const proofSha256 = codexSha256(proofJson);
  document[`${kind}_json`] = proofJson;
  document[`${kind}_sha256`] = proofSha256;
  const boundary = JSON.parse(document.boundary_json);
  boundary[`${kind}_proof_sha256`] = proofSha256;
  document.boundary_json = canonicalJson(boundary);
  document.boundary_sha256 = codexSha256(document.boundary_json);
}

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

test('expired current-labelled Codex proof denies before transmission', async (t) => {
  // Given a capability proof whose status says current but whose validity window has ended.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/valid-noninteractive-proposal.json'),
    'utf8',
  ));
  const capability = JSON.parse(fixture.subject.document.capability_json);
  capability.expires_at = '2000-01-01T00:00:00.000Z';
  rebindProof(fixture.subject.document, 'capability', capability);

  // When the public observer evaluates the self-consistent but expired proof.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then expiry is treated as stale before any payload byte can leave the boundary.
  assert.deepEqual(observed.codes, ['codex.capability_proof_stale']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.destination, null);
});

test('network proof without the exact observed destination denies before transmission', async (t) => {
  // Given a network proof that names the allowlist destination but never observes it.
  const packageRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(packageRoot, '../..'), {recursive: true, force: true}));
  const fixture = JSON.parse(await readFile(
    resolve(packageRoot, 'conformance/scenarios/codex-intelligence-adapter/valid-noninteractive-proposal.json'),
    'utf8',
  ));
  const network = JSON.parse(fixture.subject.document.network_json);
  network.observed_payload_destinations = [];
  rebindProof(fixture.subject.document, 'network', network);

  // When the public observer evaluates the incomplete network proof.
  const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot);
  const receipt = JSON.parse(observed.receipts[0]);

  // Then the missing observation fails closed before transmission.
  assert.deepEqual(observed.codes, ['codex.network_proof_malformed']);
  assert.equal(observed.terminal_state, 'denied');
  assert.equal(receipt.transmitted_bytes, 0);
  assert.equal(receipt.destination, null);
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
