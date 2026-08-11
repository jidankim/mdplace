import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));

test('CLI validates exactly 30 stateful Semantic Kernel scenarios', () => {
  // Given the committed Specification Package with its Semantic Kernel conformance manifest.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the package and its observable fixture oracles.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const semanticKernelResults = report.fixture_results.filter(({id}) => id.startsWith('FIX-SK-'));

  // Then the dedicated contract check and all 30 declared stateful scenarios pass.
  assert.ok(report.checks.some(({id, verdict}) => id === 'semantic-kernel-contract' && verdict === 'pass'));
  assert.equal(semanticKernelResults.length, 30);
  assert.ok(semanticKernelResults.every(({verdict}) => verdict === 'pass'));
});
