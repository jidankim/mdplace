import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile, rm, unlink, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

import {checkReferenceVaultContract} from './reference-vault-checks.mjs';
import {observeReferenceVaultScenario} from './reference-vault-observer.mjs';
import {runConformance} from './traceability-checks.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = fileURLToPath(new URL('./validator.mjs', import.meta.url));
const redistributionFixture = fileURLToPath(new URL(
  './scenarios/reference-vault/whole-lineage-same-partition-redistribution.json',
  import.meta.url,
));
const recoveryFixture = fileURLToPath(new URL(
  './scenarios/reference-vault/recover-before-manifest.json',
  import.meta.url,
));
const lifecycleFixture = fileURLToPath(new URL(
  './scenarios/reference-vault/generation-lifecycle-command-denied.json',
  import.meta.url,
));
const generationLifecycle = fileURLToPath(new URL(
  '../contracts/transitions/reference-vault-generation-lifecycle.json',
  import.meta.url,
));
const redistributionLifecycle = fileURLToPath(new URL(
  '../contracts/transitions/reference-vault-redistribution-lifecycle.json',
  import.meta.url,
));

async function fixtureSubject(path) {
  return structuredClone(JSON.parse(await readFile(path, 'utf8')).subject);
}

async function validRedistributionSubject() {
  return fixtureSubject(redistributionFixture);
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
  subject.document.redistribution.lineage_group_id = 'lineage:019001';

  // When the public Reference Vault observer checks source membership.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then the lineage cannot be relabeled as train redistribution.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['corpus.lineage_crossing']);
});

test('generation rejects an absent sealed corpus manifest', async (t) => {
  // Given a valid generation request in a package whose sealed corpus manifest is absent.
  const temporaryRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(temporaryRoot, '../..'), {recursive: true, force: true}));
  await unlink(`${temporaryRoot}/contracts/reference-vault/corpus-manifest.json`);
  const subject = await validRedistributionSubject();
  subject.document.operation = 'generate';
  subject.document.actor_role = 'reference_vault_generator';

  // When the public observer resolves the required package artifact.
  const observed = await observeReferenceVaultScenario(subject, temporaryRoot);

  // Then missing sealed state cannot produce a successful zero-digest receipt.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['generator.manifest_unavailable']);
});

for (const [condition, content] of [['malformed', '{'], ['schema-invalid', '{}\n']]) {
  test(`generation rejects a ${condition} sealed corpus manifest`, async (t) => {
    // Given a valid generation request with an invalid sealed corpus manifest.
    const temporaryRoot = await copyCommittedPackage();
    t.after(() => rm(resolve(temporaryRoot, '../..'), {recursive: true, force: true}));
    await writeFile(`${temporaryRoot}/contracts/reference-vault/corpus-manifest.json`, content);
    const subject = await validRedistributionSubject();
    subject.document.operation = 'generate';
    subject.document.actor_role = 'reference_vault_generator';

    // When the public observer resolves and validates the required package artifact.
    const observed = await observeReferenceVaultScenario(subject, temporaryRoot);

    // Then malformed or schema-invalid sealed state cannot produce a success receipt.
    assert.equal(observed.verdict, 'fail');
    assert.deepEqual(observed.codes, ['generator.manifest_invalid']);
  });
}

test('redistribution rejects lineage membership not bound to the sealed manifest', async () => {
  // Given caller-forged but internally consistent membership hashes and an invented train lineage.
  const subject = await validRedistributionSubject();
  const train = subject.document.partition_lineages.find(({partition_id: id}) => id === 'train');
  train.membership_sha256_before = 'f'.repeat(64);
  train.membership_sha256_after = 'f'.repeat(64);
  train.lineage_group_ids = ['lineage:999999'];
  subject.document.redistribution.lineage_group_id = 'lineage:999999';

  // When the public observer validates the redistribution against sealed corpus membership.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then caller agreement cannot replace the manifest commitment.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['corpus.partition_membership_unbound']);
});

test('generation rejects a duplicate coverage dimension', async () => {
  // Given a valid generation request with a sixth exact duplicate coverage row.
  const subject = await validRedistributionSubject();
  subject.document.operation = 'generate';
  subject.document.actor_role = 'reference_vault_generator';
  subject.document.coverage_accounts.push(structuredClone(subject.document.coverage_accounts[0]));

  // When the public observer validates unique total coverage.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then duplicate accounting is rejected at the closed schema boundary.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['schema.constraint']);
});

test('Reference Vault contract fails closed after a root schema error', async (t) => {
  // Given a present generator interface that does not satisfy its root schema.
  const temporaryRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(temporaryRoot, '../..'), {recursive: true, force: true}));
  await writeFile(`${temporaryRoot}/contracts/reference-vault/generator-interface.json`, '{}\n');

  // When the dedicated contract check validates the package boundary.
  const observed = await checkReferenceVaultContract(temporaryRoot);

  // Then it reports the schema failure without dereferencing the invalid document.
  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('schema.required_field'));
});

test('Reference Vault observer rejects an unresolved subject schema', async () => {
  // Given an otherwise valid subject that names a missing package schema.
  const subject = await validRedistributionSubject();
  subject.schema = 'contracts/schemas/missing-reference-vault-scenario.schema.json';

  // When the public observer resolves the declared schema boundary.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then unresolved schema state is reported as a deterministic fixture failure.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['fixture.schema_unresolved']);
});

