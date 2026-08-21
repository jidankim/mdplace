import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {remoteAdapterClaimCodes} from './remote-adapter-claim-validation.mjs';
import {
  remoteAdapterCategories,
  remoteAdapterEvidenceEvaluatedAt,
  remoteAdapterRequirementIds,
  remoteSha256,
} from './remote-adapter-core.mjs';
import {remoteAdapterCases} from './remote-adapter-fixtures.mjs';
import {observeRemoteAdapterScenario, remoteAdapterReceiptDigest} from './remote-adapter-observer.mjs';
import {readPackageFile} from './safe-path.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'remote-intelligence-adapter-profile', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

async function exactEvidence(packageRoot, profile, credential, retention) {
  const evaluatedAt = Date.parse(remoteAdapterEvidenceEvaluatedAt);
  const current = (document) => document?.status === 'current' &&
    Date.parse(document.observed_at) <= evaluatedAt && Date.parse(document.expires_at) > evaluatedAt;
  const dimensions = ['residency', 'retention', 'training', 'deletion', 'entitlement', 'privacy_behavior'];
  const facts = retention?.facts ?? [];
  const expectedStatuses = {
    residency: 'unsupported',
    retention: 'disclosed',
    training: 'inconclusive',
    deletion: 'unsupported',
    entitlement: 'unsupported',
    privacy_behavior: 'inconclusive',
  };
  const disclosedEvidenceMatches = (await Promise.all(facts
    .filter(({status}) => status === 'disclosed')
    .map(async ({evidence_ref: path, evidence_sha256: digest}) => {
      if (typeof path !== 'string' || typeof digest !== 'string') return false;
      const read = await readPackageFile(packageRoot, path);
      return read.status === 'present' && remoteSha256(read.content) === digest;
    }))).every(Boolean);
  return profile?.profile_id === 'remote-adapter' && profile.owner === 'remote-adapter' &&
    profile.locality === 'remote' && profile.specification_only === true &&
    profile.network_operation_performed === false && Object.values(profile.authority ?? {}).every((value) => value === 'none') &&
    current(credential) && credential.prerequisite === 'satisfied' && credential.adapter_visibility === 'none' &&
    credential.secret_access === 'none' && credential.ambient_configuration === 'unreadable' &&
    credential.environment_values === 'unreadable' && credential.claims_established.length === 0 &&
    current(retention) && isDeepStrictEqual(facts.map(({dimension}) => dimension).sort(), [...dimensions].sort()) &&
    facts.every(({dimension, status}) => expectedStatuses[dimension] === status) && disclosedEvidenceMatches &&
    facts.filter(({status}) => status === 'disclosed').every(({value, evidence_ref: ref, evidence_sha256: digest}) =>
      typeof value === 'string' && typeof ref === 'string' && /^[a-f0-9]{64}$/.test(digest)) &&
    facts.filter(({status}) => status !== 'disclosed').every(({value, evidence_ref: ref, evidence_sha256: digest}) =>
      value === null && ref === null && digest === null);
}

function exactVerdicts(document) {
  return isDeepStrictEqual(document?.precedence, ['fail', 'unsupported', 'inconclusive', 'pass']) &&
    isDeepStrictEqual(document?.rows?.map(({verdict}) => verdict), ['pass', 'fail', 'unsupported', 'inconclusive']) &&
    document.rows[0].claim_effect === 'eligible_pass' &&
    document.rows.slice(1).every(({claim_effect: effect}) => effect === 'deny_pass');
}

