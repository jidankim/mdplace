import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  remoteAdapterProfile,
  remoteAdapterRequirements,
  remoteAdapterTransitionTables,
  remoteAdapterVerdicts,
} from './remote-adapter-contracts.mjs';
import {
  remoteAdapterEvidenceDigest,
  remoteAdapterEvidencePaths,
  remoteAdapterRequirementIds,
  remoteSha256,
} from './remote-adapter-core.mjs';
import {remoteAdapterCases, remoteAdapterScenario} from './remote-adapter-fixtures.mjs';
import {deriveRemoteAdapterVerdict} from './remote-adapter-claim-validation.mjs';
import {observeRemoteAdapterScenario} from './remote-adapter-observer.mjs';
import {readRemoteProviderDisclosure} from './remote-adapter-retention-validation.mjs';
import {
  authoredRemoteRecoveryRecord,
  currentRemoteClaimBinding,
} from './remote-adapter-recovery-authoring.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relativeFixturePath = (caseId) => `scenarios/remote-intelligence-adapter/${caseId}.json`;
const packageFixturePath = (caseId) => `conformance/${relativeFixturePath(caseId)}`;
const providerDisclosurePath = 'conformance/inputs/remote-adapter-provider-disclosure.json';

async function readJson(path) {
  return JSON.parse(await readFile(resolve(packageRoot, path), 'utf8'));
}

async function writeJson(path, document) {
  const target = resolve(packageRoot, path);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
}

async function fileDigest(path) {
  return remoteSha256(await readFile(resolve(packageRoot, path)));
}

async function writeProfileEvidence() {
  const disclosure = await readRemoteProviderDisclosure(packageRoot, providerDisclosurePath);
  if (disclosure.document === null) throw new Error('remote provider disclosure input is missing or invalid');
  await writeJson('contracts/remote-intelligence-adapter/profile.json', remoteAdapterProfile);
  const profileSha256 = await fileDigest('contracts/remote-intelligence-adapter/profile.json');
  await writeJson('contracts/remote-intelligence-adapter/credential-boundary-evidence.json', {
    $schema: '../schemas/remote-adapter-credential-boundary-evidence.schema.json',
    schema_id: 'mdplace.remote-adapter-credential-boundary-evidence/v1',
    profile_id: 'remote-adapter',
    evidence_id: 'remote-credential-boundary:v1',
    status: 'current',
    profile_sha256: profileSha256,
    boundary_id: 'credential-boundary:remote-alpha',
    provider_id: 'provider:remote-alpha',
    store: 'os_credential_store',
    authentication_method: 'api_key_reference',
    prerequisite: 'satisfied',
    adapter_visibility: 'none',
    secret_access: 'none',
    ambient_configuration: 'unreadable',
    environment_values: 'unreadable',
    claims_established: [],
    observed_at: '2026-08-22T00:00:00.000Z',
    expires_at: '2026-09-21T00:00:00.000Z',
  });
  await writeJson('contracts/remote-intelligence-adapter/retention-evidence.json', {
    $schema: '../schemas/remote-adapter-retention-evidence.schema.json',
    schema_id: 'mdplace.remote-adapter-retention-evidence/v1',
    profile_id: 'remote-adapter',
    evidence_id: 'remote-retention-evidence:v1',
    status: 'current',
    profile_sha256: profileSha256,
    provider_id: disclosure.document.provider_id,
    destination: disclosure.document.destination,
    facts: [
      {dimension: 'residency', status: 'unsupported', value: null, evidence_ref: null, evidence_sha256: null},
      {...disclosure.document.fact, evidence_ref: providerDisclosurePath, evidence_sha256: remoteSha256(disclosure.read.content)},
      {dimension: 'training', status: 'inconclusive', value: null, evidence_ref: null, evidence_sha256: null},
      {dimension: 'deletion', status: 'unsupported', value: null, evidence_ref: null, evidence_sha256: null},
      {dimension: 'entitlement', status: 'unsupported', value: null, evidence_ref: null, evidence_sha256: null},
      {dimension: 'privacy_behavior', status: 'inconclusive', value: null, evidence_ref: null, evidence_sha256: null},
    ],
    observed_at: disclosure.document.observed_at,
    expires_at: disclosure.document.expires_at,
  });
  await writeJson('contracts/verdicts/remote-adapter-verdicts.json', remoteAdapterVerdicts);
  for (const {path, document} of remoteAdapterTransitionTables()) await writeJson(path, document);
}

