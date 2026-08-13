import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates the Vault Mutation Gate contract and 24 public fixtures', () => {
  // Given the committed Specification Package and issue #35 conformance boundary.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const fixtureResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-VMG-'));

  // Then the dedicated contract check and exactly 24 owned fixtures pass.
  assert.ok(report.checks.some(({id, verdict}) =>
    id === 'vault-mutation-gate-contract' && verdict === 'pass'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fixtureResults.length, 24);
  assert.ok(fixtureResults.every(({verdict}) => verdict === 'pass'));
});
