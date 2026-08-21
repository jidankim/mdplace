import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  localAdapterProfile,
  localAdapterRequirements,
  localAdapterTransitionTables,
  localAdapterVerdicts,
} from './local-adapter-contracts.mjs';
import {
  localAdapterEvidenceDigest,
  localAdapterEvidencePaths,
  localAdapterRequirementIds,
  sha256,
} from './local-adapter-core.mjs';
import {localAdapterCases, localAdapterScenario} from './local-adapter-fixtures.mjs';
import {localAdapterRecoveryValidation} from './local-adapter-evidence-validation.mjs';
import {observeLocalAdapterScenario} from './local-adapter-observer.mjs';
import {
  authoredRecoveryRecord,
  currentClaimBinding,
} from './local-adapter-recovery-authoring.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relativeFixturePath = (caseId) => `scenarios/local-intelligence-adapter/${caseId}.json`;
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
  return sha256(await readFile(resolve(packageRoot, path)));
}

async function writeProfileEvidence() {
  await writeJson('contracts/local-intelligence-adapter/profile.json', localAdapterProfile);
  const profileSha256 = await fileDigest('contracts/local-intelligence-adapter/profile.json');
  await writeJson('contracts/local-intelligence-adapter/capability-evidence.json', {
    $schema: '../schemas/local-adapter-capability-evidence.schema.json',
    schema_id: 'mdplace.local-adapter-capability-evidence/v1', profile_id: 'local-adapter',
    evidence_id: 'local-capability-evidence:v1', status: 'current', profile_sha256: profileSha256,
    observed_capabilities: ['emit_schema_validated_proposal', 'emit_schema_validated_receipt'],
    denied_capabilities: ['semantic', 'note_placement', 'taxonomy', 'projection', 'filesystem', 'network', 'tool', 'automation'],
    ceilings: {input_bytes: 4096, output_bytes: 3000, runtime_ms: 800, attempts: 2},
    observed_at: '2026-08-21T00:00:00.000Z', expires_at: '2026-09-20T00:00:00.000Z',
  });
  await writeJson('contracts/local-intelligence-adapter/isolation-evidence.json', {
    $schema: '../schemas/local-adapter-isolation-evidence.schema.json',
    schema_id: 'mdplace.local-adapter-isolation-evidence/v1', profile_id: 'local-adapter',
    evidence_id: 'local-isolation-evidence:v1', status: 'current', profile_sha256: profileSha256,
    ephemeral: true, fresh_process: true, advisory_only: true, prompt_injection_inert: true,
    filesystem: 'none', network: 'denied', tools: 'none', ambient_configuration: 'unreadable',
    credentials: 'none', semantic_writer: 'unreachable', observed_at: '2026-08-21T00:00:00.000Z',
    expires_at: '2026-09-20T00:00:00.000Z',
  });
  await writeJson('contracts/verdicts/local-adapter-verdicts.json', localAdapterVerdicts);
  for (const {path, document} of localAdapterTransitionTables()) await writeJson(path, document);
}

async function writeFixtures() {
  const evidence = {
    capability: await readJson('contracts/local-intelligence-adapter/capability-evidence.json'),
    isolation: await readJson('contracts/local-intelligence-adapter/isolation-evidence.json'),
  };
  const claimBinding = await currentClaimBinding(packageRoot);
  const entries = localAdapterCases.map(([caseId, category], index) => ({
    fixture_id: `FIX-LIA-PROFILE-${String(index + 1).padStart(3, '0')}`,
    path: relativeFixturePath(caseId), category, requirement_ids: localAdapterRequirementIds,
  }));
  const fixtureManifest = {
    $schema: '../schemas/local-adapter-fixture-manifest.schema.json',
    schema_id: 'mdplace.local-adapter-fixture-manifest/v1', manifest_id: 'local-adapter-fixtures:v1',
    profile_id: 'local-adapter', requirements: localAdapterRequirementIds, fixtures: entries,
  };
  const fixtures = await Promise.all(localAdapterCases.map(async (definition, index) => {
    const [caseId, category] = definition;
    const scenario = localAdapterScenario(index, definition, evidence);
    const recoveryRecord = authoredRecoveryRecord(definition, scenario, claimBinding);
    const expected = await observeLocalAdapterScenario(scenario, packageRoot, recoveryRecord);
    return {
      $schema: '../../../contracts/schemas/conformance-fixture.schema.json',
      schema_id: 'mdplace.conformance-fixture/v1', fixture_id: entries[index].fixture_id,
      category, requirement_ids: localAdapterRequirementIds,
      subject: {kind: 'local_intelligence_adapter', schema: 'contracts/schemas/local-adapter-scenario.schema.json', document: scenario},
      expected,
    };
  }));
  await writeJson('contracts/local-intelligence-adapter/fixture-manifest.json', fixtureManifest);
  for (const [index, fixture] of fixtures.entries()) {
    await writeJson(packageFixturePath(localAdapterCases[index][0]), fixture);
  }
  return {entries, fixtures};
}