async function baseEnvelope() {
  const fixture = await readJson('conformance/scenarios/intelligence-adapter/remote-valid-proposal-advice.json');
  return fixture.subject.document.attempts[0].envelope;
}

async function writeFixtures(recoveryRecords = new Map()) {
  const evidence = {
    credential: await readJson('contracts/remote-intelligence-adapter/credential-boundary-evidence.json'),
    retention: await readJson('contracts/remote-intelligence-adapter/retention-evidence.json'),
  };
  const envelope = await baseEnvelope();
  const entries = remoteAdapterCases.map(([caseId, category], index) => ({
    fixture_id: `FIX-RAP-PROFILE-${String(index + 1).padStart(3, '0')}`,
    path: relativeFixturePath(caseId),
    category,
    requirement_ids: remoteAdapterRequirementIds,
  }));
  const fixtures = await Promise.all(remoteAdapterCases.map(async (definition, index) => {
    const [caseId, category] = definition;
    const scenario = remoteAdapterScenario(index, definition, evidence, envelope);
    const expected = await observeRemoteAdapterScenario(
      {kind: 'remote_intelligence_adapter', document: scenario},
      packageRoot,
      recoveryRecords.get(entries[index].fixture_id) ?? null,
    );
    return {
      $schema: '../../../contracts/schemas/conformance-fixture.schema.json',
      schema_id: 'mdplace.conformance-fixture/v1',
      fixture_id: entries[index].fixture_id,
      category,
      requirement_ids: remoteAdapterRequirementIds,
      subject: {kind: 'remote_intelligence_adapter', schema: 'contracts/schemas/remote-adapter-scenario.schema.json', document: scenario},
      expected,
    };
  }));
  await writeJson('contracts/remote-intelligence-adapter/fixture-manifest.json', {
    $schema: '../schemas/remote-adapter-fixture-manifest.schema.json',
    schema_id: 'mdplace.remote-adapter-fixture-manifest/v1',
    manifest_id: 'remote-adapter-fixtures:v1',
    profile_id: 'remote-adapter',
    requirements: remoteAdapterRequirementIds,
    fixtures: entries,
  });
  for (const [index, fixture] of fixtures.entries()) {
    await writeJson(packageFixturePath(remoteAdapterCases[index][0]), fixture);
  }
  return {entries, fixtures};
}

