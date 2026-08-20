import {isDeepStrictEqual} from 'node:util';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {adapterReceiptDigest} from './intelligence-adapter-core.mjs';
import {localAdapterClaimCodes} from './local-adapter-claim-validation.mjs';
import {
  localAdapterCategories,
  localAdapterEvidenceEvaluatedAt,
  localAdapterRequirementIds,
  sha256,
} from './local-adapter-core.mjs';
import {localAdapterCases} from './local-adapter-fixtures.mjs';
import {
  localAdapterRecoveryBindings,
  localAdapterRecoveryValidation,
} from './local-adapter-evidence-validation.mjs';
import {observeLocalAdapterScenario} from './local-adapter-observer.mjs';
import {readPackageFile} from './safe-path.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'local-intelligence-adapter-profile', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

function exactProfile(profile, capability, isolation) {
  const evaluatedAt = Date.parse(localAdapterEvidenceEvaluatedAt);
  const evidenceIsCurrent = (document) => document?.status === 'current' &&
    Date.parse(document.observed_at) <= evaluatedAt && Date.parse(document.expires_at) > evaluatedAt;
  return profile?.profile_id === 'local-adapter' && profile.owner === 'local-adapter' &&
    profile.locality === 'local' && profile.lifecycle === 'isolated_ephemeral_advisory' &&
    isDeepStrictEqual(profile.capabilities, ['emit_schema_validated_proposal', 'emit_schema_validated_receipt']) &&
    Object.values(profile.authority ?? {}).every((value) => value === 'none') &&
    profile.execution_scope?.network_access === 'denied' && profile.specification_only === true &&
    isDeepStrictEqual(profile.output_schemas, ['contracts/schemas/intelligence-proposal.schema.json', 'contracts/schemas/adapter-run-receipt.schema.json']) &&
    evidenceIsCurrent(capability) && evidenceIsCurrent(isolation) &&
    isolation.ephemeral === true && isolation.fresh_process === true && isolation.advisory_only === true &&
    isolation.prompt_injection_inert === true && isolation.filesystem === 'none' &&
    isolation.network === 'denied' && isolation.tools === 'none' &&
    isolation.ambient_configuration === 'unreadable' && isolation.credentials === 'none' &&
    isolation.semantic_writer === 'unreachable';
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

function exactVerdicts(document) {
  const rows = Array.isArray(document?.rows) ? document.rows : [];
  return isDeepStrictEqual(document?.precedence, ['fail', 'unsupported', 'inconclusive', 'pass']) &&
    isDeepStrictEqual(rows.map(({verdict}) => verdict), ['pass', 'fail', 'unsupported', 'inconclusive']) &&
    rows[0]?.required_fact_effect === 'satisfied' &&
    rows.slice(1).every(({required_fact_effect: effect, claim_effect: claimEffect}) =>
      effect === 'non_pass' && claimEffect === 'deny_pass');
}

export async function checkLocalAdapterProfile(packageRoot, conformance, traceability) {
  const codes = [];
  const documents = await Promise.all([
    ['contracts/local-intelligence-adapter/profile.json', 'contracts/schemas/local-intelligence-adapter-profile.schema.json'],
    ['contracts/local-intelligence-adapter/capability-evidence.json', 'contracts/schemas/local-adapter-capability-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/isolation-evidence.json', 'contracts/schemas/local-adapter-isolation-evidence.schema.json'],
    ['contracts/local-intelligence-adapter/fixture-manifest.json', 'contracts/schemas/local-adapter-fixture-manifest.schema.json'],
    ['contracts/local-intelligence-adapter/claim-manifest.json', 'contracts/schemas/local-adapter-claim-manifest.schema.json'],
    ['contracts/verdicts/local-adapter-verdicts.json', 'contracts/schemas/local-adapter-verdict-table.schema.json'],
    ['conformance/evidence/local-adapter-evidence.json', 'contracts/schemas/local-adapter-evidence.schema.json'],
    ['conformance/evidence/local-adapter-recovery-report.json', 'contracts/schemas/local-adapter-recovery-report.schema.json'],
  ].map(([path, schema]) => validateDocument(packageRoot, path, schema, codes)));
  if (documents.some(({document}) => document === null)) return result(codes);
  const [profile, capability, isolation, fixtureManifest, claim, verdicts, evidence, recovery] =
    documents.map(({document}) => document);
  if (!exactProfile(profile, capability, isolation)) codes.push('local.profile_boundary_invalid');
  if (capability.profile_sha256 !== sha256(documents[0].read.content) ||
      isolation.profile_sha256 !== sha256(documents[0].read.content)) codes.push('local.profile_evidence_binding_invalid');
  if (!exactVerdicts(verdicts)) codes.push('local.verdict_table_invalid');
  const transitionNames = ['capability', 'isolation', 'verdict', 'failure', 'recovery'];
  const transitions = await Promise.all(transitionNames.map((name) => validateDocument(
    packageRoot,
    `contracts/transitions/local-adapter-${name}-lifecycle.json`,
    'contracts/schemas/transition-table.schema.json',
    codes,
  )));
  if (transitions.some(({document}) => document === null || !completeReachableTable(document))) {
    codes.push('local.transition_tables_incomplete');
  }
  codes.push(...await localAdapterClaimCodes(claim, packageRoot));

  const declared = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const owned = declared.filter(({fixture_id: id, path}) =>
    id?.startsWith('FIX-LIA-PROFILE-') || path?.startsWith('scenarios/local-intelligence-adapter/'));
  if (owned.length !== localAdapterCases.length || fixtureManifest.fixtures.length !== owned.length ||
      !isDeepStrictEqual(fixtureManifest.fixtures.map(({fixture_id: id}) => id), owned.map(({fixture_id: id}) => id)) ||
      localAdapterCategories.some((category) => !owned.some((entry) => entry.category === category))) {
    codes.push('local.fixture_manifest_invalid');
  }

  const observedRecords = [];
  for (const entry of owned) {
    const fixtureResult = await validateDocument(
      packageRoot,
      `conformance/${entry.path}`,
      'contracts/schemas/conformance-fixture.schema.json',
      codes,
    );
    const fixture = fixtureResult.document;
    if (fixture === null || fixture.fixture_id !== entry.fixture_id ||
        fixture.subject?.kind !== 'local_intelligence_adapter') continue;
    try {
      const scenarioCode = schemaErrorCode(await validateAgainstSchemaPath(
        packageRoot,
        'contracts/schemas/local-adapter-scenario.schema.json',
        fixture.subject.document,
      ));
      if (scenarioCode !== null) {
        codes.push(scenarioCode);
        continue;
      }
    } catch {
      codes.push('schema.instance_missing');
      continue;
    }
    const recoveryBindings = await localAdapterRecoveryBindings(fixture.subject.document, packageRoot);
    const observed = await observeLocalAdapterScenario(fixture.subject, packageRoot, recoveryBindings);
    if (!isDeepStrictEqual(observed, fixture.expected)) codes.push('local.observable_mismatch');
    if (observed.receipts.length !== 1) {
      codes.push('local.receipt_invalid');
      continue;
    }
    const receipt = JSON.parse(observed.receipts[0]);
    const receiptCode = schemaErrorCode(await validateAgainstSchemaPath(
      packageRoot,
      'contracts/schemas/adapter-run-receipt.schema.json',
      receipt,
    ));
    const observedRuntime = Date.parse(receipt.observed_completed_at) - Date.parse(receipt.observed_started_at);
    if (receiptCode !== null || receipt.receipt_sha256 !== adapterReceiptDigest(receipt) ||
        !Number.isFinite(observedRuntime) || observedRuntime !== receipt.budget.runtime_ms ||
        receipt.semantic_effects.length !== 0 || receipt.filesystem_effects.length !== 0 ||
        receipt.tool_invocations.length !== 0) {
      codes.push('local.receipt_invalid');
    }
    const recoveryValidation = recoveryBindings === null
      ? null
      : await localAdapterRecoveryValidation(recoveryBindings, packageRoot);
    observedRecords.push({
      entry,
      fixture,
      observed,
      receipt,
      recoveryValidation,
      fixtureSha256: sha256(fixtureResult.read.content),
    });
  }

  const expectedBindings = observedRecords.map(({entry, observed, receipt, fixtureSha256}) => ({
    fixture_id: entry.fixture_id, path: `conformance/${entry.path}`,
    fixture_sha256: fixtureSha256, receipt_sha256: receipt.receipt_sha256, verdict: observed.verdict,
  }));
  if (!isDeepStrictEqual(evidence.fixture_bindings, expectedBindings) ||
      !isDeepStrictEqual(evidence.receipt_sha256s, expectedBindings.map(({receipt_sha256}) => receipt_sha256)) ||
      evidence.capability_evidence_sha256 !== sha256(documents[1].read.content) ||
      evidence.isolation_evidence_sha256 !== sha256(documents[2].read.content) ||
      evidence.fixture_manifest_sha256 !== sha256(documents[3].read.content) || evidence.verdict !== 'pass') {
    codes.push('local.machine_evidence_invalid');
  }
  const recoveryRecords = observedRecords.filter(({fixture}) => fixture.subject.document.operation === 'recover');
  const expectedRecoveryCases = recoveryRecords.map(({entry, observed, receipt, recoveryValidation}) => ({
    fixture_id: entry.fixture_id,
    claim_digest_revalidated: recoveryValidation.claimDigestRevalidated,
    parsed_evidence_revalidated: recoveryValidation.parsedEvidenceRevalidated,
    terminal_state: observed.terminal_state,
    receipt_sha256: receipt.receipt_sha256,
  }));
  if (recovery.claim_manifest_sha256 !== sha256(documents[4].read.content) ||
      recovery.evidence_digest !== claim.rows[0].evidence_digest ||
      !isDeepStrictEqual(recovery.cases, expectedRecoveryCases) ||
      recovery.parsed_artifacts_revalidated !== true || recovery.verdict !== 'pass') {
    codes.push('local.recovery_evidence_invalid');
  }
  const traces = Array.isArray(traceability?.records)
    ? traceability.records.filter(({requirement_id: id}) => id?.startsWith('REQ-LIA-'))
    : [];
  if (traces.length !== localAdapterRequirementIds.length ||
      !isDeepStrictEqual(traces.map(({requirement_id: id}) => id), localAdapterRequirementIds) ||
      traces.some(({decision_ids: ids}) => !isDeepStrictEqual(ids, ['DEC-008']))) {
    codes.push('local.traceability_invalid');
  }
  return result(codes);
}
