import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage, runPreparedPackage} from './validator-test-support.mjs';
import {digest, extensionId} from './validator-evidence-support.mjs';

test('CLI contains a malformed digest-bound Claim Manifest as a structured failure', async () => {
  const packageRoot = await copyCommittedPackage();
  const claimPath = 'conformance/claim-manifests/core.json';
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.evidence_bindings = [null];
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, claimContent);
  const indexPath = `${packageRoot}/claims-and-evidence.yaml`;
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.claims.find(({manifest_ref: path}) => path === claimPath).sha256 = digest(claimContent);
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({id, codes}) =>
    ['schema-instances', 'validator-evidence-contract'].includes(id) && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('CLI contains malformed recovery claim collections as structured failures', async () => {
  const packageRoot = await copyCommittedPackage();
  const recoveryPath = 'conformance/evidence/evidence-recovery-report.json';
  const recovery = JSON.parse(await readFile(`${packageRoot}/${recoveryPath}`, 'utf8'));
  const claimPath = recovery.claim.path;
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.evidence_bindings = 7;
  const claimContent = `${JSON.stringify(claim, null, 2)}\n`;
  const claimDigest = digest(claimContent);
  await writeFile(`${packageRoot}/${claimPath}`, claimContent);
  recovery.claim.sha256 = claimDigest;
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  Object.assign(claimBinding, {expected_sha256: claimDigest, observed_sha256: claimDigest, matches: true});
  await writeFile(`${packageRoot}/${recoveryPath}`, `${JSON.stringify(recovery, null, 2)}\n`);

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({id, codes}) =>
    ['schema-instances', 'validator-evidence-contract'].includes(id) && codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('CLI contains malformed normative requirement rows as structured failures', async () => {
  const packageRoot = await copyCommittedPackage();
  await writeFile(`${packageRoot}/normative/requirements.json`, '{"requirements":[null]}\n');

  const result = runPreparedPackage(packageRoot);
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.ok(report.checks.some(({codes}) => codes.includes('schema.constraint')));
  assert.equal(report.checks.some(({id}) => id === 'validator-boundary'), false);
});

test('recovery accepts an accurate stale downgrade from a prior pass', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const claimPath = recovery.claim.path;
  const changedClaim = `${await readFile(`${packageRoot}/${claimPath}`, 'utf8')}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, changedClaim);
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  claimBinding.observed_sha256 = digest(changedClaim);
  claimBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});

test('stale recovery retains semantic Claim Manifest failures', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const claimPath = recovery.claim.path;
  const claim = JSON.parse(await readFile(`${packageRoot}/${claimPath}`, 'utf8'));
  claim.requirement_id = 'REQ-VAL-999';
  const changedClaim = `${JSON.stringify(claim, null, 2)}\n`;
  await writeFile(`${packageRoot}/${claimPath}`, changedClaim);
  const claimBinding = recovery.recomputed_bindings.find(({path}) => path === claimPath);
  claimBinding.observed_sha256 = digest(changedClaim);
  claimBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('claim.requirement_unresolved'));
});

test('recovery accepts null as the truthful observation of an absent artifact', async () => {
  const packageRoot = await copyCommittedPackage();
  const recovery = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/evidence-recovery-report.json`,
    'utf8',
  ));
  const absentPath = 'normative/validator-evidence-contract.md';
  await unlink(`${packageRoot}/${absentPath}`);
  const absentBinding = recovery.recomputed_bindings.find(({path}) => path === absentPath);
  absentBinding.observed_sha256 = null;
  absentBinding.matches = false;
  recovery.terminal_state = 'evidence_stale';
  recovery.effective_verdict = 'inconclusive';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/evidence-recovery-report.schema.json',
    document: recovery,
  }, packageRoot);

  assert.equal(observed.verdict, 'pass');
  assert.equal(observed.terminal_state, 'evidence_stale');
});