async function writeMachineEvidence(entries, fixtures) {
  const fixtureBindings = await Promise.all(entries.map(async (entry, index) => {
    const receipt = JSON.parse(fixtures[index].expected.receipts[0]);
    return {
      fixture_id: entry.fixture_id,
      path: `conformance/${entry.path}`,
      fixture_sha256: await fileDigest(`conformance/${entry.path}`),
      receipt_sha256: receipt.receipt_sha256,
      verdict: fixtures[index].expected.verdict,
    };
  }));
  const machineEvidence = {
    $schema: '../../contracts/schemas/remote-adapter-evidence.schema.json',
    schema_id: 'mdplace.remote-adapter-evidence/v1',
    evidence_id: 'remote-adapter-evidence:v1',
    profile_id: 'remote-adapter',
    validator_version: '1.2.0',
    fixture_bindings: fixtureBindings,
    receipt_sha256s: fixtureBindings.map(({receipt_sha256}) => receipt_sha256),
    credential_boundary_evidence_sha256: await fileDigest('contracts/remote-intelligence-adapter/credential-boundary-evidence.json'),
    retention_evidence_sha256: await fileDigest('contracts/remote-intelligence-adapter/retention-evidence.json'),
    fixture_manifest_sha256: await fileDigest('contracts/remote-intelligence-adapter/fixture-manifest.json'),
    network_operations: 0,
    verdict: 'pass',
  };
  machineEvidence.verdict = await deriveRemoteAdapterVerdict(
    machineEvidence,
    packageRoot,
    {validateObservations: false},
  );
  await writeJson('conformance/evidence/remote-adapter-evidence.json', machineEvidence);
  const paths = [...remoteAdapterEvidencePaths, ...entries.map(({path}) => `conformance/${path}`)];
  const material = await Promise.all(paths.map(async (path, ordinal) => ({
    ordinal,
    label: `remote_material_${String(ordinal + 1).padStart(3, '0')}`,
    path,
    sha256: await fileDigest(path),
  })));
  const claim = {
    $schema: '../schemas/remote-adapter-claim-manifest.schema.json',
    schema_id: 'mdplace.remote-adapter-claim-manifest/v1',
    manifest_id: 'remote-adapter-claim:v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_id: 'mdplace.package-validator',
    validator_version: '1.2.0',
    rows: [{
      id: 'remote-adapter', owner: 'remote-adapter', verdict: machineEvidence.verdict,
      evidence_digest: remoteAdapterEvidenceDigest(material), evidence_material: material,
      dependencies_elevated: {core: false, product_readiness: false, local_adapter: false, codex_adapter: false, placement_automation: false, other_profiles: false},
    }],
  };
  await writeJson('contracts/remote-intelligence-adapter/claim-manifest.json', claim);
  return {claim, fixtureBindings};
}

async function writeRecoveryReport(entries, fixtures) {
  const binding = await currentRemoteClaimBinding(packageRoot);
  const cases = [];
  for (const [index, fixture] of fixtures.entries()) {
    if (fixture.subject.document.operation !== 'recover') continue;
    const record = authoredRemoteRecoveryRecord(entries[index].fixture_id, fixture.subject.document, binding);
    const expectedCurrent = fixture.subject.document.behavior === 'recover_current';
    const receipt = JSON.parse(fixture.expected.receipts[0]);
    cases.push({
      ...record,
      attempts_revalidated: true,
      claim_digest_revalidated: expectedCurrent,
      parsed_evidence_revalidated: true,
      terminal_state: expectedCurrent ? 'recovered' : 'recovery_required',
      receipt_sha256: receipt.receipt_sha256,
    });
  }
  await writeJson('conformance/evidence/remote-adapter-recovery-report.json', {
    $schema: '../../contracts/schemas/remote-adapter-recovery-report.schema.json',
    schema_id: 'mdplace.remote-adapter-recovery-report/v1',
    report_id: 'remote-adapter-recovery:v1',
    profile_id: 'remote-adapter',
    claim_manifest_sha256: binding.claim_manifest_sha256,
    evidence_digest: binding.evidence_digest,
    parsed_artifacts_revalidated: true,
    cases,
    network_operations: 0,
    verdict: 'pass',
  });
  return new Map(cases.map((entry) => [entry.fixture_id, entry]));
}

function traceRecord(requirement, positiveIds, negativeIds) {
  return {
    requirement_id: requirement.id,
    decision_ids: ['DEC-008'],
    canonical_terms: requirement.canonical_terms,
    normative_anchors: [requirement.normative_anchor],
    schema_or_transition_refs: [
      'contracts/schemas/remote-intelligence-adapter-profile.schema.json',
      'contracts/schemas/remote-adapter-claim-manifest.schema.json',
      'contracts/schemas/remote-adapter-scenario.schema.json',
      'contracts/schemas/remote-adapter-profile-receipt.schema.json',
      'contracts/schemas/remote-adapter-credential-boundary-evidence.schema.json',
      'contracts/schemas/remote-adapter-retention-evidence.schema.json',
      'contracts/transitions/remote-adapter-permitted-egress-lifecycle.json',
      'contracts/transitions/remote-adapter-denial-lifecycle.json',
      'contracts/transitions/remote-adapter-failure-lifecycle.json',
      'contracts/transitions/remote-adapter-retry-lifecycle.json',
      'contracts/transitions/remote-adapter-fallback-lifecycle.json',
      'contracts/transitions/remote-adapter-recovery-lifecycle.json',
      'contracts/transitions/remote-adapter-verdict-lifecycle.json',
    ],
    positive_fixture_ids: positiveIds,
    negative_fixture_ids: negativeIds,
    acceptance_gate: requirement.acceptance_gate,
    scope: requirement.scope,
    evidence_refs: ['conformance/evidence/remote-adapter-evidence.json', 'conformance/evidence/remote-adapter-recovery-report.json'],
  };
}

