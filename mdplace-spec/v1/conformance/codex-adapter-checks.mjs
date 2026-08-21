import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {
  codexAdapterCategories,
  codexAdapterEvidenceDigest,
  codexAdapterReceiptDigest,
  codexAdapterRequirementIds,
  codexDecisionIds,
  codexDecisionInputs,
  codexReceiptMatchesScenario,
  codexSha256,
} from './codex-adapter-core.mjs';
import {codexAdapterCases} from './codex-adapter-fixtures.mjs';
import {observeCodexAdapterScenario} from './codex-adapter-observer.mjs';
import {readPackageFile} from './safe-path.mjs';
function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'codex-intelligence-adapter-profile', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}
async function readJson(packageRoot, path) {
  const read = await readPackageFile(packageRoot, path);
  if (read.status !== 'present') return {read, document: null};
  try {
    return {read, document: JSON.parse(read.content.toString('utf8'))};
  } catch {
    return {read, document: null};
  }
}
async function validateDocument(packageRoot, path, schema, codes) {
  const value = await readJson(packageRoot, path);
  if (value.document === null) {
    codes.push(value.read.status === 'present' ? 'boundary.invalid_json' : 'schema.instance_missing');
    return value;
  }
  try {
    const code = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schema, value.document));
    if (code !== null) codes.push(code);
  } catch {
    codes.push('schema.instance_missing');
  }
  return value;
}
function completeReachableTable(document) {
  const pairs = document.states.flatMap((state) => document.commands.map((command) => `${state}:${command}`));
  const rows = document.transitions.map(({from_state: state, command_or_event: command}) => `${state}:${command}`);
  if (!isDeepStrictEqual(rows, pairs) || new Set(rows).size !== pairs.length) return false;
  const reachable = new Set([document.states[0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of document.transitions) {
      if (row.allowed && reachable.has(row.from_state) && !reachable.has(row.terminal_state)) {
        reachable.add(row.terminal_state);
        changed = true;
      }
    }
  }
  return document.states.every((state) => reachable.has(state));
}
async function materialCodes(row, packageRoot) {
  const codes = [];
  const material = Array.isArray(row?.evidence_material) ? row.evidence_material : [];
  if (material.length === 0 || !isDeepStrictEqual(material.map(({ordinal}) => ordinal), material.map((_, index) => index))) {
    return ['codex.claim_material_invalid'];
  }
  for (const entry of material) {
    const read = await readPackageFile(packageRoot, entry.path);
    if (read.status !== 'present' || codexSha256(read.content) !== entry.sha256) codes.push('codex.claim_material_digest_mismatch');
  }
  if (row.evidence_digest !== codexAdapterEvidenceDigest(material)) codes.push('codex.claim_evidence_digest_mismatch');
  return codes;
}
export async function codexAdapterClaimCodes(claim, packageRoot) {
  const rows = Array.isArray(claim?.rows) ? claim.rows : [];
  if (rows.length !== 1 || rows[0]?.id !== 'codex-adapter' || rows[0]?.owner !== 'codex-adapter') {
    return ['codex.claim_isolation_invalid'];
  }
  const row = rows[0];
  const codes = await materialCodes(row, packageRoot);
  if (row.verdict !== 'pass' || Object.values(row.dependencies_elevated ?? {}).some((value) => value !== false)) {
    codes.push('codex.claim_verdict_invalid');
  }
  return codes;
}
function exactProfile(profile) {
  return profile?.profile_id === 'codex-adapter' && profile.owner === 'codex-adapter' &&
    profile.interface?.command === 'codex' && profile.interface?.subcommand === 'exec' &&
    profile.interface?.approved_cli_version === '0.104.0' && profile.interface?.mode === 'non_interactive' &&
    profile.interface?.invocation_contract_ref === 'contracts/codex-intelligence-adapter/invocation-contract.json' &&
    profile.interface?.output_schema_ref === 'contracts/schemas/codex-adapter-proposal.schema.json' &&
    profile.exact_destination === 'https://codex.openai.test/v1/execute' &&
    isDeepStrictEqual(profile.decision_inputs, codexDecisionInputs) &&
    Object.values(profile.authority ?? {}).every((value) => value === 'none') &&
    profile.specification_only === true && profile.live_codex_behavior_asserted === false && profile.network_operation_performed === false;
}
function exactProofs(boundary, invocation, authentication, capability, network, digests) {
  return boundary?.status === 'current' && boundary.interface?.mode === 'non_interactive' &&
    boundary.interface?.invocation_contract_ref === 'contracts/codex-intelligence-adapter/invocation-contract.json' &&
    boundary.interface?.output_schema_ref === 'contracts/schemas/codex-adapter-proposal.schema.json' &&
    boundary.invocation_contract_sha256 === digests.invocation && boundary.output_schema_sha256 === digests.outputSchema &&
    invocation?.output?.schema_ref === 'contracts/schemas/codex-adapter-proposal.schema.json' &&
    invocation.output.schema_sha256 === digests.outputSchema &&
    boundary.approved_processing_envelope_ref === 'contracts/codex-intelligence-adapter/approved-processing-envelope.json' &&
    boundary.approved_processing_envelope_sha256 === digests.approvedEnvelope &&
    authentication?.status === 'current' && authentication.satisfied === true && authentication.opaque === true &&
    authentication.secret_observed === false && authentication.claims_established.length === 0 &&
    capability?.status === 'current' && capability.proof_result === 'exact' && capability.inventories.model_visible_tools.length === 0 &&
    capability.disabled_capability_features.length === 12 &&
    network?.status === 'current' && network.proof_result === 'exact' &&
    network.allowed_destination === 'https://codex.openai.test/v1/execute' && network.unauthorized_destination_bytes === 0;
}
function exactVerdicts(document) {
  return isDeepStrictEqual(document?.precedence, ['fail', 'unsupported', 'inconclusive', 'pass']) &&
    isDeepStrictEqual(document?.rows?.map(({verdict}) => verdict), ['pass', 'fail', 'unsupported', 'inconclusive']) &&
    document.rows[0].claim_effect === 'eligible_pass' && document.rows.slice(1).every(({claim_effect: effect}) => effect === 'deny_pass');
}
function observedDenial(observed) {
  for (const value of observed.observations) {
    try {
      const document = typeof value === 'string' ? JSON.parse(value) : value;
      if (document?.schema_id === 'mdplace.codex-adapter-denial/v1') return document;
    } catch {
      continue;
    }
  }
  return null;
}
export async function checkCodexAdapterProfile(packageRoot, conformance, traceability) {
  const codes = [];
  const bindings = [
    ['contracts/codex-intelligence-adapter/profile.json', 'contracts/schemas/codex-intelligence-adapter-profile.schema.json'],
    ['contracts/codex-intelligence-adapter/boundary.json', 'contracts/schemas/codex-adapter-boundary.schema.json'],
    ['contracts/codex-intelligence-adapter/invocation-contract.json', 'contracts/schemas/codex-invocation-contract.schema.json'],
    ['contracts/codex-intelligence-adapter/authentication-prerequisite.json', 'contracts/schemas/codex-authentication-prerequisite.schema.json'],
    ['contracts/codex-intelligence-adapter/capability-proof.json', 'contracts/schemas/codex-capability-proof.schema.json'],
    ['contracts/codex-intelligence-adapter/network-proof.json', 'contracts/schemas/codex-network-proof.schema.json'],
    ['contracts/codex-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/codex-adapter-fixture-manifest.schema.json'],
    ['contracts/codex-intelligence-adapter/claim-manifest.json', 'contracts/schemas/codex-adapter-claim-manifest.schema.json'],
    ['contracts/verdicts/codex-adapter-verdicts.json', 'contracts/schemas/codex-adapter-verdict-table.schema.json'],
    ['conformance/evidence/codex-adapter-evidence.json', 'contracts/schemas/codex-adapter-evidence.schema.json'],
    ['conformance/evidence/codex-adapter-recovery-report.json', 'contracts/schemas/codex-adapter-recovery-report.schema.json'],
  ];
  const documents = await Promise.all(bindings.map(([path, schema]) => validateDocument(packageRoot, path, schema, codes)));
  if (documents.some(({document}) => document === null)) return result(codes);
  const [profile, boundary, invocation, authentication, capability, network, fixtureManifest, claim, verdicts, evidence, recovery] = documents.map(({document}) => document);
  const outputSchema = await readPackageFile(packageRoot, 'contracts/schemas/codex-adapter-proposal.schema.json');
  const approvedEnvelope = await validateDocument(
    packageRoot,
    'contracts/codex-intelligence-adapter/approved-processing-envelope.json',
    'contracts/schemas/processing-envelope.schema.json',
    codes,
  );
  const protocol = await validateDocument(packageRoot, 'contracts/intelligence-adapter/protocol-rules.json', 'contracts/schemas/intelligence-adapter-protocol-rules.schema.json', codes);
  if (approvedEnvelope.document === null || outputSchema.status !== 'present') codes.push('codex.profile_boundary_invalid');
  if (!exactProfile(profile)) codes.push('codex.profile_boundary_invalid');
  if (!isDeepStrictEqual(boundary.interface, profile.interface)) codes.push('codex.profile_boundary_invalid');
  if (!exactProofs(boundary, invocation, authentication, capability, network, {
    approvedEnvelope: approvedEnvelope.read.status === 'present' ? codexSha256(approvedEnvelope.read.content) : null,
    invocation: codexSha256(documents[2].read.content),
    outputSchema: outputSchema.status === 'present' ? codexSha256(outputSchema.content) : null,
  })) codes.push('codex.proof_boundary_invalid');
  if (boundary.authentication_prerequisite_sha256 !== codexSha256(documents[3].read.content) ||
      boundary.capability_proof_sha256 !== codexSha256(documents[4].read.content) ||
      boundary.network_proof_sha256 !== codexSha256(documents[5].read.content)) codes.push('codex.boundary_proof_binding_invalid');
  if (!exactVerdicts(verdicts)) codes.push('codex.verdict_table_invalid');
  const transitionNames = ['capability-proof', 'network-proof', 'authentication-prerequisite', 'proposal-validation', 'denial', 'failure', 'recovery'];
  const transitions = await Promise.all(transitionNames.map((name) => validateDocument(
    packageRoot, `contracts/transitions/codex-adapter-${name}-lifecycle.json`, 'contracts/schemas/transition-table.schema.json', codes,
  )));
  if (transitions.some(({document}) => document === null || !completeReachableTable(document))) codes.push('codex.transition_tables_incomplete');
  codes.push(...await codexAdapterClaimCodes(claim, packageRoot));

  const declared = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const owned = declared.filter(({fixture_id: id, path}) => id?.startsWith('FIX-CODEX-PROFILE-') || path?.startsWith('scenarios/codex-intelligence-adapter/'));
  if (owned.length !== codexAdapterCases.length || fixtureManifest.fixtures.length !== owned.length ||
      fixtureManifest.intake_fixtures !== 0 || fixtureManifest.stateful_scenarios !== 0 ||
      !isDeepStrictEqual(fixtureManifest.fixtures.map(({fixture_id: id}) => id), owned.map(({fixture_id: id}) => id)) ||
      codexAdapterCategories.some((category) => !owned.some((entry) => entry.category === category))) codes.push('codex.fixture_manifest_invalid');

  const records = [];
  for (const entry of owned) {
    const fixtureResult = await validateDocument(packageRoot, `conformance/${entry.path}`, 'contracts/schemas/conformance-fixture.schema.json', codes);
    const fixture = fixtureResult.document;
    if (fixture === null || fixture.fixture_id !== entry.fixture_id || fixture.subject?.kind !== 'codex_intelligence_adapter') continue;
    const scenarioCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/codex-adapter-scenario.schema.json', fixture.subject.document));
    if (scenarioCode !== null) { codes.push(scenarioCode); continue; }
    const recoveryRecord = fixture.subject.document.operation === 'recover'
      ? recovery.cases.find(({fixture_id: id}) => id === entry.fixture_id) ?? null
      : null;
    const observed = await observeCodexAdapterScenario(fixture.subject, packageRoot, recoveryRecord);
    if (!isDeepStrictEqual(observed, fixture.expected)) codes.push('codex.observable_mismatch');
    if (observed.receipts.length !== 1) { codes.push('codex.receipt_invalid'); continue; }
    const receipt = JSON.parse(observed.receipts[0]);
    const receiptCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/codex-adapter-receipt.schema.json', receipt));
    const recoveredReceiptMatches = recoveryRecord !== null && observed.codes.length === 0
      ? receipt.receipt_sha256 === recoveryRecord.target_receipt_sha256
      : codexReceiptMatchesScenario(receipt, fixture.subject.document);
    const reasonRule = protocol.document?.receipt_reasons?.find(({code}) => code === receipt.reason);
    if (receiptCode !== null || !recoveredReceiptMatches || receipt.receipt_sha256 !== codexAdapterReceiptDigest(receipt) ||
        reasonRule?.outcome !== receipt.outcome) codes.push('codex.receipt_invalid');
    const denial = observedDenial(observed);
    if ((observed.codes.length === 0) !== (denial === null)) codes.push('codex.denial_evidence_invalid');
    if (denial !== null) {
      const denialCode = schemaErrorCode(await validateAgainstSchemaPath(packageRoot, 'contracts/schemas/codex-adapter-denial.schema.json', denial));
      if (denialCode !== null || !observed.codes.includes(denial.code) || denial.semantic_effects.length !== 0 || denial.filesystem_effects.length !== 0 || denial.tool_invocations.length !== 0 ||
          denial.transmitted_bytes !== receipt.transmitted_bytes || denial.destination !== receipt.observed_destination ||
          denial.transmitted_sha256 !== receipt.transmission_sha256) codes.push('codex.denial_evidence_invalid');
      if (denial.boundary === 'pre_transmission' && (receipt.transmitted_bytes !== 0 || receipt.observed_destination !== null || receipt.transmission_sha256 !== codexSha256(Buffer.alloc(0)) || denial.transmitted_sha256 !== codexSha256(Buffer.alloc(0)))) codes.push('codex.zero_byte_denial_invalid');
    }
    records.push({
      entry, document: fixture.subject.document, observed, receipt,
      fixtureSha256: codexSha256(fixtureResult.read.content),
    });
  }

  const expectedBindings = records.map(({entry, observed, receipt, fixtureSha256}) => ({
    fixture_id: entry.fixture_id, path: `conformance/${entry.path}`, fixture_sha256: fixtureSha256,
    receipt_sha256: receipt.receipt_sha256, verdict: observed.verdict,
  }));
  if (!isDeepStrictEqual(evidence.fixture_bindings, expectedBindings) ||
      !isDeepStrictEqual(evidence.receipt_sha256s, expectedBindings.map(({receipt_sha256}) => receipt_sha256)) ||
      evidence.approved_processing_envelope_sha256 !== (approvedEnvelope.read.status === 'present' ? codexSha256(approvedEnvelope.read.content) : null) ||
      evidence.boundary_sha256 !== codexSha256(documents[1].read.content) ||
      evidence.invocation_contract_sha256 !== codexSha256(documents[2].read.content) ||
      evidence.output_schema_sha256 !== (outputSchema.status === 'present' ? codexSha256(outputSchema.content) : null) ||
      evidence.authentication_prerequisite_sha256 !== codexSha256(documents[3].read.content) ||
      evidence.capability_proof_sha256 !== codexSha256(documents[4].read.content) || evidence.network_proof_sha256 !== codexSha256(documents[5].read.content) ||
      evidence.fixture_manifest_sha256 !== codexSha256(documents[6].read.content) || evidence.network_operations !== 0 || evidence.intake_fixtures !== 0 || evidence.stateful_scenarios !== 0 || evidence.verdict !== 'pass') codes.push('codex.machine_evidence_invalid');
  const recoveryBehaviors = new Set(['crash_before_transmission', 'crash_after_transmission', 'recover_current', 'recover_stale']);
  const recoveryRecords = records.filter(({document}) => recoveryBehaviors.has(document.behavior));
  const requiredRecoveryBehaviors = ['crash_before_transmission', 'crash_after_transmission', 'recover_current', 'recover_stale'];
  const recoveryProjectionComplete = requiredRecoveryBehaviors.every((behavior) =>
    recoveryRecords.filter(({document}) => document.behavior === behavior).length === 1);
  const expectedRecoveryBindings = recoveryProjectionComplete ? recoveryRecords.map(({entry, document, observed, receipt}) => {
    const targetBehavior = document.behavior === 'recover_current' ? 'crash_after_transmission' :
      document.behavior === 'recover_stale' ? 'crash_before_transmission' : document.behavior;
    const target = recoveryRecords.find(({document: candidate}) => candidate.behavior === targetBehavior);
    const envelope = JSON.parse(target.document.processing_envelope_json);
    return {
      fixture_id: entry.fixture_id,
      target_fixture_id: target.entry.fixture_id,
      target_path: `conformance/${target.entry.path}`,
      target_chain_id: envelope.chain_id,
      target_attempt_id: envelope.attempt_id,
      target_attempt_sequence: envelope.attempt_sequence,
      target_attempt_class: 'primary',
      target_authorization_id: envelope.authorization_id,
      target_envelope_id: envelope.envelope_id,
      target_envelope_sha256: target.document.processing_envelope_sha256,
      preceding_receipt_sha256s: [],
      target_receipt_sha256: target.receipt.receipt_sha256,
      terminal_state: observed.terminal_state,
      receipt_sha256: receipt.receipt_sha256,
    };
  }) : [];
  if (recovery.claim_manifest_sha256 !== codexSha256(documents[7].read.content) || recovery.evidence_digest !== claim.rows[0].evidence_digest ||
      recovery.parsed_artifacts_revalidated !== true || recovery.cases.length !== 4 ||
      !recoveryProjectionComplete ||
      !isDeepStrictEqual(recovery.cases, expectedRecoveryBindings) ||
      recovery.network_operations !== 0 || recovery.verdict !== 'pass') codes.push('codex.recovery_evidence_invalid');

  const traces = Array.isArray(traceability?.records) ? traceability.records.filter(({requirement_id: id}) => id?.startsWith('REQ-CODEX-')) : [];
  if (traces.length !== codexAdapterRequirementIds.length || !isDeepStrictEqual(traces.map(({requirement_id: id}) => id), codexAdapterRequirementIds) ||
      traces.some(({decision_ids: ids}) => !isDeepStrictEqual(ids, codexDecisionIds))) codes.push('codex.traceability_invalid');
  return result(codes);
}
