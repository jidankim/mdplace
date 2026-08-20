import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, writeFile} from 'node:fs/promises';
import {conformanceDigestForArtifacts} from './digest-bindings.mjs';
import {checkArtifactBindings} from './package-checks.mjs';
import {copyCommittedPackage} from './validator-test-support.mjs';
import {runExtensionFixture} from './validator-evidence-fixture-support.mjs';
import {expected, digest, validatorVersion} from './validator-evidence-support.mjs';

test('CLI enforces the verdict table availability matrix for every claim binding', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    applicability: 'applicable',
    verdict: 'fail',
    evidence_requirements: [{evidence_kind: 'contradiction', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'contradiction', mandatory: true, availability: 'missing',
      applicability: 'applicable', evidence_ref: null, evidence_digest: null, verdict: 'fail',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-104',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.verdict_availability_mismatch'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI keeps unknown mandatory applicability in the aggregate verdict', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-VAL-005',
    applicability: 'unknown',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'undetermined', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'undetermined', mandatory: true, availability: 'missing',
      applicability: 'unknown', evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-105',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.mandatory_evidence_inconclusive'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI rejects a Claim Manifest whose normative requirement is unresolved', async () => {
  const document = {
    schema_id: 'mdplace.claim-manifest/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    requirement_id: 'REQ-FAKE-999',
    applicability: 'not_applicable',
    verdict: 'pass',
    evidence_requirements: [{evidence_kind: 'irrelevant', mandatory: true}],
    evidence_bindings: [{
      evidence_kind: 'irrelevant', mandatory: true, availability: 'missing',
      applicability: 'not_applicable', evidence_ref: null, evidence_digest: null, verdict: 'inconclusive',
    }],
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-106',
    schemaPath: 'contracts/schemas/claim-manifest.schema.json',
    document,
    oracle: expected({
      verdict: 'fail',
      codes: ['claim.requirement_unresolved'],
      output: 'claim manifest rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate mandatory evidence',
        'validate bound evidence envelopes',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI contains malformed transition rows as structured extension failures', async () => {
  const document = {
    schema_id: 'mdplace.evidence-transition-attempt/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: validatorVersion,
    table_ref: 'contracts/transitions/evidence-lifecycle.json',
    from_state: 'awaiting_evidence',
    command: 'record_verdict',
  };

  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-107',
    schemaPath: 'contracts/schemas/evidence-transition-attempt.schema.json',
    document,
    extraFiles: {'contracts/transitions/evidence-lifecycle.json': '{"transitions":[null]}\n'},
    oracle: expected({
      verdict: 'fail',
      codes: ['evidence.transition_unresolved'],
      output: 'evidence transition rejected',
      operations: [
        'resolve validator extension', 'validate extension document',
        'verify specification and validator bindings', 'evaluate evidence lifecycle',
      ],
      terminalState: 'rejected',
    }),
  });
});

test('CLI contains a malformed subject-schema registry as a structured extension failure', async () => {
  await runExtensionFixture({
    fixtureId: 'FIX-VAL-NEG-108',
    schemaPath: 'contracts/schemas/evidence-envelope.schema.json',
    subjectSchemas: 7,
    document: {schema_id: 'mdplace.evidence-envelope/v1'},
    oracle: expected({
      verdict: 'fail',
      codes: ['schema.constraint'],
      output: 'validator extension rejected',
      operations: ['resolve validator extension'],
      terminalState: 'rejected',
    }),
  });
});

test('evidence authority cannot be downgraded by changing the validator version literal', async () => {
  const packageRoot = await copyCommittedPackage();
  const manifestPath = `${packageRoot}/package-manifest.yaml`;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.validator_version = '1.0.0';
  for (const artifact of manifest.artifacts) {
    if (artifact.path === 'claims-and-evidence.yaml' ||
        artifact.path.startsWith('conformance/claim-manifests/') ||
        artifact.path.startsWith('conformance/evidence/claims/') ||
        artifact.path.startsWith('conformance/evidence/envelopes/') ||
        artifact.path.startsWith('conformance/evidence/invocations/') ||
        artifact.path === 'conformance/evidence/evidence-recovery-report.json') {
      artifact.authority = 'informative';
    }
  }
  manifest.normative_digest = digest(manifest.artifacts
    .filter(({authority}) => authority === 'normative')
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(({path, sha256}) => `${path}\0${sha256}\n`)
    .join(''));
  manifest.conformance_digest = conformanceDigestForArtifacts(manifest.artifacts);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const {check} = await checkArtifactBindings(packageRoot, manifest);

  assert.ok(check.codes.includes('artifact.authority_mismatch'));
});
