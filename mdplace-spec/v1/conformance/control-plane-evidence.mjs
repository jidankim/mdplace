import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {observeFixture} from './fixture-observer.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {readPackageFile} from './safe-path.mjs';

const claimFixtures = new Map([
  ['durable_queue', ['FIX-CP-REC-001', 'FIX-CP-POS-001', 'FIX-CP-REC-002', 'FIX-CP-POS-006', 'FIX-CP-NEG-001']],
  ['retry_cancellation_resume', ['FIX-CP-POS-002', 'FIX-CP-BND-001', 'FIX-CP-ILLEGAL-001', 'FIX-CP-POS-003', 'FIX-CP-POS-004', 'FIX-CP-REC-003', 'FIX-CP-POS-005']],
  ['stale_and_authority_denial', ['FIX-CP-STATE-001', 'FIX-CP-STATE-002', 'FIX-CP-STATE-003', 'FIX-CP-AUTH-004', 'FIX-CP-AUTH-005']],
  ['readiness_and_writer', ['FIX-CP-AUTH-001', 'FIX-CP-AUTH-002', 'FIX-CP-AUTH-003', 'FIX-CP-POS-008', 'FIX-CP-AUTH-005']],
  ['crash_recovery', ['FIX-CP-REC-001', 'FIX-CP-REC-002', 'FIX-CP-REC-003', 'FIX-CP-REC-004', 'FIX-CP-REC-005', 'FIX-CP-REC-006']],
]);

const authoritySources = [
  'work_journal', 'scheduler', 'mdplace_agent', 'child_work',
  'control_channel', 'readiness', 'retry', 'queue',
];