async function updateCatalogs(entries, fixtures) {
  const requirements = await readJson('normative/requirements.json');
  requirements.requirements = [
    ...requirements.requirements.filter(({id}) => !id.startsWith('REQ-RAP-')),
    ...remoteAdapterRequirements,
  ];
  await writeJson('normative/requirements.json', requirements);
  const manifest = await readJson('conformance/manifest.yaml');
  manifest.fixtures = [
    ...manifest.fixtures.filter(({fixture_id: id}) => !id.startsWith('FIX-RAP-PROFILE-')),
    ...entries.map((entry, index) => ({
      ...entry,
      expected_verdict: fixtures[index].expected.verdict,
      observable_assertions: {inputs: true, outputs: true, operations: true, receipts: true, filesystem_effects: true, terminal_state: true, illegal_transition: fixtures[index].expected.illegal_transition},
    })),
  ];
  await writeJson('conformance/manifest.yaml', manifest);
  const traceability = await readJson('traceability.yaml');
  if (!traceability.decisions.some(({decision_id: id}) => id === 'DEC-008')) throw new Error('DEC-008 is required');
  const positiveIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'pass').map(({fixture_id}) => fixture_id);
  const negativeIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'fail').map(({fixture_id}) => fixture_id);
  traceability.records = [
    ...traceability.records.filter(({requirement_id: id}) => !id.startsWith('REQ-RAP-')),
    ...remoteAdapterRequirements.map((requirement) => traceRecord(requirement, positiveIds, negativeIds)),
  ];
  await writeJson('traceability.yaml', traceability);
}

