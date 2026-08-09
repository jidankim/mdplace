import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {runPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates every committed conformance fixture', () => {
  // Given the complete checked-in specification package and fixture manifest.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator runs against that package, every oracle must agree.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);

  // Then the whole required category matrix is covered by 25 passing fixture results.
  assert.equal(report.fixture_results.length, 25);
  assert.ok(report.fixture_results.every(({verdict}) => verdict === 'pass'));
  assert.deepEqual(report.checks.map(({id}) => id), [
    'package-manifest',
    'artifact-bindings',
    'requirements',
    'package-lifecycle',
    'contract-schemas',
    'schema-instances',
    'traceability',
    'conformance-manifest',
    'version-amendment-evidence',
    'recovery-evidence',
  ]);
  assert.match(report.normative_digest, /^[a-f0-9]{64}$/);
});

test('CLI writes its passing report only when evidence output is requested', async () => {
  // Given a valid one-fixture package with no pre-existing validation report.
  const fixture = {
    fixture_id: 'FIX-PKG-BND-001',
    subject: {kind: 'sha256_boundary', value: 'a'.repeat(64)},
    expected: {verdict: 'pass', codes: [], outputs: ['digest accepted'], operations: ['validate sha256 boundary'], receipts: ['ValidationReceipt'], filesystem_effects: ['none'], terminal_state: 'validated', illegal_transition: false},
  };
  const conformance = {fixtures: [{fixture_id: fixture.fixture_id, path: 'fixtures/exact.json', expected_verdict: 'pass'}]};

  // When the documented write flag is passed to the public validator.
  const {packageRoot: temporaryRoot, result} = await runPackage({
    'package-manifest.yaml': {},
    'conformance/manifest.yaml': conformance,
    'conformance/fixtures/exact.json': fixture,
  }, ['--write-evidence']);

  // Then the committed-format evidence bytes equal the deterministic stdout report.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = await readFile(`${temporaryRoot}/conformance/evidence/validation-report.json`, 'utf8');
  assert.equal(evidence, result.stdout);
});
