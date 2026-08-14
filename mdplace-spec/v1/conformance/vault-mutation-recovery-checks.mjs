import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {readPackageFile} from './safe-path.mjs';
import {observeVaultMutationScenario} from './vault-mutation-gate-observer.mjs';
import {virtualDescriptorIdentity} from './vault-mutation-virtual-vault.mjs';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function expectedRecoveryAction(boundaryId, mode) {
  if (boundaryId === 'after_commit') return 'resume';
  if (mode === 'cancel') return 'exact_rollback';
  if (mode === 'cancel_and_resume') return 'resume';
  if (mode === 'repeated_interruption') return 'terminal_manual_repair';
  if (boundaryId === 'after_metadata') return 'exact_rollback';
  if (boundaryId === 'after_receipt') return 'compensate';
  return 'resume';
}

export function expectedTerminalState(action) {
  return new Map([
    ['resume', 'committed'],
    ['exact_rollback', 'rolled_back'],
    ['compensate', 'compensated'],
    ['terminal_manual_repair', 'terminal_manual_repair'],
  ]).get(action);
}

export function matrixRecoveryRowsAreValid(matrix, expectedPairs) {
  const boundaries = Array.isArray(matrix?.boundaries)
    ? matrix.boundaries.filter(isRecord)
    : [];
  const results = boundaries.flatMap((boundary) =>
    (Array.isArray(boundary.mode_results) ? boundary.mode_results.filter(isRecord) : []).map((modeResult) => ({
      boundary,
      modeResult,
      pair: `${boundary.boundary_id}:${modeResult.mode}`,
    })));
  return results.length === expectedPairs.length &&
    new Set(results.map(({pair}) => pair)).size === expectedPairs.length &&
    expectedPairs.every((pair) => results.some((result) => result.pair === pair)) &&
    boundaries.every((boundary) => {
      const modeResults = Array.isArray(boundary.mode_results) ? boundary.mode_results.filter(isRecord) : [];
      return modeResults.length === boundary.mode_results?.length && isDeepStrictEqual(
        boundary.allowed_outcomes,
        [...new Set(modeResults.map(({recovery_action: action}) => action))],
      );
    }) &&
    results.every(({boundary, modeResult}) => {
      const action = expectedRecoveryAction(boundary.boundary_id, modeResult.mode);
      return modeResult.recovery_action === action &&
        modeResult.terminal_state === expectedTerminalState(action) &&
        modeResult.effect_obligation ===
          'preserve at-most-once effect identity; pathname and console text are non-authoritative';
    });
}

function durableObservation(prefix, event) {
  return prefix.includes(event) ? 'present' : 'absent';
}

function parseFixture(read) {
  if (read.status !== 'present') return null;
  try {
    return JSON.parse(read.content.toString('utf8'));
  } catch {
    return null;
  }
}

function fixtureBindsEvidence(fixture, evidence, entry, boundary, binding) {
  const scenario = fixture?.subject?.document;
  return fixture?.fixture_id === evidence.fixture_id && fixture?.category === 'crash_recovery' &&
    fixture?.subject?.kind === 'vault_mutation_gate' && entry.fixture_id === fixture.fixture_id &&
    scenario?.recovery?.crash_boundary === evidence.boundary_id &&
    scenario?.recovery?.mode === evidence.mode &&
    isDeepStrictEqual(scenario?.recovery?.durable_prefix, boundary.durable_prefix) &&
    scenario?.recovery?.declared_intent === evidence.expected_outcome &&
    fixture.subject.schema === 'contracts/schemas/vault-mutation-scenario.schema.json' &&
    isDeepStrictEqual(scenario?.probe?.authorized_precondition_identity,
      binding?.expected_precondition_identity) &&
    isDeepStrictEqual(scenario?.probe?.authorized_result_identity, binding?.expected_result_identity) &&
    isDeepStrictEqual(scenario?.probe?.receipt_precondition_identity,
      binding?.expected_precondition_identity) &&
    isDeepStrictEqual(scenario?.probe?.receipt_result_identity, binding?.expected_result_identity) &&
    isDeepStrictEqual(scenario?.authorized_plan?.scheduled_work, binding?.scheduled_work) &&
    scenario?.probe?.virtual_vault?.readback_descriptor !== null &&
    isDeepStrictEqual(virtualDescriptorIdentity(scenario.probe.virtual_vault.readback_descriptor),
      binding?.expected_result_identity);
}