export async function checkRemoteAdapterProfile(packageRoot, conformance, traceability) {
  const codes = [];
  const bindings = [
    ['contracts/remote-intelligence-adapter/profile.json', 'contracts/schemas/remote-intelligence-adapter-profile.schema.json'],
    ['contracts/remote-intelligence-adapter/credential-boundary-evidence.json', 'contracts/schemas/remote-adapter-credential-boundary-evidence.schema.json'],
    ['contracts/remote-intelligence-adapter/retention-evidence.json', 'contracts/schemas/remote-adapter-retention-evidence.schema.json'],
    ['contracts/remote-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/remote-adapter-fixture-manifest.schema.json'],
    ['contracts/remote-intelligence-adapter/claim-manifest.json', 'contracts/schemas/remote-adapter-claim-manifest.schema.json'],
    ['contracts/verdicts/remote-adapter-verdicts.json', 'contracts/schemas/remote-adapter-verdict-table.schema.json'],
    ['conformance/evidence/remote-adapter-evidence.json', 'contracts/schemas/remote-adapter-evidence.schema.json'],
    ['conformance/evidence/remote-adapter-recovery-report.json', 'contracts/schemas/remote-adapter-recovery-report.schema.json'],
  ];
  const documents = await Promise.all(bindings.map(([path, schema]) => validateDocument(packageRoot, path, schema, codes)));
  if (documents.some(({document}) => document === null)) return result(codes);
  const [profile, credential, retention, fixtureManifest, claim, verdicts, evidence, recovery] =
    documents.map(({document}) => document);
  if (!await exactEvidence(packageRoot, profile, credential, retention)) codes.push('remote.profile_boundary_invalid');
  if (credential.profile_sha256 !== remoteSha256(documents[0].read.content) ||
      retention.profile_sha256 !== remoteSha256(documents[0].read.content)) {
    codes.push('remote.profile_evidence_binding_invalid');
  }
  if (!exactVerdicts(verdicts)) codes.push('remote.verdict_table_invalid');
  const transitionNames = ['permitted-egress', 'denial', 'failure', 'retry', 'fallback', 'recovery', 'verdict'];
  const transitions = await Promise.all(transitionNames.map((name) => validateDocument(
    packageRoot,
    `contracts/transitions/remote-adapter-${name}-lifecycle.json`,
    'contracts/schemas/transition-table.schema.json',
    codes,
  )));
  if (transitions.some(({document}) => document === null || !completeReachableTable(document))) {
    codes.push('remote.transition_tables_incomplete');
  }
  codes.push(...await remoteAdapterClaimCodes(claim, packageRoot));

  const declared = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const owned = declared.filter(({fixture_id: id, path}) =>
    id?.startsWith('FIX-RAP-PROFILE-') || path?.startsWith('scenarios/remote-intelligence-adapter/'));
  if (owned.length !== remoteAdapterCases.length || fixtureManifest.fixtures.length !== owned.length ||
      !isDeepStrictEqual(fixtureManifest.fixtures.map(({fixture_id: id}) => id), owned.map(({fixture_id: id}) => id)) ||
      remoteAdapterCategories.some((category) => !owned.some((entry) => entry.category === category))) {
    codes.push('remote.fixture_manifest_invalid');
  }

  const records = [];
  for (const entry of owned) {
    const fixtureResult = await validateDocument(
      packageRoot,
      `conformance/${entry.path}`,
      'contracts/schemas/conformance-fixture.schema.json',
      codes,
    );
    const fixture = fixtureResult.document;
    if (fixture === null || fixture.fixture_id !== entry.fixture_id ||
        fixture.subject?.kind !== 'remote_intelligence_adapter') continue;
    const scenarioCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/remote-adapter-scenario.schema.json',
      fixture.subject.document,
    ));
    if (scenarioCode !== null) {
      codes.push(scenarioCode);
      continue;
    }
    const recoveryRecord = fixture.subject.document.operation === 'recover'
      ? recovery.cases.find(({fixture_id: id}) => id === entry.fixture_id) ?? null
      : null;
    const observed = await observeRemoteAdapterScenario(fixture.subject, packageRoot, recoveryRecord);
    if (!isDeepStrictEqual(observed, fixture.expected)) codes.push('remote.observable_mismatch');
    if (observed.receipts.length !== 1) {
      codes.push('remote.receipt_invalid');
      continue;
    }
    const receipt = JSON.parse(observed.receipts[0]);
    const receiptCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/remote-adapter-profile-receipt.schema.json',
      receipt,
    ));
    if (receiptCode !== null || receipt.receipt_sha256 !== remoteAdapterReceiptDigest(receipt) ||
        receipt.semantic_effects.length !== 0 || receipt.filesystem_effects.length !== 0 ||
        receipt.tool_invocations.length !== 0) codes.push('remote.receipt_invalid');
    if (observed.network_effects[0] === 'none' && receipt.outcome === 'denied' &&
        receipt.attempts.some(({transmitted_bytes: bytes, destination}) => bytes !== 0 || destination !== null)) {
      codes.push('remote.zero_byte_denial_invalid');
    }
    records.push({entry, fixture, observed, receipt, fixtureSha256: remoteSha256(fixtureResult.read.content)});
  }

  const expectedBindings = records.map(({entry, observed, receipt, fixtureSha256}) => ({
    fixture_id: entry.fixture_id,
    path: `conformance/${entry.path}`,
    fixture_sha256: fixtureSha256,
    receipt_sha256: receipt.receipt_sha256,
    verdict: observed.verdict,
  }));
  if (!isDeepStrictEqual(evidence.fixture_bindings, expectedBindings) ||
      !isDeepStrictEqual(evidence.receipt_sha256s, expectedBindings.map(({receipt_sha256}) => receipt_sha256)) ||
      evidence.credential_boundary_evidence_sha256 !== remoteSha256(documents[1].read.content) ||
      evidence.retention_evidence_sha256 !== remoteSha256(documents[2].read.content) ||
      evidence.fixture_manifest_sha256 !== remoteSha256(documents[3].read.content) ||
      evidence.network_operations !== 0 || evidence.verdict !== 'pass') codes.push('remote.machine_evidence_invalid');
  if (recovery.claim_manifest_sha256 !== remoteSha256(documents[4].read.content) ||
      recovery.evidence_digest !== claim.rows[0].evidence_digest ||
      recovery.parsed_artifacts_revalidated !== true || recovery.network_operations !== 0 ||
      recovery.cases.length !== 3 || recovery.verdict !== 'pass') codes.push('remote.recovery_evidence_invalid');
  const traces = Array.isArray(traceability?.records)
    ? traceability.records.filter(({requirement_id: id}) => id?.startsWith('REQ-RAP-'))
    : [];
  if (traces.length !== remoteAdapterRequirementIds.length ||
      !isDeepStrictEqual(traces.map(({requirement_id: id}) => id), remoteAdapterRequirementIds) ||
      traces.some(({decision_ids: ids}) => !isDeepStrictEqual(ids, ['DEC-008']))) {
    codes.push('remote.traceability_invalid');
  }
  return result(codes);
}