const deniedTransitions = new Map([
  ['contracts/transitions/work-queue-lifecycle.json', [
    'TR-CPWORK-002', 'TR-CPWORK-003', 'TR-CPWORK-004', 'TR-CPWORK-005',
    'TR-CPWORK-008', 'TR-CPWORK-009', 'TR-CPWORK-010', 'TR-CPWORK-012',
    'TR-CPWORK-014', 'TR-CPWORK-017', 'TR-CPWORK-018', 'TR-CPWORK-022',
    'TR-CPWORK-023', 'TR-CPWORK-024', 'TR-CPWORK-025',
  ]],
  ['contracts/transitions/retry-lifecycle.json', [
    'TR-CPRETRY-003', 'TR-CPRETRY-004', 'TR-CPRETRY-005',
    'TR-CPRETRY-007', 'TR-CPRETRY-008', 'TR-CPRETRY-009',
  ]],
  ['contracts/transitions/cancellation-lifecycle.json', [
    'TR-CPCANCEL-002', 'TR-CPCANCEL-004', 'TR-CPCANCEL-006', 'TR-CPCANCEL-008',
    'TR-CPCANCEL-011', 'TR-CPCANCEL-012', 'TR-CPCANCEL-013', 'TR-CPCANCEL-014',
  ]],
  ['contracts/transitions/readiness-lifecycle.json', ['TR-CPREADY-003']],
  ['contracts/transitions/agent-lifecycle.json', [
    'TR-CPAGENT-002', 'TR-CPAGENT-003', 'TR-CPAGENT-005', 'TR-CPAGENT-007',
    'TR-CPAGENT-009', 'TR-CPAGENT-013', 'TR-CPAGENT-015', 'TR-CPAGENT-017',
    'TR-CPAGENT-019', 'TR-CPAGENT-021', 'TR-CPAGENT-022',
  ]],
  ['contracts/transitions/control-channel-lifecycle.json', ['TR-CPCHANNEL-002']],
  ['contracts/transitions/exclusive-writer-lifecycle.json', [
    'TR-CPWRITER-002', 'TR-CPWRITER-003', 'TR-CPWRITER-004',
  ]],
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameOrder(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export async function controlPlaneEvidenceCodes(packageRoot, evidence, entries) {
  const codes = [];
  const bindings = Array.isArray(evidence?.fixture_bindings) ? evidence.fixture_bindings : [];
  const entryById = new Map(entries.map((entry) => [entry.fixture_id, entry]));
  const observedById = new Map();
  if (bindings.length !== entries.length ||
      new Set(bindings.map(({fixture_id: id}) => id)).size !== entries.length) {
    codes.push('control.evidence_binding_set_invalid');
  }
  for (const binding of bindings) {
    const entry = entryById.get(binding?.fixture_id);
    if (entry === undefined || binding.path !== entry.path) {
      codes.push('control.evidence_binding_set_invalid');
      continue;
    }
    const read = await readPackageFile(packageRoot, `conformance/${entry.path}`);
    if (read.status !== 'present' || sha256(read.content) !== binding.fixture_sha256) {
      codes.push('control.evidence_fixture_digest_mismatch');
      continue;
    }
    let fixture;
    try {
      fixture = JSON.parse(read.content.toString('utf8'));
    } catch {
      codes.push('control.evidence_fixture_malformed');
      continue;
    }
    const observed = await observeFixture(fixture, packageRoot);
    const observableDigest = sha256(canonicalJson(observed));
    observedById.set(binding.fixture_id, {fixture, observed});
    if (observableDigest !== binding.observable_result_sha256 ||
        !isDeepStrictEqual(observed, fixture.expected)) {
      codes.push('control.evidence_observable_mismatch');
    }
  }

  const matrixRead = await readPackageFile(packageRoot, 'contracts/control-plane/recovery-matrix.json');
  if (matrixRead.status !== 'present' || evidence?.recovery_matrix?.path !== 'contracts/control-plane/recovery-matrix.json' ||
      sha256(matrixRead.status === 'present' ? matrixRead.content : '') !== evidence?.recovery_matrix?.sha256) {
    codes.push('control.evidence_recovery_matrix_invalid');
  } else {
    try {
      const matrix = JSON.parse(matrixRead.content.toString('utf8'));
      const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
      const caseIds = rows.map((row) => row?.case_id);
      if (!sameOrder(evidence.recovery_matrix.case_ids, caseIds) ||
          rows.some(({terminal_result: terminal, default_decision: decision} = {}) =>
            typeof terminal !== 'string' || !terminal.endsWith('with unchanged semantic truth') ||
            !['resume', 'preserve', 'requeue', 'fail', 'block', 'deny'].includes(decision))) {
        codes.push('control.evidence_recovery_matrix_invalid');
      }
    } catch {
      codes.push('control.evidence_recovery_matrix_invalid');
    }
  }

  const transitionBindings = Array.isArray(evidence?.transition_bindings) ? evidence.transition_bindings : [];
  if (transitionBindings.length !== deniedTransitions.size) {
    codes.push('control.evidence_transition_binding_invalid');
  } else {
    for (const [index, [path, expectedDeniedIds]] of [...deniedTransitions].entries()) {
      const binding = transitionBindings[index];
      const read = await readPackageFile(packageRoot, path);
      let table;
      try {
        table = read.status === 'present' ? JSON.parse(read.content.toString('utf8')) : null;
      } catch {
        table = null;
      }
      const actualDeniedIds = Array.isArray(table?.transitions)
        ? table.transitions.filter((row) => row?.allowed === false).map((row) => row?.transition_id)
        : [];
      if (binding?.path !== path || read.status !== 'present' || binding?.sha256 !== sha256(read.content) ||
          !sameOrder(binding?.denied_transition_ids, expectedDeniedIds) ||
          !sameOrder(actualDeniedIds, expectedDeniedIds)) {
        codes.push('control.evidence_transition_binding_invalid');
      }
    }
  }

  for (const [claimName, expectedIds] of claimFixtures) {
    const declaredIds = evidence?.claims?.[claimName];
    if (!sameOrder(declaredIds, expectedIds) || expectedIds.some((id) => !observedById.has(id))) {
      codes.push(`control.evidence_${claimName}_invalid`);
    }
  }

  const semanticClaim = evidence?.claims?.semantic_truth_preserved;
  const semanticFixtureIds = entries
    .filter((entry) => observedById.get(entry.fixture_id)?.fixture?.subject?.document?.action?.semantic_write_requested)
    .map(({fixture_id: id}) => id);
  if (!sameOrder(semanticClaim?.authority_sources, authoritySources) ||
      !sameOrder(semanticClaim?.fixture_ids, semanticFixtureIds) ||
      typeof semanticClaim?.semantic_state_digest !== 'string' ||
      semanticFixtureIds.some((id) => {
        const result = observedById.get(id)?.observed;
        const source = observedById.get(id)?.fixture?.subject?.document?.action?.authority_source;
        return result?.outputs?.includes(`semantic_write:denied:${source}`) !== true ||
          result?.outputs?.includes(`semantic_state_digest:${semanticClaim.semantic_state_digest}`) !== true;
      })) {
    codes.push('control.evidence_semantic_authority_invalid');
  }
  return codes;
}