async function writeMachineEvidence(entries, fixtures) {
  const fixtureBindings = await Promise.all(entries.map(async (entry, index) => {
    const receipt = JSON.parse(fixtures[index].expected.receipts[0]);
    return {
      fixture_id: entry.fixture_id, path: `conformance/${entry.path}`,
      fixture_sha256: await fileDigest(`conformance/${entry.path}`),
      receipt_sha256: receipt.receipt_sha256, verdict: fixtures[index].expected.verdict,
    };
  }));
  const evidence = {
    $schema: '../../contracts/schemas/local-adapter-evidence.schema.json',
    schema_id: 'mdplace.local-adapter-evidence/v1', evidence_id: 'local-adapter-evidence:v1',
    profile_id: 'local-adapter', validator_version: '1.2.0', fixture_bindings: fixtureBindings,
    receipt_sha256s: fixtureBindings.map(({receipt_sha256: digest}) => digest),
    capability_evidence_sha256: await fileDigest('contracts/local-intelligence-adapter/capability-evidence.json'),
    isolation_evidence_sha256: await fileDigest('contracts/local-intelligence-adapter/isolation-evidence.json'),
    fixture_manifest_sha256: await fileDigest('contracts/local-intelligence-adapter/fixture-manifest.json'),
    verdict: 'pass',
  };
  await writeJson('conformance/evidence/local-adapter-evidence.json', evidence);
  const materialPaths = [...localAdapterEvidencePaths, ...entries.map(({path}) => `conformance/${path}`)];
  const material = await Promise.all(materialPaths.map(async (path, ordinal) => ({
    ordinal, label: `local_material_${String(ordinal + 1).padStart(3, '0')}`, path, sha256: await fileDigest(path),
  })));
  const evidenceDigest = localAdapterEvidenceDigest(material);
  const claim = {
    $schema: '../schemas/local-adapter-claim-manifest.schema.json',
    schema_id: 'mdplace.local-adapter-claim-manifest/v1', manifest_id: 'local-adapter-claim:v1',
    package_series: 'mdplace-spec/v1', release_version: '1.0.0',
    validator_id: 'mdplace.package-validator', validator_version: '1.2.0',
    rows: [{
      id: 'local-adapter', owner: 'local-adapter', verdict: 'pass', evidence_digest: evidenceDigest,
      evidence_material: material,
      dependencies_elevated: {core: false, product_readiness: false, remote_adapter: false, codex_adapter: false, placement_automation: false},
    }],
  };
  await writeJson('contracts/local-intelligence-adapter/claim-manifest.json', claim);
  const claimBinding = await currentClaimBinding(packageRoot);
  const recoveryCases = (await Promise.all(fixtureBindings.map(async (binding, index) => {
    const fixture = fixtures[index];
    if (fixture.subject.document.operation !== 'recover') return null;
    const recoveryRecord = authoredRecoveryRecord(
      localAdapterCases[index],
      fixture.subject.document,
      claimBinding,
    );
    const validation = await localAdapterRecoveryValidation(
      recoveryRecord,
      fixture.subject.document,
      packageRoot,
    );
    return {
      fixture_id: binding.fixture_id,
      ...recoveryRecord,
      attempt_revalidated: validation.attemptRevalidated,
      claim_digest_revalidated: validation.claimDigestRevalidated,
      parsed_evidence_revalidated: validation.parsedEvidenceRevalidated,
      terminal_state: fixture.expected.terminal_state,
      receipt_sha256: binding.receipt_sha256,
    };
  }))).filter(Boolean);
  await writeJson('conformance/evidence/local-adapter-recovery-report.json', {
    $schema: '../../contracts/schemas/local-adapter-recovery-report.schema.json',
    schema_id: 'mdplace.local-adapter-recovery-report/v1', report_id: 'local-adapter-recovery:v1',
    profile_id: 'local-adapter', claim_manifest_sha256: await fileDigest('contracts/local-intelligence-adapter/claim-manifest.json'),
    evidence_digest: evidenceDigest, parsed_artifacts_revalidated: true, cases: recoveryCases, verdict: 'pass',
  });
  return claim;
}

