import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {observeReferenceVaultScenario} from './reference-vault-observer.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));
const redistributionFixture = fileURLToPath(new URL(
  './scenarios/reference-vault/whole-lineage-same-partition-redistribution.json',
  import.meta.url,
));

async function validRedistributionSubject() {
  return structuredClone(JSON.parse(await readFile(redistributionFixture, 'utf8')).subject);
}

test('generation rejects a conflicting registry binding digest', async () => {
  // Given one seed/version registry entry whose digest conflicts with the declared binding.
  const subject = await validRedistributionSubject();
  subject.document.operation = 'generate';
  subject.document.actor_role = 'reference_vault_generator';
  subject.document.binding_registry[0].binding_sha256 = 'b'.repeat(64);

  // When the public Reference Vault observer validates the Generator Binding registry.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then registry cardinality alone cannot establish a valid binding.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['generator.binding_invalid']);
});

test('redistribution rejects two matching stale manifest bindings', async () => {
  // Given an otherwise valid request whose caller-controlled base digests agree on stale state.
  const subject = await validRedistributionSubject();
  subject.document.redistribution.expected_base_manifest_sha256 = 'a'.repeat(64);
  subject.document.redistribution.observed_base_manifest_sha256 = 'a'.repeat(64);

  // When the public Reference Vault observer resolves the sealed manifest itself.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then matching caller claims cannot substitute for the current manifest binding.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['corpus.redistribution_stale']);
});

test('redistribution rejects a lineage outside the asserted source partition', async () => {
  // Given a same-partition shard move naming a lineage owned by the test partition.
  const subject = await validRedistributionSubject();
  subject.document.redistribution.lineage_group_id = 'lineage:test-001';

  // When the public Reference Vault observer checks source membership.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then the lineage cannot be relabeled as train redistribution.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['corpus.lineage_crossing']);
});

test('CLI validates the deterministic Reference Vault contract', () => {
  // Given the committed Specification Package and issue #37 conformance boundary.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator evaluates the Reference Vault contracts and fixtures.
  const report = JSON.parse(result.stdout);
  const contract = report.checks.find(({id}) => id === 'reference-vault-contract');

  // Then a dedicated contract check proves the specification-only generator boundary.
  assert.deepEqual(contract, {id: 'reference-vault-contract', verdict: 'pass', codes: []});
});

test('CLI executes the complete Reference Vault boundary matrix', () => {
  // Given the checked-in boundary, isolation, redistribution, authority, and recovery fixtures.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the public validator executes every declared Reference Vault oracle.
  const report = JSON.parse(result.stdout);
  const fixtures = report.fixture_results.filter(({id}) => id.startsWith('FIX-RVG-'));

  // Then all 32 observable scenarios pass without materializing a Reference Vault.
  assert.equal(fixtures.length, 32);
  assert.ok(fixtures.every(({verdict}) => verdict === 'pass'));
});

test('CLI publishes a fully bound Reference Vault conformance result', () => {
  // Given the normative contracts, traceability, package ledger, and seeded recovery evidence.
  const result = spawnSync(process.execPath, [validator, packageRoot], {encoding: 'utf8'});

  // When the package is validated through the public command surface.
  const report = JSON.parse(result.stdout);

  // Then every package check and fixture passes with no unlisted or untraced artifact.
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(report.verdict, 'pass');
  assert.ok(report.checks.every(({verdict}) => verdict === 'pass'));
});
