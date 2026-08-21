import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  codexAdapterProfile,
  codexAdapterRequirements,
  codexAdapterTransitionTables,
  codexAdapterVerdicts,
} from './codex-adapter-contracts.mjs';
import {
  codexAdapterEvidenceDigest,
  codexAdapterEvidencePaths,
  codexAdapterRequirementIds,
  codexDecisionIds,
  codexDecisionInputs,
  codexSha256,
} from './codex-adapter-core.mjs';
import {
  codexAdapterCases,
  codexAdapterScenario,
  codexAuthenticationPrerequisite,
  codexCapabilityProof,
  codexNetworkProof,
} from './codex-adapter-fixtures.mjs';
import {observeCodexAdapterScenario} from './codex-adapter-observer.mjs';
import {codexAdapterSchemas} from './codex-adapter-schemas.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relativeFixturePath = (caseId) => `scenarios/codex-intelligence-adapter/${caseId}.json`;
const packageFixturePath = (caseId) => `conformance/${relativeFixturePath(caseId)}`;

async function readJson(path) {
  return JSON.parse(await readFile(resolve(packageRoot, path), 'utf8'));
}

async function writeJson(path, document) {
  const target = resolve(packageRoot, path);
  await mkdir(dirname(target), {recursive: true});
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
}

async function fileDigest(path) {
  return codexSha256(await readFile(resolve(packageRoot, path)));
}

async function writeSchemasAndContracts() {
  for (const [path, schema] of codexAdapterSchemas) await writeJson(path, schema);
  await writeJson('contracts/codex-intelligence-adapter/profile.json', codexAdapterProfile);
  await writeJson('contracts/codex-intelligence-adapter/authentication-prerequisite.json', codexAuthenticationPrerequisite);
  await writeJson('contracts/codex-intelligence-adapter/capability-proof.json', codexCapabilityProof);
  await writeJson('contracts/codex-intelligence-adapter/network-proof.json', codexNetworkProof);
  await writeJson('contracts/verdicts/codex-adapter-verdicts.json', codexAdapterVerdicts);
  for (const {path, document} of codexAdapterTransitionTables()) await writeJson(path, document);
}

function recoveryRecords(entries) {
  const records = new Map();
  for (const entry of entries) {
    const definition = codexAdapterCases[Number(entry.fixture_id.slice(-3)) - 1];
    const behavior = definition[2].behavior;
    if (!['crash_before_transmission', 'crash_after_transmission', 'recover_current', 'recover_stale'].includes(behavior)) continue;
    const current = behavior === 'recover_current';
    records.set(entry.fixture_id, {
      fixture_id: entry.fixture_id,
      boundary_revalidated: current,
      capability_revalidated: current,
      network_revalidated: current,
      authentication_revalidated: current,
      processing_envelope_revalidated: current,
      terminal_state: current ? 'recovered' : 'recovery_required',
      receipt_sha256: '0'.repeat(64),
    });
  }
  return records;
}

async function writeFixtures() {
  const entries = codexAdapterCases.map(([caseId, category], index) => ({
    fixture_id: `FIX-CODEX-PROFILE-${String(index + 1).padStart(3, '0')}`,
    path: relativeFixturePath(caseId), category, requirement_ids: codexAdapterRequirementIds,
  }));
  const records = recoveryRecords(entries);
  const evidence = {authentication: codexAuthenticationPrerequisite, capability: codexCapabilityProof, network: codexNetworkProof};
  const fixtures = await Promise.all(codexAdapterCases.map(async (definition, index) => {
    const scenario = codexAdapterScenario(index, definition, evidence);
    const expected = await observeCodexAdapterScenario(
      {kind: 'codex_intelligence_adapter', document: scenario}, packageRoot,
      records.get(entries[index].fixture_id) ?? null,
    );
    const receipt = JSON.parse(expected.receipts[0]);
    const record = records.get(entries[index].fixture_id);
    if (record !== undefined) record.receipt_sha256 = receipt.receipt_sha256;
    return {
      $schema: '../../../contracts/schemas/conformance-fixture.schema.json', schema_id: 'mdplace.conformance-fixture/v1',
      fixture_id: entries[index].fixture_id, category: entries[index].category, requirement_ids: codexAdapterRequirementIds,
      subject: {kind: 'codex_intelligence_adapter', schema: 'contracts/schemas/codex-adapter-scenario.schema.json', document: scenario},
      expected,
    };
  }));
  await writeJson('contracts/codex-intelligence-adapter/fixture-manifest.json', {
    $schema: '../schemas/codex-adapter-fixture-manifest.schema.json', schema_id: 'mdplace.codex-adapter-fixture-manifest/v1',
    manifest_id: 'codex-adapter-fixtures:v1', profile_id: 'codex-adapter', requirements: codexAdapterRequirementIds,
    fixtures: entries, intake_fixtures: 0, stateful_scenarios: 0,
  });
  for (const [index, fixture] of fixtures.entries()) await writeJson(packageFixturePath(codexAdapterCases[index][0]), fixture);

  const firstBoundary = JSON.parse(fixtures[0].subject.document.boundary_json);
  firstBoundary.authentication_prerequisite_sha256 = await fileDigest('contracts/codex-intelligence-adapter/authentication-prerequisite.json');
  firstBoundary.capability_proof_sha256 = await fileDigest('contracts/codex-intelligence-adapter/capability-proof.json');
  firstBoundary.network_proof_sha256 = await fileDigest('contracts/codex-intelligence-adapter/network-proof.json');
  await writeJson('contracts/codex-intelligence-adapter/boundary.json', firstBoundary);
  return {entries, fixtures, records};
}

