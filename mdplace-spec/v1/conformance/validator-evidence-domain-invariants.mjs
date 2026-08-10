import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {observeEvidenceExtension} from './evidence-extension.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {digest, extensionId, committedPackageRoot} from './validator-evidence-support.mjs';

test('claim-level unknown applicability cannot aggregate to pass', async () => {
  const claim = JSON.parse(await readFile(new URL('../conformance/claim-manifests/core.json', import.meta.url), 'utf8'));
  claim.applicability = 'unknown';
  claim.evidence_bindings[0].applicability = 'not_applicable';
  claim.verdict = 'pass';

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/claim-manifest.schema.json',
    document: claim,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('claim.mandatory_evidence_inconclusive'));
  assert.ok(observed.codes.includes('claim.applicability_mismatch'));
});

test('invocations reject duplicate ordered input identifiers', async () => {
  const invocation = JSON.parse(await readFile(
    new URL('../conformance/evidence/invocations/validator-evidence-reference.json', import.meta.url),
    'utf8',
  ));
  invocation.input_digests.push({...invocation.input_digests[0], ordinal: invocation.input_digests.length});

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/validator-invocation.schema.json',
    document: invocation,
  }, committedPackageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.invocation_input_duplicate'));
});

test('evidence envelopes exactly reproduce invocation inputs and execution context', async (t) => {
  const envelopePath = new URL('../conformance/evidence/envelopes/validator-evidence-reference.json', import.meta.url);
  await t.test('input digests', async () => {
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    envelope.input_digests.pop();

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-envelope.schema.json',
      document: envelope,
    }, committedPackageRoot);

    assert.equal(observed.verdict, 'fail');
    assert.ok(observed.codes.includes('evidence.invocation_binding_mismatch'));
  });
  await t.test('execution context', async () => {
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    envelope.execution_context.network_access = 'declared';

    const observed = await observeEvidenceExtension({
      extension_id: extensionId,
      schema: 'contracts/schemas/evidence-envelope.schema.json',
      document: envelope,
    }, committedPackageRoot);

    assert.equal(observed.verdict, 'fail');
    assert.ok(observed.codes.includes('evidence.invocation_binding_mismatch'));
  });
});

test('invocation subjects share the package and validator version binding', async () => {
  const packageRoot = await copyCommittedPackage();
  const subjectPath = 'contracts/verdicts/validator-verdicts.json';
  const subject = JSON.parse(await readFile(`${packageRoot}/${subjectPath}`, 'utf8'));
  subject.release_version = '2.0.0';
  const subjectContent = `${JSON.stringify(subject, null, 2)}\n`;
  await writeFile(`${packageRoot}/${subjectPath}`, subjectContent);
  const invocation = JSON.parse(await readFile(
    `${packageRoot}/conformance/evidence/invocations/validator-evidence-reference.json`,
    'utf8',
  ));
  invocation.subject.sha256 = digest(subjectContent);
  invocation.input_digests.find(({path}) => path === subjectPath).sha256 = digest(subjectContent);

  const observed = await observeEvidenceExtension({
    extension_id: extensionId,
    schema: 'contracts/schemas/validator-invocation.schema.json',
    document: invocation,
  }, packageRoot);

  assert.equal(observed.verdict, 'fail');
  assert.ok(observed.codes.includes('evidence.specification_version_mismatch'));
});

test('normative Claim Manifest artifacts use domain-approved names', async () => {
  const index = JSON.parse(await readFile(new URL('../claims-and-evidence.yaml', import.meta.url), 'utf8'));
  const claim = JSON.parse(await readFile(new URL('../conformance/claim-manifests/core.json', import.meta.url), 'utf8'));

  assert.equal(index.index_kind, 'profile_claims');
  assert.equal(claim.manifest_kind, 'profile_claim');
});

test('unsupported recovery is bound to a normative fixture and Traceability Record', async () => {
  const manifest = JSON.parse(await readFile(new URL('../conformance/manifest.yaml', import.meta.url), 'utf8'));
  const traceability = JSON.parse(await readFile(new URL('../traceability.yaml', import.meta.url), 'utf8'));
  const record = traceability.records.find(({requirement_id: id}) => id === 'REQ-VAL-006');

  assert.ok(manifest.fixtures.some(({fixture_id: id}) => id === 'FIX-VAL-REC-003'));
  assert.ok(record.negative_fixture_ids.includes('FIX-VAL-REC-003'));
});

test('test fixture digests are independently derived from their bytes', () => {
  // Given a known byte sequence.
  const content = '{"fixture":true}\n';
  // When its SHA-256 binding is computed.
  const binding = digest(content);
  // Then the independent known-good vector is stable.
  assert.equal(binding, '218589323cbe80b7ed077e3ee36f1663e7cb5f8f4e4ad02c938ad8a5c2c5a6b9');
});