async function evidenceRowIsValid(packageRoot, evidence, boundaryById, entryById, plan) {
  const boundary = boundaryById.get(evidence.boundary_id);
  const entry = entryById.get(evidence.fixture_id);
  if (boundary === undefined || entry?.category !== 'crash_recovery') return false;
  const fixtureRead = await readPackageFile(packageRoot, `conformance/${entry.path}`);
  const fixture = parseFixture(fixtureRead);
  const action = expectedRecoveryAction(evidence.boundary_id, evidence.mode);
  const binding = evidence.operation_binding;
  if (fixture === null || !fixtureBindsEvidence(fixture, evidence, entry, boundary, binding)) return false;
  const observed = await observeVaultMutationScenario(fixture.subject, packageRoot);
  return entry.expected_verdict === (action === 'terminal_manual_repair' ? 'fail' : 'pass') &&
    fixture.expected?.verdict === entry.expected_verdict && isDeepStrictEqual(observed, fixture.expected) &&
    createHash('sha256').update(fixtureRead.content).digest('hex') === evidence.fixture_sha256 &&
    isDeepStrictEqual(evidence.durable_prefix, boundary.durable_prefix) &&
    isDeepStrictEqual(evidence.observed_evidence, boundary.required_observations) &&
    binding?.plan_sha256 === plan?.immutable_inputs?.plan_sha256 &&
    binding?.idempotency_key === plan?.idempotency_key &&
    binding?.ownership_receipt_sha256 === plan?.ownership?.exclusive_writer_receipt_sha256 &&
    isDeepStrictEqual(binding?.scheduled_work, plan?.scheduled_work) &&
    isDeepStrictEqual(binding?.expected_precondition_identity, plan?.expected_precondition) &&
    isDeepStrictEqual(binding?.expected_result_identity, plan?.expected_result) &&
    isDeepStrictEqual(binding?.observed_effect_identity,
      boundary.durable_prefix.includes('data') ? plan?.expected_result : plan?.expected_precondition) &&
    evidence.receipt_echo_readback?.receipt === durableObservation(boundary.durable_prefix, 'receipt') &&
    evidence.receipt_echo_readback?.echo === durableObservation(boundary.durable_prefix, 'echo') &&
    evidence.receipt_echo_readback?.readback === durableObservation(boundary.durable_prefix, 'readback') &&
    evidence.expected_outcome === action && evidence.observed_outcome === action &&
    evidence.terminal_state === expectedTerminalState(action) && observed.terminal_state === evidence.terminal_state &&
    evidence.duplicate_effect === false && evidence.pathname_reopened === false &&
    evidence.console_success_authoritative === false && evidence.verdict === 'pass';
}

export async function boundaryModeEvidenceIsValid({
  packageRoot,
  recovery,
  matrix,
  entries,
  plan,
  expectedPairs,
}) {
  const results = Array.isArray(recovery?.boundary_mode_results)
    ? recovery.boundary_mode_results.filter(isRecord)
    : [];
  const pairs = results.map(({boundary_id: boundaryId, mode}) => `${boundaryId}:${mode}`);
  const fixtureIds = results.map(({fixture_id: fixtureId}) => fixtureId);
  const boundaries = Array.isArray(matrix?.boundaries) ? matrix.boundaries : [];
  const boundaryById = new Map(boundaries
    .filter(isRecord)
    .map((boundary) => [boundary.boundary_id, boundary]));
  const entryById = new Map(entries.map((entry) => [entry.fixture_id, entry]));
  return results.length === expectedPairs.length && new Set(pairs).size === expectedPairs.length &&
    new Set(fixtureIds).size === expectedPairs.length &&
    expectedPairs.every((pair) => pairs.includes(pair)) &&
    (await Promise.all(results.map((evidence) =>
      evidenceRowIsValid(packageRoot, evidence, boundaryById, entryById, plan)))).every(Boolean);
}