test('redistribution binds a lineage to its sealed source shard', async () => {
  // Given a train lineage assigned to train-a but relabeled as a train-b source move.
  const subject = await validRedistributionSubject();
  subject.document.redistribution.source_shard = 'train-b';
  subject.document.redistribution.target_shard = 'train-a';

  // When the public observer evaluates the sealed shard commitments.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then partition membership alone cannot establish source-shard provenance.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['corpus.lineage_crossing']);
});

test('conformance requires below- and over-boundary fixture categories', async () => {
  // Given a conformance declaration that omits the below-boundary category requirement.
  const conformance = JSON.parse(await readFile(`${packageRoot}/conformance/manifest.yaml`, 'utf8'));
  const requirements = JSON.parse(await readFile(`${packageRoot}/normative/requirements.json`, 'utf8'));
  conformance.required_categories = conformance.required_categories.filter((category) => category !== 'below_boundary');

  // When category coverage is checked independently from the listed fixtures.
  const observed = await runConformance(
    packageRoot,
    conformance,
    requirements.requirements.map(({id}) => id),
    {verifyPublishedReports: false},
  );

  // Then the missing boundary category is an explicit conformance failure.
  assert.ok(observed.check.codes.includes('conformance.category_missing'));
});

test('denied Reference Vault transitions declare denial-specific retry results', async () => {
  // Given both normative Reference Vault lifecycle tables.
  const tables = await Promise.all([generationLifecycle, redistributionLifecycle]
    .map((path) => readFile(path, 'utf8').then(JSON.parse)));

  // When denied transitions are inspected independently from their emitted receipt names.
  const retryResults = tables.flatMap(({transitions}) => transitions
    .filter(({allowed}) => !allowed)
    .map(({idempotency}) => idempotency.retry_result));

  // Then no denial promises reuse of a nonexistent success receipt.
  assert.ok(retryResults.length > 0);
  assert.ok(retryResults.every((result) => result === 'return digest-identical denial result'));
});

test('recovery rejects a missing sealed recovery evidence report', async (t) => {
  // Given a valid recovery request in a package without its seeded recovery evidence.
  const temporaryRoot = await copyCommittedPackage();
  t.after(() => rm(resolve(temporaryRoot, '../..'), {recursive: true, force: true}));
  await unlink(`${temporaryRoot}/conformance/evidence/reference-vault-recovery-report.json`);
  const subject = await fixtureSubject(recoveryFixture);

  // When the public observer evaluates recovery through the package boundary.
  const observed = await observeReferenceVaultScenario(subject, temporaryRoot);

  // Then caller booleans cannot establish recovery without sealed evidence.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['generator.recovery_evidence_invalid']);
});

test('lifecycle rejects an allowed row exercised by the wrong authority', async () => {
  // Given an allowed redistribution transition requested by a role absent from the sealed row authority.
  const subject = await fixtureSubject(lifecycleFixture);
  subject.document.lifecycle.table_ref = 'contracts/transitions/reference-vault-redistribution-lifecycle.json';
  subject.document.lifecycle.transition_sha256 = '763c7efc82fae69e38447e0510bf18c093da85c7b6ba644ef37450931ddb3aa1';
  subject.document.lifecycle.from_state = 'sealed';
  subject.document.lifecycle.command = 'plan_redistribution';

  // When the public observer evaluates the selected lifecycle row.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then `allowed: true` alone cannot override the row authority contract.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['generator.authority_denied']);
});

test('lifecycle denial exposes the sealed row failure semantics', async () => {
  // Given a declared-but-denied generation transition and its sealed table row.
  const subject = await fixtureSubject(lifecycleFixture);
  const table = JSON.parse(await readFile(generationLifecycle, 'utf8'));
  const row = table.transitions.find(({from_state: state, command_or_event: command}) =>
    state === subject.document.lifecycle.from_state && command === subject.document.lifecycle.command);

  // When the public observer evaluates the illegal transition.
  const observed = await observeReferenceVaultScenario(subject, packageRoot);

  // Then the denial reports the exact sealed failure receipt, effects, and state.
  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, [row.failure_result.code]);
  assert.deepEqual(observed.receipts, row.failure_result.emitted_records);
  assert.deepEqual(observed.filesystem_effects, row.failure_result.filesystem_effects);
  assert.equal(observed.terminal_state, row.terminal_state);
  assert.equal(observed.illegal_transition, true);
});

test('Reference Vault lifecycle tables expose recovery ingress', async () => {
  // Given both normative Reference Vault lifecycle tables.
  const tables = await Promise.all([generationLifecycle, redistributionLifecycle]
    .map((path) => readFile(path, 'utf8').then(JSON.parse)));

  // When recovery ingress is derived independently from allowed transition outcomes.
  const ingressByTable = tables.map(({transitions}) => transitions.some((row) =>
    row.allowed && row.from_state !== 'recovery_required' &&
      row.failure_result.state_effect === 'recovery_required'));

  // Then generation and redistribution each model a reachable recovery-required state.
  assert.deepEqual(ingressByTable, [true, true]);
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

  // Then all 35 observable scenarios pass without materializing a Reference Vault.
  assert.equal(fixtures.length, 35);
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