function traceRecord(requirement, positiveIds, negativeIds) {
  return {
    requirement_id: requirement.id, decision_ids: ['DEC-008'],
    canonical_terms: requirement.canonical_terms, normative_anchors: [requirement.normative_anchor],
    schema_or_transition_refs: [
      'contracts/schemas/local-intelligence-adapter-profile.schema.json',
      'contracts/schemas/local-adapter-claim-manifest.schema.json',
      'contracts/schemas/local-adapter-scenario.schema.json',
      'contracts/schemas/local-adapter-attempt-observation.schema.json',
      'contracts/schemas/adapter-run-receipt.schema.json',
      'contracts/transitions/local-adapter-capability-lifecycle.json',
      'contracts/transitions/local-adapter-isolation-lifecycle.json',
      'contracts/transitions/local-adapter-verdict-lifecycle.json',
      'contracts/transitions/local-adapter-failure-lifecycle.json',
      'contracts/transitions/local-adapter-recovery-lifecycle.json',
    ],
    positive_fixture_ids: positiveIds, negative_fixture_ids: negativeIds,
    acceptance_gate: requirement.acceptance_gate, scope: requirement.scope,
    evidence_refs: ['conformance/evidence/local-adapter-evidence.json', 'conformance/evidence/local-adapter-recovery-report.json'],
  };
}

async function updateCatalogs(entries, fixtures) {
  const requirements = await readJson('normative/requirements.json');
  requirements.requirements = [...requirements.requirements.filter(({id}) => !id.startsWith('REQ-LIA-')), ...localAdapterRequirements];
  await writeJson('normative/requirements.json', requirements);
  const manifest = await readJson('conformance/manifest.yaml');
  manifest.fixtures = [...manifest.fixtures.filter(({fixture_id: id}) => !id.startsWith('FIX-LIA-PROFILE-')),
    ...entries.map((entry, index) => ({
      ...entry, expected_verdict: fixtures[index].expected.verdict,
      observable_assertions: {inputs: true, outputs: true, operations: true, receipts: true, filesystem_effects: true, terminal_state: true, illegal_transition: fixtures[index].expected.illegal_transition},
    }))];
  await writeJson('conformance/manifest.yaml', manifest);
  const traceability = await readJson('traceability.yaml');
  if (!traceability.decisions.some(({decision_id: id}) => id === 'DEC-008')) throw new Error('DEC-008 is required');
  const positiveIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'pass').map(({fixture_id: id}) => id);
  const negativeIds = entries.filter((_, index) => fixtures[index].expected.verdict === 'fail').map(({fixture_id: id}) => id);
  traceability.records = [...traceability.records.filter(({requirement_id: id}) => !id.startsWith('REQ-LIA-')),
    ...localAdapterRequirements.map((requirement) => traceRecord(requirement, positiveIds, negativeIds))];
  await writeJson('traceability.yaml', traceability);
}