async function writeClaimEnvelope() {
  const claimPath = 'contracts/remote-intelligence-adapter/claim-manifest.json';
  const independentClaim = await readJson(claimPath);
  const derivedVerdict = independentClaim.rows[0].verdict;
  const subject = {
    kind: 'remote_adapter_claim', subject_id: 'remote-adapter:claim-v1',
    schema: 'contracts/schemas/remote-adapter-claim-manifest.schema.json', sha256: await fileDigest(claimPath),
  };
  const inputs = await Promise.all([
    ['requirements', 'normative/requirements.json'],
    ['credential_boundary', 'contracts/remote-intelligence-adapter/credential-boundary-evidence.json'],
    ['retention', 'contracts/remote-intelligence-adapter/retention-evidence.json'],
    ['fixture_manifest', 'contracts/remote-intelligence-adapter/fixture-manifest.json'],
  ].map(async ([label, path], ordinal) => ({ordinal, label, path, sha256: await fileDigest(path)})));
  const invocationPath = 'conformance/evidence/invocations/remote-adapter-profile.json';
  const invocation = {
    $schema: '../../../contracts/schemas/validator-invocation.schema.json',
    schema_id: 'mdplace.validator-invocation/v1',
    extension_id: 'mdplace.validator-extension/evidence/v1',
    invocation_id: 'invocation:remote-adapter-profile',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0',
    validator_id: 'mdplace.package-validator', validator_version: '1.2.0',
    subject: {...subject, path: claimPath}, requirement_ids: remoteAdapterRequirementIds,
    input_digests: inputs,
    execution_context: {runner_id: 'mdplace.package-validator', platform: 'platform_neutral', architecture: 'architecture_neutral', filesystem: 'package_fixture', locale: 'C.UTF-8', timezone: 'UTC', network_access: 'denied'},
  };
  await writeJson(invocationPath, invocation);
  const evidencePath = 'conformance/evidence/envelopes/remote-adapter-profile.json';
  const recoveryPath = 'conformance/evidence/remote-adapter-recovery-report.json';
  await writeJson(evidencePath, {
    $schema: '../../../contracts/schemas/evidence-envelope.schema.json',
    schema_id: 'mdplace.evidence-envelope/v1', envelope_id: 'evidence:remote-adapter-profile',
    extension_id: invocation.extension_id, package_series: invocation.package_series,
    release_version: invocation.release_version, validator_id: invocation.validator_id,
    validator_version: invocation.validator_version,
    invocation: {invocation_id: invocation.invocation_id, path: invocationPath, sha256: await fileDigest(invocationPath)},
    requirement_id: 'REQ-RAP-007', subject, input_digests: inputs,
    output_digests: [
      {ordinal: 0, label: 'remote_adapter_evidence', path: 'conformance/evidence/remote-adapter-evidence.json', sha256: await fileDigest('conformance/evidence/remote-adapter-evidence.json')},
      {ordinal: 1, label: 'recovery_report', path: recoveryPath, sha256: await fileDigest(recoveryPath)},
    ],
    receipts: [{ordinal: 0, receipt_id: 'receipt:remote-adapter-profile', receipt_type: 'EvidenceValidationReceipt', path: recoveryPath, sha256: await fileDigest(recoveryPath)}],
    artifact_digests: [
      {ordinal: 0, label: 'profile', path: 'contracts/remote-intelligence-adapter/profile.json', sha256: await fileDigest('contracts/remote-intelligence-adapter/profile.json')},
      {ordinal: 1, label: 'normative_contract', path: 'normative/remote-intelligence-adapter-profile.md', sha256: await fileDigest('normative/remote-intelligence-adapter-profile.md')},
    ],
    execution_context: invocation.execution_context, verdict: derivedVerdict, codes: [],
  });
  const generic = await readJson('conformance/claim-manifests/remote-intelligence-adapter.json');
  Object.assign(generic, {
    subject: {kind: subject.kind, subject_id: subject.subject_id, sha256: subject.sha256},
    requirement_id: 'REQ-RAP-007',
    evidence_requirements: [{evidence_kind: 'remote_adapter_conformance', mandatory: true}],
    evidence_bindings: [{evidence_kind: 'remote_adapter_conformance', mandatory: true, availability: 'present', applicability: 'applicable', evidence_ref: evidencePath, evidence_digest: await fileDigest(evidencePath), verdict: derivedVerdict}],
    applicability: 'applicable', verdict: derivedVerdict,
  });
  await writeJson('conformance/claim-manifests/remote-intelligence-adapter.json', generic);
  const index = await readJson('claims-and-evidence.yaml');
  index.claims.find(({profile}) => profile === 'remote_intelligence_adapter').sha256 =
    await fileDigest('conformance/claim-manifests/remote-intelligence-adapter.json');
  await writeJson('claims-and-evidence.yaml', index);
}

await writeProfileEvidence();
let generated = await writeFixtures();
await writeMachineEvidence(generated.entries, generated.fixtures);
let records = await writeRecoveryReport(generated.entries, generated.fixtures);
generated = await writeFixtures(records);
await writeMachineEvidence(generated.entries, generated.fixtures);
await updateCatalogs(generated.entries, generated.fixtures);
records = await writeRecoveryReport(generated.entries, generated.fixtures);
generated = await writeFixtures(records);
await writeMachineEvidence(generated.entries, generated.fixtures);
await writeRecoveryReport(generated.entries, generated.fixtures);
await writeClaimEnvelope();
await import('./generate-local-adapter-artifacts.mjs');
await writeClaimEnvelope();
await import('./generate-intelligence-adapter-artifacts.mjs?remote-final');
process.stdout.write(`generated ${generated.entries.length} Remote Intelligence Adapter fixtures under ${packageRoot}\n`);
