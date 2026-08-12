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
      const caseIds = matrix.rows.map(({case_id: id}) => id);
      if (!sameOrder(evidence.recovery_matrix.case_ids, caseIds) ||
          matrix.rows.some(({terminal_result: terminal, default_decision: decision}) =>
            !terminal.endsWith('with unchanged semantic truth') ||
            !['resume', 'preserve', 'requeue', 'fail', 'block', 'deny'].includes(decision))) {
        codes.push('control.evidence_recovery_matrix_invalid');
      }
    } catch {
      codes.push('control.evidence_recovery_matrix_invalid');
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
