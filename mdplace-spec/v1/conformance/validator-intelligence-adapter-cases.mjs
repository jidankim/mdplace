import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates the complete Intelligence Adapter proposal protocol pack', () => {
  // Given the candidate Specification Package at the public conformance seam.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the validator evaluates issue #45 protocol artifacts and observable fixture oracles.
  const report = JSON.parse(result.stdout);
  const adapterResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-IAP-'));

  // Then the dedicated check and all 42 protocol fixtures pass without production authority.
  assert.ok(report.checks.some(({id, verdict}) => id === 'intelligence-adapter-protocol' && verdict === 'pass'));
  assert.equal(adapterResults.length, 42);
  assert.ok(adapterResults.every(({verdict}) => verdict === 'pass'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
