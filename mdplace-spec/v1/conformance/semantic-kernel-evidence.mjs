import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

import {observeFixture} from './fixture-observer.mjs';
import {canonicalJson} from './semantic-kernel-core.mjs';
import {replayRecords} from './semantic-kernel-replay.mjs';
import {readPackageFile} from './safe-path.mjs';

const replayFixtureIds = ['FIX-SK-POS-005', 'FIX-SK-POS-006'];
const crashFixtureIds = ['FIX-SK-REC-001', 'FIX-SK-REC-002'];
const denialFixtureIds = Array.from({length: 6}, (_, index) => `FIX-SK-AUTH-${String(index + 1).padStart(3, '0')}`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameOrder(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function resultDigest(result) {
  return sha256(canonicalJson(result));
}

export async function semanticKernelEvidenceCodes(packageRoot, evidence, entries) {
  const codes = [];
  const bindings = Array.isArray(evidence?.fixture_bindings) ? evidence.fixture_bindings : [];
  const entryById = new Map(entries.map((entry) => [entry.fixture_id, entry]));
  const observedById = new Map();
  if (bindings.length !== entries.length || new Set(bindings.map(({fixture_id: id}) => id)).size !== entries.length) {
    codes.push('semantic.evidence_binding_set_invalid');
  }
  for (const binding of bindings) {
    const entry = entryById.get(binding?.fixture_id);
    if (entry === undefined || binding.path !== entry.path) {
      codes.push('semantic.evidence_binding_set_invalid');
      continue;
    }
    const read = await readPackageFile(packageRoot, `conformance/${entry.path}`);
    if (read.status !== 'present' || sha256(read.content) !== binding.fixture_sha256) {
      codes.push('semantic.evidence_fixture_digest_mismatch');
      continue;
    }
    let fixture;
    try {
      fixture = JSON.parse(read.content.toString('utf8'));
    } catch {
      codes.push('semantic.evidence_fixture_malformed');
      continue;
    }
    const observed = await observeFixture(fixture, packageRoot);
    const digest = resultDigest(observed);
    observedById.set(binding.fixture_id, {fixture, observed, digest});
    if (digest !== binding.observable_result_sha256 || !isDeepStrictEqual(observed, fixture.expected)) {
      codes.push('semantic.evidence_observable_mismatch');
    }
  }

  const replay = evidence?.claims?.replay_snapshot_equivalence;
  const replayResults = replayFixtureIds.map((id) => observedById.get(id)?.observed);
  const replayStates = replayResults.map((result) => result?.outputs?.find((output) => output.startsWith('semantic_state:')));
  const replaySnapshots = replayResults.map((result) => result?.outputs?.find((output) => output.startsWith('semantic_snapshot:')));
  const parsedReplaySnapshots = replaySnapshots.map((snapshot) => {
    if (snapshot === undefined) return undefined;
    try {
      return JSON.parse(snapshot.slice('semantic_snapshot:'.length));
    } catch {
      return undefined;
    }
  });
  const replayHistories = parsedReplaySnapshots.map((snapshot) =>
    snapshot === undefined ? undefined : canonicalJson(snapshot.history));
  const probeRecord = observedById.get(replayFixtureIds[0])?.fixture?.subject?.document?.action?.records?.[0];
  const probeInputs = observedById.get(replayFixtureIds[0])?.fixture?.subject?.document?.initial?.bound_inputs ?? [];
  const probeResults = typeof probeRecord === 'string' && parsedReplaySnapshots.every((snapshot) => snapshot !== undefined)
    ? await Promise.all(parsedReplaySnapshots.map((snapshot) => replayRecords([probeRecord], snapshot, probeInputs, packageRoot)))
    : [];
  if (!sameOrder(replay?.fixture_ids, replayFixtureIds) || replayStates.some((state) => state === undefined) ||
      replaySnapshots.some((snapshot) => snapshot === undefined) || replayHistories.some((history) => history === undefined) ||
      replayStates[0] !== replayStates[1] || replaySnapshots[0] !== replaySnapshots[1] || replayHistories[0] !== replayHistories[1] ||
      sha256(replayStates[0] ?? '') !== replay?.semantic_state_sha256 ||
      sha256(replaySnapshots[0] ?? '') !== replay?.semantic_snapshot_sha256 ||
      sha256(replayHistories[0] ?? '') !== replay?.idempotency_history_sha256 ||
      probeResults.length !== 2 || probeResults.some(({code}) => code !== replay?.idempotency_probe_code)) {
    codes.push('semantic.evidence_replay_equivalence_invalid');
  }

  const rebuild = evidence?.claims?.rebuild_deterministic;
  const rebuildBinding = observedById.get('FIX-SK-POS-007');
  if (rebuild?.fixture_id !== 'FIX-SK-POS-007' || rebuildBinding === undefined) {
    codes.push('semantic.evidence_rebuild_invalid');
  } else {
    const repeated = await observeFixture(rebuildBinding.fixture, packageRoot);
    if (!isDeepStrictEqual(repeated, rebuildBinding.observed) || rebuild.observable_result_sha256 !== rebuildBinding.digest) {
      codes.push('semantic.evidence_rebuild_invalid');
    }
  }

  const crash = evidence?.claims?.crash_recovery;
  const crashDigests = crashFixtureIds.map((id) => observedById.get(id)?.digest);
  const crashResults = crashFixtureIds.map((id) => observedById.get(id)?.observed);
  if (!sameOrder(crash?.fixture_ids, crashFixtureIds) || !sameOrder(crash?.observable_result_sha256, crashDigests) ||
      crashResults[0]?.outputs?.includes('canonical_record:none') !== true ||
      crashResults[1]?.filesystem_effects?.includes('preserve canonical operation') !== true) {
    codes.push('semantic.evidence_crash_recovery_invalid');
  }

  const denials = evidence?.claims?.semantic_write_denials;
  const denialDigests = denialFixtureIds.map((id) => observedById.get(id)?.digest);
  const denialResults = denialFixtureIds.map((id) => observedById.get(id)?.observed);
  if (!sameOrder(denials?.fixture_ids, denialFixtureIds) || !sameOrder(denials?.observable_result_sha256, denialDigests) ||
      denialResults.some((result) => result?.codes?.[0] !== 'semantic.authority_denied' ||
        result.outputs?.includes('canonical_record:none') !== true || !isDeepStrictEqual(result.filesystem_effects, ['none']))) {
    codes.push('semantic.evidence_denial_invalid');
  }
  return codes;
}
