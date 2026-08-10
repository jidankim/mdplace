import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {validateJsonSchema} from './json-schema.mjs';
import {checkRequirements} from './package-checks.mjs';
import {observeTransition} from './transition-observer.mjs';
import {amendmentEvidenceMatches} from './amendment-evidence.mjs';
import {releaseEvidenceMatches} from './transition-evidence.mjs';
import {packageArtifactPathAllowed} from './validator-rules.mjs';
import {writePackageFile} from './safe-path.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';

const schemaModule = new URL('./json-schema.mjs', import.meta.url).href;

async function rewriteSourceRequirements(packageRoot, mutate) {
  const sourceRoot = join(packageRoot, 'conformance/release-targets/amendment/source');
  const requirementsPath = join(sourceRoot, 'normative/requirements.json');
  const requirements = JSON.parse(await readFile(requirementsPath, 'utf8'));
  const sourceIds = new Set(requirements.requirements.map(({id}) => id));
  mutate(requirements.requirements);
  const targetIds = new Set(requirements.requirements.map(({id}) => id));
  const removedIds = new Set([...sourceIds].filter((id) => !targetIds.has(id)));
  if (removedIds.size > 0) {
    const contractPath = join(sourceRoot, 'normative/package-contract.md');
    let excluded = false;
    const contract = (await readFile(contractPath, 'utf8')).split(/\r?\n/).filter((line) => {
      const heading = /^## (REQ-[A-Z][A-Z0-9]{1,15}-[0-9]{3}):/.exec(line);
      if (heading !== null) excluded = removedIds.has(heading[1]);
      else if (line.startsWith('## ')) excluded = false;
      return !excluded;
    }).join('\n');
    await writeFile(contractPath, contract);
  }
  await writeFile(requirementsPath, `${JSON.stringify(requirements, null, 2)}\n`);
  const manifestPath = join(sourceRoot, 'package-manifest.yaml');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const artifact of manifest.artifacts) {
    artifact.sha256 = createHash('sha256').update(await readFile(join(sourceRoot, artifact.path))).digest('hex');
  }
  manifest.normative_digest = createHash('sha256').update(manifest.artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({path, sha256}) => `${path}\0${sha256}\n`).join('')).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest.normative_digest;
}

