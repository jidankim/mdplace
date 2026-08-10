import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates every committed conformance fixture', () => {
  // Given the complete checked-in specification package and fixture manifest.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator runs against that package, every oracle must agree.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);

  // Then the whole required category matrix is covered by 38 passing fixture results.
  assert.equal(report.fixture_results.length, 38);
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
  ]);
  assert.match(report.normative_digest, /^[a-f0-9]{64}$/);
  assert.match(report.conformance_digest, /^[a-f0-9]{64}$/);
});

test('CLI writes its passing report when evidence output is requested', async () => {
  // Given a complete specification package in an isolated workspace.
  const temporaryRoot = await copyCommittedPackage();

  // When the documented write flag is passed to the public validator.
  const result = runPreparedPackage(temporaryRoot, ['--write-evidence']);

  // Then the committed-format evidence bytes equal the deterministic stdout report.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = await readFile(`${temporaryRoot}/conformance/evidence/validation-report.json`, 'utf8');
  assert.equal(evidence, result.stdout);
});