async function writeMachineEvidence(entries, fixtures) {
  const fixtureBindings = await Promise.all(entries.map(async (entry, index) => {
    const receipt = JSON.parse(fixtures[index].expected.receipts[0]);
    return {
      fixture_id: entry.fixture_id, path: `conformance/${entry.path}`,
      fixture_sha256: await fileDigest(`conformance/${entry.path}`), receipt_sha256: receipt.receipt_sha256,
      verdict: fixtures[index].expected.verdict,
    };
  }));
  await writeJson('conformance/evidence/codex-adapter-evidence.json', {
    $schema: '../../contracts/schemas/codex-adapter-evidence.schema.json', schema_id: 'mdplace.codex-adapter-evidence/v1',
    evidence_id: 'codex-adapter-evidence:v1', profile_id: 'codex-adapter', validator_version: '1.2.0',
    fixture_bindings: fixtureBindings, receipt_sha256s: fixtureBindings.map(({receipt_sha256}) => receipt_sha256),
    boundary_sha256: await fileDigest('contracts/codex-intelligence-adapter/boundary.json'),
    authentication_prerequisite_sha256: await fileDigest('contracts/codex-intelligence-adapter/authentication-prerequisite.json'),
    capability_proof_sha256: await fileDigest('contracts/codex-intelligence-adapter/capability-proof.json'),
    network_proof_sha256: await fileDigest('contracts/codex-intelligence-adapter/network-proof.json'),
    fixture_manifest_sha256: await fileDigest('contracts/codex-intelligence-adapter/fixture-manifest.json'),
    network_operations: 0, intake_fixtures: 0, stateful_scenarios: 0, verdict: 'pass',
  });
  return fixtureBindings;
}

async function writeClaim(entries) {
  const paths = [...codexAdapterEvidencePaths, ...entries.map(({path}) => `conformance/${path}`)];
  const material = await Promise.all(paths.map(async (path, ordinal) => ({
    ordinal, label: `codex_material_${String(ordinal + 1).padStart(3, '0')}`, path, sha256: await fileDigest(path),
  })));
  const claim = {
    $schema: '../schemas/codex-adapter-claim-manifest.schema.json', schema_id: 'mdplace.codex-adapter-claim-manifest/v1',
    manifest_id: 'codex-adapter-claim:v1', package_series: 'mdplace-spec/v1', release_version: '1.0.0',
    validator_id: 'mdplace.package-validator', validator_version: '1.2.0',
    rows: [{
      id: 'codex-adapter', owner: 'codex-adapter', verdict: 'pass', evidence_digest: codexAdapterEvidenceDigest(material),
      evidence_material: material,
      dependencies_elevated: {core: false, product_readiness: false, local_adapter: false, remote_adapter: false, placement_automation: false, other_profiles: false},
    }],
  };
  await writeJson('contracts/codex-intelligence-adapter/claim-manifest.json', claim);
  return claim;
}

async function writeRecoveryReport(claim, records) {
  await writeJson('conformance/evidence/codex-adapter-recovery-report.json', {
    $schema: '../../contracts/schemas/codex-adapter-recovery-report.schema.json', schema_id: 'mdplace.codex-adapter-recovery-report/v1',
    report_id: 'codex-adapter-recovery:v1', profile_id: 'codex-adapter',
    claim_manifest_sha256: await fileDigest('contracts/codex-intelligence-adapter/claim-manifest.json'),
    evidence_digest: claim.rows[0].evidence_digest, parsed_artifacts_revalidated: true,
    cases: [...records.values()], network_operations: 0, verdict: 'pass',
  });
}

