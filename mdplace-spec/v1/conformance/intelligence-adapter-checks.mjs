import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {adapterEvidenceClaims, adapterReceiptDigest, adapterResultDigest, parseReceiptStrings, sha256} from './intelligence-adapter-core.mjs';
import {observeIntelligenceAdapterScenario} from './intelligence-adapter-observer.mjs';
import {adapterOutcomePrecedence} from './intelligence-adapter-validation.mjs';
import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

const requiredCategories = [
  'positive', 'negative', 'exact_boundary', 'stale_state',
  'authority_denial', 'illegal_transition', 'crash_recovery',
];

const receiptTerminalStates = new Map([
  ['TRANS-IAP-EXECUTION', new Set(['terminal'])],
  ['TRANS-IAP-DENIAL', new Set(['denied'])],
  ['TRANS-IAP-TIMEOUT', new Set(['timed_out'])],
  ['TRANS-IAP-RETRY', new Set(['exhausted'])],
  ['TRANS-IAP-FALLBACK', new Set(['exhausted'])],
  ['TRANS-IAP-ISOLATION', new Set(['failed'])],
  ['TRANS-IAP-RECOVERY', new Set(['recovered', 'denied'])],
]);

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'intelligence-adapter-protocol', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
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

async function schemaCode(packageRoot, schemaPath, document) {
  if (document === null) return 'schema.instance_missing';
  try {
    return schemaErrorCode(await validateAgainstSchemaPath(packageRoot, schemaPath, document));
  } catch {
    return 'schema.instance_missing';
  }
}

function tableComplete(table) {
  const states = table?.states ?? [];
  const commands = table?.commands ?? [];
  const transitions = table?.transitions ?? [];
  const pairs = transitions.map(({from_state: state, command_or_event: command}) => `${state}:${command}`);
  return transitions.length === states.length * commands.length && new Set(pairs).size === pairs.length &&
    states.every((state) => commands.every((command) => pairs.includes(`${state}:${command}`)));
}

function isolationMatchesReceipt(observation, receipt) {
  const isolation = observation.isolation;
  return isolation.ephemeral === receipt.ephemeral &&
    isolation.fresh_process === receipt.fresh_process &&
    isolation.filesystem === receipt.filesystem &&
    isolation.tools === receipt.tools &&
    isolation.ambient_configuration === receipt.ambient_configuration &&
    isolation.credential_visibility === receipt.credential_visibility &&
    isDeepStrictEqual(isolation.network_scope, receipt.network_scope) &&
    isolation.canary.canary_id === receipt.canary_id &&
    sha256(isolation.canary.challenge) === receipt.canary_challenge_sha256 &&
    sha256(isolation.canary.expected) === receipt.canary_expected_sha256 &&
    sha256(isolation.canary.observed) === receipt.canary_observed_sha256 &&
    isolation.canary.passed === receipt.canary_passed;
}

function observationMatchesReceipt(observation, receipt) {
  return observation.attempt_id === receipt.attempt_id &&
    observation.attempt_class === receipt.attempt_class &&
    sha256(observation.exact_transmitted_utf8) === observation.exact_transmitted_sha256 &&
    Buffer.byteLength(observation.exact_transmitted_utf8) === observation.exact_transmitted_bytes &&
    observation.exact_transmitted_sha256 === receipt.envelope_sha256 &&
    observation.exact_transmitted_sha256 === receipt.transmission_sha256 &&
    observation.exact_transmitted_bytes === receipt.transmitted_bytes &&
    observation.exact_destination === receipt.observed_destination &&
    isDeepStrictEqual(observation.effective_capabilities, receipt.effective_capabilities) &&
    isDeepStrictEqual(
      observation.declared_retention_artifacts.map((artifact) => sha256(artifact)),
      receipt.retention_artifact_sha256s,
    ) &&
    isDeepStrictEqual(observation.measured_budget, receipt.budget) &&
    observation.observed_started_at === receipt.observed_started_at &&
    observation.observed_completed_at === receipt.observed_completed_at &&
    observation.provider_request_id === receipt.provider_request_id &&
    observation.raw_output_sha256 === receipt.raw_response_sha256 &&
    isolationMatchesReceipt(observation, receipt.isolation) &&
    observation.semantic_effects.length === 0 && observation.filesystem_effects.length === 0 &&
    observation.tool_invocations.length === 0;
}

