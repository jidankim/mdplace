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

  // Then the whole required category matrix is covered by 515 passing fixture results.
  assert.equal(report.fixture_results.length, 515);
  assert.ok(report.fixture_results.every(({verdict}) => verdict === 'pass'));
  assert.deepEqual(report.checks.map(({id}) => id), [
    'package-manifest',
    'artifact-bindings',
    'requirements',
    'package-lifecycle',
    'evidence-lifecycle',
    'semantic-kernel-lifecycle',
    'processing-policy-lifecycle',
    'source-profile-lifecycle',
    'vault-mutation-gate-lifecycle',
    'intelligence-adapter-lifecycle-1',
    'intelligence-adapter-lifecycle-2',
    'intelligence-adapter-lifecycle-3',
    'intelligence-adapter-lifecycle-4',
    'intelligence-adapter-lifecycle-5',
    'intelligence-adapter-lifecycle-6',
    'intelligence-adapter-lifecycle-7',
    'local-adapter-lifecycle-1',
    'local-adapter-lifecycle-2',
    'local-adapter-lifecycle-3',
    'local-adapter-lifecycle-4',
    'local-adapter-lifecycle-5',
    'remote-adapter-lifecycle-1',
    'remote-adapter-lifecycle-2',
    'remote-adapter-lifecycle-3',
    'remote-adapter-lifecycle-4',
    'remote-adapter-lifecycle-5',
    'remote-adapter-lifecycle-6',
    'remote-adapter-lifecycle-7',
    'codex-adapter-lifecycle-1',
    'codex-adapter-lifecycle-2',
    'codex-adapter-lifecycle-3',
    'codex-adapter-lifecycle-4',
    'codex-adapter-lifecycle-5',
    'codex-adapter-lifecycle-6',
    'codex-adapter-lifecycle-7',
    'contract-schemas',
    'schema-instances',
    'validator-evidence-contract',
    'semantic-kernel-contract',
    'control-plane-contract',
    'control-plane-lifecycle',
    'core-processing-policy-contract',
    'vault-mutation-gate-contract',
    'reference-vault-contract',
    'intelligence-adapter-protocol',
    'local-intelligence-adapter-profile',
    'remote-intelligence-adapter-profile',
    'codex-intelligence-adapter-profile',
    'traceability',
    'conformance-manifest',
  ]);
  assert.match(report.normative_digest, /^[a-f0-9]{64}$/);
  assert.match(report.conformance_digest, /^[a-f0-9]{64}$/);
});

test('CLI rejects filesystem publication without changing generated evidence', async () => {
  // Given a complete specification package and its committed generated evidence.
  const temporaryRoot = await copyCommittedPackage();
  const evidencePath = `${temporaryRoot}/conformance/evidence/validation-report.json`;
  const before = await readFile(evidencePath, 'utf8');

  // When the retired filesystem-publication flag is passed to the public validator.
  const result = runPreparedPackage(temporaryRoot, ['--write-evidence']);

  // Then the request is rejected and the existing report remains byte-for-byte unchanged.
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(({codes}) => codes.includes('validator.argument_unknown')));
  assert.equal(await readFile(evidencePath, 'utf8'), before);
});