function traceRecord(requirement, positiveIds, negativeIds) {
  return {
    requirement_id: requirement.id, decision_ids: codexDecisionIds, canonical_terms: requirement.canonical_terms,
    normative_anchors: [requirement.normative_anchor],
    schema_or_transition_refs: [
      'contracts/schemas/codex-adapter-boundary.schema.json', 'contracts/schemas/codex-capability-proof.schema.json',
      'contracts/schemas/codex-network-proof.schema.json', 'contracts/schemas/codex-adapter-proposal.schema.json',
      'contracts/schemas/codex-adapter-denial.schema.json', 'contracts/schemas/codex-adapter-receipt.schema.json',
      'contracts/transitions/codex-adapter-capability-proof-lifecycle.json', 'contracts/transitions/codex-adapter-network-proof-lifecycle.json',
      'contracts/transitions/codex-adapter-authentication-prerequisite-lifecycle.json', 'contracts/transitions/codex-adapter-proposal-validation-lifecycle.json',
      'contracts/transitions/codex-adapter-denial-lifecycle.json', 'contracts/transitions/codex-adapter-failure-lifecycle.json',
      'contracts/transitions/codex-adapter-recovery-lifecycle.json',
    ],
    positive_fixture_ids: positiveIds, negative_fixture_ids: negativeIds,
    acceptance_gate: requirement.acceptance_gate, scope: requirement.scope,
    evidence_refs: ['conformance/evidence/codex-adapter-evidence.json', 'conformance/evidence/codex-adapter-recovery-report.json'],
  };
}

async function updateCatalogs(entries, fixtures) {
  const requirements = await readJson('normative/requirements.json');
  requirements.requirements = [...requirements.requirements.filter(({id}) => !id.startsWith('REQ-CODEX-')), ...codexAdapterRequirements];
  await writeJson('normative/requirements.json', requirements);
  const manifest = await readJson('conformance/manifest.yaml');
  manifest.fixtures = [...manifest.fixtures.filter(({fixture_id: id}) => !id.startsWith('FIX-CODEX-PROFILE-')),
    ...entries.map((entry, index) => ({
      ...entry, expected_verdict: fixtures[index].expected.verdict,
      observable_assertions: {inputs: true, outputs: true, operations: true, receipts: true, filesystem_effects: true, terminal_state: true, illegal_transition: fixtures[index].expected.illegal_transition},
    }))];
  await writeJson('conformance/manifest.yaml', manifest);
  const traceability = await readJson('traceability.yaml');
  traceability.decisions = [
    ...traceability.decisions.filter(({decision_id: id}) => id !== 'DEC-011'),
    {decision_id: 'DEC-011', url: codexDecisionInputs[0], status: 'accepted', use: 'input_without_reopening'},
  ];
  const positiveIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'pass').map(({fixture_id: id}) => id);
  const negativeIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'fail').map(({fixture_id: id}) => id);
  traceability.records = [...traceability.records.filter(({requirement_id: id}) => !id.startsWith('REQ-CODEX-')),
    ...codexAdapterRequirements.map((requirement) => traceRecord(requirement, positiveIds, negativeIds))];
  await writeJson('traceability.yaml', traceability);
  const registry = await readJson('contracts/validator-extensions.json');
  const extension = registry.extensions.find(({extension_id: id}) => id === 'mdplace.validator-extension/evidence/v1');
  if (!extension.subject_schemas.includes('contracts/schemas/codex-adapter-claim-manifest.schema.json')) {
    extension.subject_schemas.push('contracts/schemas/codex-adapter-claim-manifest.schema.json');
  }
  await writeJson('contracts/validator-extensions.json', registry);
}