async function writeClaimEnvelope(claim) {
  const claimPath = 'contracts/local-intelligence-adapter/claim-manifest.json';
  const subject = {kind: 'local_adapter_claim', subject_id: 'local-adapter:claim-v1', schema: 'contracts/schemas/local-adapter-claim-manifest.schema.json', sha256: await fileDigest(claimPath)};
  const inputs = await Promise.all([
    ['requirements', 'normative/requirements.json'], ['capability', 'contracts/local-intelligence-adapter/capability-evidence.json'],
    ['isolation', 'contracts/local-intelligence-adapter/isolation-evidence.json'], ['fixture_manifest', 'contracts/local-intelligence-adapter/fixture-manifest.json'],
  ].map(async ([label, path], ordinal) => ({ordinal, label, path, sha256: await fileDigest(path)})));
  const invocationPath = 'conformance/evidence/invocations/local-adapter-profile.json';
  const invocation = {$schema: '../../../contracts/schemas/validator-invocation.schema.json', schema_id: 'mdplace.validator-invocation/v1', extension_id: 'mdplace.validator-extension/evidence/v1', invocation_id: 'invocation:local-adapter-profile', package_series: 'mdplace-spec/v1', release_version: '1.0.0', validator_id: 'mdplace.package-validator', validator_version: '1.2.0', subject: {...subject, path: claimPath}, requirement_ids: localAdapterRequirementIds, input_digests: inputs, execution_context: {runner_id: 'mdplace.package-validator', platform: 'platform_neutral', architecture: 'architecture_neutral', filesystem: 'package_fixture', locale: 'C.UTF-8', timezone: 'UTC', network_access: 'denied'}};
  await writeJson(invocationPath, invocation);
  const evidencePath = 'conformance/evidence/envelopes/local-adapter-profile.json';
  const recoveryPath = 'conformance/evidence/local-adapter-recovery-report.json';
  const envelope = {$schema: '../../../contracts/schemas/evidence-envelope.schema.json', schema_id: 'mdplace.evidence-envelope/v1', envelope_id: 'evidence:local-adapter-profile', extension_id: invocation.extension_id, package_series: invocation.package_series, release_version: invocation.release_version, validator_id: invocation.validator_id, validator_version: invocation.validator_version, invocation: {invocation_id: invocation.invocation_id, path: invocationPath, sha256: await fileDigest(invocationPath)}, requirement_id: 'REQ-LIA-007', subject, input_digests: inputs, output_digests: [{ordinal: 0, label: 'local_adapter_evidence', path: 'conformance/evidence/local-adapter-evidence.json', sha256: await fileDigest('conformance/evidence/local-adapter-evidence.json')}, {ordinal: 1, label: 'recovery_report', path: recoveryPath, sha256: await fileDigest(recoveryPath)}], receipts: [{ordinal: 0, receipt_id: 'receipt:local-adapter-profile', receipt_type: 'EvidenceValidationReceipt', path: recoveryPath, sha256: await fileDigest(recoveryPath)}], artifact_digests: [{ordinal: 0, label: 'profile', path: 'contracts/local-intelligence-adapter/profile.json', sha256: await fileDigest('contracts/local-intelligence-adapter/profile.json')}, {ordinal: 1, label: 'normative_contract', path: 'normative/local-intelligence-adapter-profile.md', sha256: await fileDigest('normative/local-intelligence-adapter-profile.md')}], execution_context: invocation.execution_context, verdict: 'pass', codes: []};
  await writeJson(evidencePath, envelope);
  const genericClaim = await readJson('conformance/claim-manifests/local-intelligence-adapter.json');
  Object.assign(genericClaim, {subject: {kind: subject.kind, subject_id: subject.subject_id, sha256: subject.sha256}, requirement_id: 'REQ-LIA-007', evidence_requirements: [{evidence_kind: 'local_adapter_conformance', mandatory: true}], evidence_bindings: [{evidence_kind: 'local_adapter_conformance', mandatory: true, availability: 'present', applicability: 'applicable', evidence_ref: evidencePath, evidence_digest: await fileDigest(evidencePath), verdict: 'pass'}], applicability: 'applicable', verdict: 'pass'});
  await writeJson('conformance/claim-manifests/local-intelligence-adapter.json', genericClaim);
  const index = await readJson('claims-and-evidence.yaml');
  index.claims.find(({profile}) => profile === 'local_intelligence_adapter').sha256 = await fileDigest('conformance/claim-manifests/local-intelligence-adapter.json');
  await writeJson('claims-and-evidence.yaml', index);
  return claim;
}

await writeProfileEvidence();
const initial = await writeFixtures();
await writeMachineEvidence(initial.entries, initial.fixtures);
const {entries, fixtures} = await writeFixtures();
const claim = await writeMachineEvidence(entries, fixtures);
await updateCatalogs(entries, fixtures);
await writeClaimEnvelope(claim);
await import('./generate-intelligence-adapter-artifacts.mjs');
process.stdout.write(`generated ${entries.length} Local Intelligence Adapter fixtures under ${packageRoot}\n`);