function receiptTimingIsValid(receipt) {
  const started = Date.parse(receipt.observed_started_at);
  const completed = Date.parse(receipt.observed_completed_at);
  return Number.isFinite(started) && Number.isFinite(completed) && completed >= started &&
    new Date(started).toISOString() === receipt.observed_started_at &&
    new Date(completed).toISOString() === receipt.observed_completed_at &&
    completed - started === receipt.budget.runtime_ms;
}

export async function checkIntelligenceAdapterProtocol(packageRoot, manifest, conformance, traceability) {
  const codes = [];
  const rulesResult = await readJson(packageRoot, 'contracts/intelligence-adapter/protocol-rules.json');
  const contextResult = await readJson(packageRoot, 'contracts/intelligence-adapter/approved-context.json');
  const evidenceResult = await readJson(packageRoot, 'conformance/evidence/intelligence-adapter-evidence.json');
  const recoveryResult = await readJson(packageRoot, 'conformance/evidence/intelligence-adapter-recovery-report.json');
  const claimsResult = await readJson(packageRoot, 'claims-and-evidence.yaml');
  const receiptSchemaResult = await readJson(packageRoot, 'contracts/schemas/adapter-run-receipt.schema.json');
  const receiptReasons = rulesResult.document?.receipt_reasons ?? [];
  const receiptReasonByCode = new Map(receiptReasons.map(({code, outcome}) => [code, outcome]));
  const receiptSchemaCodes = receiptSchemaResult.document?.properties?.reason?.enum ?? [];
  if (receiptReasonByCode.size !== receiptReasons.length ||
      !isDeepStrictEqual(new Set(receiptSchemaCodes), new Set(receiptReasonByCode.keys()))) {
    codes.push('adapter.receipt_reason_invalid');
  }
  const roots = [
    [rulesResult.document, 'contracts/schemas/intelligence-adapter-protocol-rules.schema.json'],
    [contextResult.document, 'contracts/schemas/intelligence-adapter-approved-context.schema.json'],
    [evidenceResult.document, 'contracts/schemas/intelligence-adapter-evidence.schema.json'],
    [recoveryResult.document, 'contracts/schemas/intelligence-adapter-recovery-report.schema.json'],
  ];
  for (const [document, schema] of roots) {
    const code = await schemaCode(packageRoot, schema, document);
    if (code !== null) codes.push(code);
  }

  const lifecyclePaths = rulesResult.document?.lifecycle_tables ?? [];
  if (lifecyclePaths.length !== 7 || new Set(lifecyclePaths).size !== 7) codes.push('adapter.lifecycle_set_invalid');
  for (const path of lifecyclePaths) {
    const table = (await readJson(packageRoot, path)).document;
    const lifecycleSchemaCode = await schemaCode(
      packageRoot, 'contracts/schemas/transition-table.schema.json', table,
    );
    if (lifecycleSchemaCode !== null || !tableComplete(table)) codes.push('adapter.lifecycle_incomplete');
    if (lifecycleSchemaCode !== null) continue;
    const terminalStates = receiptTerminalStates.get(table?.table_id);
    if (terminalStates === undefined || table?.transitions?.some((row) =>
      (row.allowed && row.emitted_records.includes('AdapterRunReceipt') !== terminalStates.has(row.terminal_state)) ||
      (row.failure_result.emitted_records.includes('AdapterRunReceipt') &&
        !receiptReasonByCode.has(row.failure_result.code)))) {
      codes.push('adapter.lifecycle_receipt_invalid');
    }
  }

  const declared = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const classified = await Promise.all(declared.map(async (entry) => {
    const fixture = typeof entry?.path === 'string' ? (await readJson(packageRoot, `conformance/${entry.path}`)).document : null;
    const owned = entry?.fixture_id?.startsWith('FIX-IAP-') || entry?.path?.startsWith('scenarios/intelligence-adapter/') || fixture?.subject?.kind === 'intelligence_adapter';
    return {entry, fixture, owned};
  }));
  const owned = classified.filter(({owned: value}) => value);
  if (owned.length !== 42) codes.push('adapter.scenario_count_invalid');
  if (requiredCategories.some((category) => !owned.some(({entry}) => entry?.category === category))) {
    codes.push('adapter.scenario_category_missing');
  }

  const fixtureRecords = new Map();
  const scenarioIds = [];
  const observedCodes = new Set();
  for (const {entry, fixture} of owned) {
    if (fixture === null || !entry.fixture_id?.startsWith('FIX-IAP-') ||
        !/^scenarios\/intelligence-adapter\/[a-z0-9][a-z0-9-]*\.json$/.test(entry.path ?? '') ||
        fixture.fixture_id !== entry.fixture_id || fixture.category !== entry.category ||
        fixture.subject?.kind !== 'intelligence_adapter' ||
        fixture.subject?.schema !== 'contracts/schemas/intelligence-adapter-scenario.schema.json') {
      codes.push('adapter.scenario_manifest_pair_invalid');
      continue;
    }
    const document = fixture.subject.document;
    scenarioIds.push(document?.scenario_id);
    const scenarioCode = await schemaCode(packageRoot, fixture.subject.schema, document);
    if (scenarioCode !== null) {
      codes.push(scenarioCode);
      continue;
    }
    const envelopeSchemaErrors = [];
    let envelopeSchemaFailureCode = null;
    for (const attempt of document.attempts) {
      const envelopeSchemaPath = 'contracts/schemas/processing-envelope.schema.json';
      const code = await schemaCode(packageRoot, envelopeSchemaPath, attempt.envelope);
      if (code !== null) {
        let errors;
        try {
          errors = await validateAgainstSchemaPath(packageRoot, envelopeSchemaPath, attempt.envelope);
        } catch {
          envelopeSchemaFailureCode = code;
          break;
        }
        envelopeSchemaErrors.push(...errors.map(({path, keyword}) => ({
          attempt_sequence: attempt.envelope.attempt_sequence,
          code,
          path,
          keyword,
        })));
      }
    }
    if (envelopeSchemaFailureCode !== null) {
      codes.push(envelopeSchemaFailureCode);
      continue;
    }
    const expectedEnvelopeSchemaError = document.expected_envelope_schema_error;
    if (expectedEnvelopeSchemaError === undefined) {
      if (envelopeSchemaErrors.length > 0) {
        envelopeSchemaErrors.forEach(({code}) => codes.push(code));
        continue;
      }
    } else if (!isDeepStrictEqual(envelopeSchemaErrors, [expectedEnvelopeSchemaError])) {
      if (envelopeSchemaErrors.length === 0) codes.push('schema.constraint');
      else envelopeSchemaErrors.forEach(({code}) => codes.push(code));
      continue;
    }
    for (const receipt of document.recovery?.prior_receipts ?? []) {
      if (await schemaCode(packageRoot, 'contracts/schemas/adapter-run-receipt.schema.json', receipt) !== null ||
          receipt.receipt_sha256 !== adapterReceiptDigest(receipt)) codes.push('adapter.recovery_receipt_invalid');
    }
    const observed = await observeIntelligenceAdapterScenario(document, packageRoot);
    if (!isDeepStrictEqual(observed, fixture.expected)) codes.push('adapter.observable_mismatch');
    observed.codes.forEach((code) => observedCodes.add(code));
    const receipts = parseReceiptStrings(observed.receipts);
    for (const receipt of receipts) {
      observedCodes.add(receipt.reason);
      if (await schemaCode(packageRoot, 'contracts/schemas/adapter-run-receipt.schema.json', receipt) !== null ||
          receipt.receipt_sha256 !== adapterReceiptDigest(receipt) || receipt.semantic_effects.length !== 0 ||
          receipt.filesystem_effects.length !== 0 || receipt.tool_invocations.length !== 0 ||
          receiptReasonByCode.get(receipt.reason) !== receipt.outcome || !receiptTimingIsValid(receipt)) {
        codes.push('adapter.receipt_invalid');
      }
    }
    const observations = (observed.observations ?? []).map((value) => JSON.parse(value));
    const transmittedReceipts = receipts.filter(({transmitted_bytes: bytes}) => bytes > 0);
    const preservesPriorReceipt = document.operation === 'recover' && document.recovery?.crash_point === 'after_receipt';
    if ((!preservesPriorReceipt && transmittedReceipts.some((receipt) =>
      !observations.some((observation) => observationMatchesReceipt(observation, receipt)))) ||
      observed.filesystem_effects.some((effect) => effect !== 'none')) {
      codes.push('adapter.instrumented_observation_invalid');
    }
    fixtureRecords.set(entry.fixture_id, {entry, fixture, observed, receipts});
  }
  const expectedIds = Array.from({length: 42}, (_, index) => `IAP-${String(index + 1).padStart(3, '0')}`);
  if (new Set(scenarioIds).size !== 42 || expectedIds.some((id) => !scenarioIds.includes(id))) {
    codes.push('adapter.scenario_identity_invalid');
  }

  const evidence = evidenceResult.document;
  const evidenceBindings = evidence?.fixture_bindings ?? [];
  const fixtureIds = [...fixtureRecords.keys()];
  if (evidence?.validator_version !== manifest?.validator_version || evidenceBindings.length !== 42 ||
      !isDeepStrictEqual(evidenceBindings.map(({fixture_id: id}) => id), fixtureIds) ||
      createHash('sha256').update(contextResult.read.content ?? '').digest('hex') !== evidence?.approved_context_sha256) {
    codes.push('adapter.evidence_binding_invalid');
  }
  for (const binding of evidenceBindings) {
    const record = fixtureRecords.get(binding.fixture_id);
    const read = record === undefined ? {status: 'absent'} : await readPackageFile(packageRoot, `conformance/${binding.path}`);
    const receiptDigests = record?.receipts.map(({receipt_sha256: digest}) => digest);
    if (record === undefined || binding.path !== record.entry.path || read.status !== 'present' ||
        createHash('sha256').update(read.content ?? '').digest('hex') !== binding.fixture_sha256 ||
        adapterResultDigest(record.observed) !== binding.observable_result_sha256 ||
        !isDeepStrictEqual(receiptDigests, binding.receipt_sha256s)) {
      codes.push('adapter.evidence_binding_invalid');
    }
  }
  const claims = evidence?.claims;
  const expectedClaims = adapterEvidenceClaims([...fixtureRecords.entries()].map(([fixtureId, record]) => ({
    fixtureId,
    document: record.fixture.subject.document,
    observed: record.observed,
    receipts: record.receipts,
  })));
  if (Object.entries(expectedClaims).some(([claim, expected]) =>
    (expected !== true && !Array.isArray(expected)) || !isDeepStrictEqual(claims?.[claim], expected))) {
    codes.push('adapter.evidence_claim_invalid');
  }

  const outcomeRows = rulesResult.document?.outcome_precedence ?? [];
  const ruleCodes = outcomeRows.map(({code}) => code);
  if (outcomeRows.some(({order, code, outcome}, index) =>
    order !== index + 1 || receiptReasonByCode.get(code) !== outcome) ||
      !isDeepStrictEqual(ruleCodes, adapterOutcomePrecedence)) {
    codes.push('adapter.receipt_reason_invalid');
  }
  if (receiptReasons.some(({code}) => !observedCodes.has(code))) {
    codes.push('adapter.receipt_reason_coverage_missing');
  }
  if (ruleCodes.some((code) => !observedCodes.has(code)) ||
      rulesResult.document?.decision !== 'https://github.com/jidankim/mdplace/issues/8#issuecomment-5100984093') {
    codes.push('adapter.denial_coverage_missing');
  }
  const recoveryCases = recoveryResult.document?.cases ?? [];
  const recoveryFixtureIds = [...fixtureRecords.entries()]
    .filter(([, record]) => record.entry.category === 'crash_recovery')
    .map(([fixtureId]) => fixtureId);
  if (!isDeepStrictEqual(recoveryCases.map(({fixture_id: id}) => id), recoveryFixtureIds) ||
      recoveryCases.some((entry) => {
    const record = fixtureRecords.get(entry.fixture_id);
    return record === undefined || entry.observable_result_sha256 !== adapterResultDigest(record.observed) ||
      entry.crash_point !== record.fixture.subject.document.recovery.crash_point ||
      entry.target_attempt_id !== record.fixture.subject.document.recovery.target_attempt_id ||
      entry.target_attempt_sequence !== record.fixture.subject.document.recovery.target_attempt_sequence ||
      entry.terminal_state !== record.observed.terminal_state ||
      entry.transmitted_bytes !== record.receipts.reduce((total, receipt) => total + receipt.transmitted_bytes, 0) ||
      !isDeepStrictEqual(entry.receipt_sha256s, record.receipts.map(({receipt_sha256: digest}) => digest));
  })) codes.push('adapter.recovery_evidence_invalid');

  const iapTrace = Array.isArray(traceability?.records)
    ? traceability.records.filter((record) => record?.requirement_id?.startsWith('REQ-IAP-'))
    : [];
  if (iapTrace.length !== 8 || iapTrace.some(({decision_ids: ids}) => !isDeepStrictEqual(ids, ['DEC-008']))) {
    codes.push('adapter.traceability_invalid');
  }
  if (JSON.stringify(claimsResult.document ?? {}).includes('REQ-IAP-')) codes.push('adapter.profile_claim_forbidden');
  return result(codes);
}