async function writeClaimEnvelope() {
  const claimPath = 'contracts/codex-intelligence-adapter/claim-manifest.json';
  const claim = await readJson(claimPath);
  const subject = {kind: 'codex_adapter_claim', subject_id: 'codex-adapter:claim-v1', schema: 'contracts/schemas/codex-adapter-claim-manifest.schema.json', sha256: await fileDigest(claimPath)};
  const inputs = await Promise.all([
    ['requirements', 'normative/requirements.json'], ['boundary', 'contracts/codex-intelligence-adapter/boundary.json'],
    ['authentication', 'contracts/codex-intelligence-adapter/authentication-prerequisite.json'], ['capability', 'contracts/codex-intelligence-adapter/capability-proof.json'],
    ['network', 'contracts/codex-intelligence-adapter/network-proof.json'], ['fixture_manifest', 'contracts/codex-intelligence-adapter/fixture-manifest.json'],
  ].map(async ([label, path], ordinal) => ({ordinal, label, path, sha256: await fileDigest(path)})));
  const invocationPath = 'conformance/evidence/invocations/codex-adapter-profile.json';
  const invocation = {
    $schema: '../../../contracts/schemas/validator-invocation.schema.json', schema_id: 'mdplace.validator-invocation/v1',
    extension_id: 'mdplace.validator-extension/evidence/v1', invocation_id: 'invocation:codex-adapter-profile',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0', validator_id: 'mdplace.package-validator', validator_version: '1.2.0',
    subject: {...subject, path: claimPath}, requirement_ids: codexAdapterRequirementIds, input_digests: inputs,
    execution_context: {runner_id: 'mdplace.package-validator', platform: 'platform_neutral', architecture: 'architecture_neutral', filesystem: 'package_fixture', locale: 'C.UTF-8', timezone: 'UTC', network_access: 'denied'},
  };
  await writeJson(invocationPath, invocation);
  const evidencePath = 'conformance/evidence/envelopes/codex-adapter-profile.json';
  const recoveryPath = 'conformance/evidence/codex-adapter-recovery-report.json';
  await writeJson(evidencePath, {
    $schema: '../../../contracts/schemas/evidence-envelope.schema.json', schema_id: 'mdplace.evidence-envelope/v1',
    envelope_id: 'evidence:codex-adapter-profile', extension_id: invocation.extension_id,
    package_series: invocation.package_series, release_version: invocation.release_version, validator_id: invocation.validator_id, validator_version: invocation.validator_version,
    invocation: {invocation_id: invocation.invocation_id, path: invocationPath, sha256: await fileDigest(invocationPath)},
    requirement_id: 'REQ-CODEX-006', subject, input_digests: inputs,
    output_digests: [
      {ordinal: 0, label: 'codex_adapter_evidence', path: 'conformance/evidence/codex-adapter-evidence.json', sha256: await fileDigest('conformance/evidence/codex-adapter-evidence.json')},
      {ordinal: 1, label: 'recovery_report', path: recoveryPath, sha256: await fileDigest(recoveryPath)},
    ],
    receipts: [{ordinal: 0, receipt_id: 'receipt:codex-adapter-profile', receipt_type: 'EvidenceValidationReceipt', path: recoveryPath, sha256: await fileDigest(recoveryPath)}],
    artifact_digests: [
      {ordinal: 0, label: 'profile', path: 'contracts/codex-intelligence-adapter/profile.json', sha256: await fileDigest('contracts/codex-intelligence-adapter/profile.json')},
      {ordinal: 1, label: 'normative_contract', path: 'normative/codex-intelligence-adapter-profile.md', sha256: await fileDigest('normative/codex-intelligence-adapter-profile.md')},
    ],
    execution_context: invocation.execution_context, verdict: claim.rows[0].verdict, codes: [],
  });
  const generic = await readJson('conformance/claim-manifests/codex-intelligence-adapter.json');
  Object.assign(generic, {
    subject: {kind: subject.kind, subject_id: subject.subject_id, sha256: subject.sha256}, requirement_id: 'REQ-CODEX-006',
    evidence_requirements: [{evidence_kind: 'codex_adapter_conformance', mandatory: true}],
    evidence_bindings: [{evidence_kind: 'codex_adapter_conformance', mandatory: true, availability: 'present', applicability: 'applicable', evidence_ref: evidencePath, evidence_digest: await fileDigest(evidencePath), verdict: claim.rows[0].verdict}],
    applicability: 'applicable', verdict: claim.rows[0].verdict,
  });
  await writeJson('conformance/claim-manifests/codex-intelligence-adapter.json', generic);
  const index = await readJson('claims-and-evidence.yaml');
  index.claims.find(({profile}) => profile === 'codex_intelligence_adapter').sha256 = await fileDigest('conformance/claim-manifests/codex-intelligence-adapter.json');
  await writeJson('claims-and-evidence.yaml', index);
}

await writeSchemasAndContracts();
const generated = await writeFixtures();
await writeMachineEvidence(generated.entries, generated.fixtures);
const claim = await writeClaim(generated.entries);
await writeRecoveryReport(claim, generated.records);
await updateCatalogs(generated.entries, generated.fixtures);
await import('./generate-remote-adapter-artifacts.mjs?codex-dependencies');
await writeClaimEnvelope();
await import('./generate-intelligence-adapter-artifacts.mjs?codex-final');
process.stdout.write(`generated ${generated.entries.length} Codex Intelligence Adapter fixtures under ${packageRoot}\n`);