test('schema validation bounds catastrophic regular-expression evaluation', () => {
  const program = `
    import {validateJsonSchema} from ${JSON.stringify(schemaModule)};
    process.stdout.write(JSON.stringify(validateJsonSchema(
      {type: 'string', pattern: '^(a+)+$'},
      'a'.repeat(1023) + '!'
    )));
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    encoding: 'utf8',
    timeout: 1_000,
  });

  assert.ifError(result.error);
  assert.ok(JSON.parse(result.stdout).some(({keyword}) => keyword === 'resourceLimit'));
});

test('schema validation never reports more than its global error budget', () => {
  const required = Array.from({length: 10_000}, (_, index) => `missing_${index}`);

  const errors = validateJsonSchema({type: 'object', required}, {});

  assert.equal(errors.length, 256);
});

test('semantic requirement checks accept the shared downstream namespace width', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'mdplace-downstream-requirement-'));
  const packageRoot = join(workspace, 'mdplace-spec/v1');
  await mkdir(join(packageRoot, 'normative'), {recursive: true});
  await writeFile(join(workspace, 'CONTEXT.md'), '**Specification Package**:\nFixture.\n');
  await writeFile(
    join(packageRoot, 'normative/downstream.md'),
    '## REQ-VALIDATOR-001: Downstream validator requirement\n',
  );
  const requirements = {requirements: [{
    id: 'REQ-VALIDATOR-001',
    normative_anchor: 'normative/downstream.md#req-validator-001-downstream-validator-requirement',
    canonical_terms: ['Specification Package'],
  }]};

  const result = await checkRequirements(packageRoot, requirements);

  assert.equal(result.verdict, 'pass');
});

test('specification-only policy admits only known conformance executables', () => {
  assert.equal(packageArtifactPathAllowed('conformance/validator.mjs'), true);
  assert.equal(packageArtifactPathAllowed('conformance/validator-security-cases.mjs'), true);
  assert.equal(packageArtifactPathAllowed('conformance/semantic-kernel.mjs'), false);
});

test('evidence output never follows a package-external symlink', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'mdplace-safe-evidence-write-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-evidence-'));
  await mkdir(join(packageRoot, 'conformance/evidence'), {recursive: true});
  const external = join(externalRoot, 'external.json');
  await writeFile(external, 'preserve me\n');
  await symlink(external, join(packageRoot, 'conformance/evidence/validation-report.json'));

  const result = await writePackageFile(
    packageRoot,
    'conformance/evidence/validation-report.json',
    'replacement\n',
  );

  assert.equal(result.status, 'unsafe');
  assert.equal(await readFile(external, 'utf8'), 'preserve me\n');
});

test('evidence output refuses a symlinked parent directory', async () => {
  const packageRoot = await mkdtemp(join(tmpdir(), 'mdplace-safe-evidence-parent-'));
  const externalRoot = await mkdtemp(join(tmpdir(), 'mdplace-external-evidence-parent-'));
  await mkdir(join(packageRoot, 'conformance'), {recursive: true});
  const external = join(externalRoot, 'validation-report.json');
  await writeFile(external, 'preserve parent target\n');
  await symlink(externalRoot, join(packageRoot, 'conformance/evidence'));

  const result = await writePackageFile(
    packageRoot,
    'conformance/evidence/validation-report.json',
    'replacement\n',
  );

  assert.equal(result.status, 'unsafe');
  assert.equal(await readFile(external, 'utf8'), 'preserve parent target\n');
});

test('transition observation rejects a lifecycle state contradicted by its observed manifest', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-submit.json'),
    'utf8',
  ));
  fixture.subject.preconditions.state_manifest_ref = 'package-manifest.yaml';

  const observed = await observeTransition(fixture, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['transition.precondition_failed']);
});

test('amendment observation derives changed IDs from source and target catalogs', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-amend.json'),
    'utf8',
  ));
  fixture.subject.amendment_evidence.changed_requirement_ids = ['REQ-PKG-005'];

  const observed = await observeTransition(fixture, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['release.immutable']);
});

test('amendment observation rejects an unmarked same-ID meaning change', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-amend.json'),
    'utf8',
  ));
  fixture.subject.amendment_evidence.source_digest = await rewriteSourceRequirements(
    packageRoot,
    (requirements) => {
      requirements.find(({id}) => id === 'REQ-PKG-005').acceptance_gate = 'Earlier reassigned meaning.';
    },
  );

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('amendment observation accepts a target-only ID when it is marked new', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-amend.json'),
    'utf8',
  ));
  fixture.subject.amendment_evidence.source_digest = await rewriteSourceRequirements(
    packageRoot,
    (requirements) => requirements.splice(requirements.findIndex(({id}) => id === 'REQ-PKG-012'), 1),
  );
  fixture.subject.amendment_evidence.new_requirement_ids = ['REQ-PKG-012'];

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), true);
});

test('amendment observation rejects removal of a released requirement ID', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-amend.json'),
    'utf8',
  ));
  fixture.subject.amendment_evidence.source_digest = await rewriteSourceRequirements(
    packageRoot,
    (requirements) => requirements.push({...requirements.at(-1), id: 'REQ-PKG-999'}),
  );

  assert.equal(await amendmentEvidenceMatches(fixture.subject, packageRoot), false);
});

test('release observation requires digest-bound validator and traceability assets', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-release.json'),
    'utf8',
  ));
  delete fixture.subject.release_evidence.release_assets;

  const observed = await observeTransition(fixture, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.deepEqual(observed.codes, ['transition.precondition_failed']);
});

test('release observation rejects changed generated traceability evidence', async () => {
  const packageRoot = await copyCommittedPackage();
  const fixture = JSON.parse(await readFile(
    join(packageRoot, 'conformance/fixtures/positive/authorized-release.json'),
    'utf8',
  ));
  await writeFile(
    join(packageRoot, 'conformance/evidence/traceability-report.json'),
    '{"verdict":"pass"}\n',
  );

  assert.equal(await releaseEvidenceMatches(fixture.subject, packageRoot), false);
});
