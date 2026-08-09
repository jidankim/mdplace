import {existsSync} from 'node:fs';
import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

import {observeFixture} from './fixture-observer.mjs';

const requiredCategories = new Set([
  'positive',
  'negative',
  'exact_boundary',
  'stale_state',
  'authority_denial',
  'illegal_transition',
  'crash_recovery',
]);

function result(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

function equalSets(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function checkTraceability(packageRoot, requirements, traceability, conformance) {
  const codes = [];
  const records = traceability.records ?? [];
  const requirementEntries = requirements.requirements ?? [];
  const requirementIds = requirementEntries.map(({id}) => id);
  const tracedIds = records.map(({requirement_id: requirementId}) => requirementId);
  if (!equalSets(requirementIds, tracedIds) || new Set(tracedIds).size !== tracedIds.length) {
    codes.push('traceability.untraced_requirement');
  }
  const decisionEntries = traceability.decisions ?? [];
  const decisions = new Map(decisionEntries.map((decision) => [decision.decision_id, decision]));
  if (decisions.size !== decisionEntries.length) codes.push('traceability.duplicate_decision');
  const fixtures = new Map((conformance.fixtures ?? []).map((fixture) => [fixture.fixture_id, fixture]));
  for (const record of records) {
    const requirement = requirementEntries.find(({id}) => id === record.requirement_id);
    if (requirement === undefined) {
      codes.push('traceability.unknown_requirement');
      continue;
    }
    if (!equalSets(record.canonical_terms ?? [], requirement.canonical_terms ?? []) ||
        !(record.normative_anchors ?? []).includes(requirement.normative_anchor) ||
        record.acceptance_gate !== requirement.acceptance_gate || record.scope !== requirement.scope) {
      codes.push('traceability.requirement_mismatch');
    }
    if ((record.decision_ids ?? []).some((decisionId) => !decisions.has(decisionId))) {
      codes.push('traceability.decision_unresolved');
    }
    for (const path of [...record.normative_anchors ?? [], ...record.schema_or_transition_refs ?? []]) {
      if (!existsSync(resolve(packageRoot, path.split('#')[0]))) codes.push('traceability.path_unresolved');
    }
    for (const fixtureId of record.positive_fixture_ids ?? []) {
      const fixture = fixtures.get(fixtureId);
      if (fixture?.expected_verdict !== 'pass' || !fixture.requirement_ids?.includes(record.requirement_id)) {
        codes.push('traceability.positive_fixture_unresolved');
      }
    }
    for (const fixtureId of record.negative_fixture_ids ?? []) {
      const fixture = fixtures.get(fixtureId);
      if (fixture?.expected_verdict !== 'fail' || !fixture.requirement_ids?.includes(record.requirement_id)) {
        codes.push('traceability.negative_fixture_unresolved');
      }
    }
    for (const path of record.evidence_refs ?? []) {
      const isGeneratedReport = path === 'conformance/evidence/validation-report.json';
      if (!isGeneratedReport && !existsSync(resolve(packageRoot, path))) codes.push('traceability.evidence_unresolved');
    }
  }
  const acceptedDecision = decisions.get('DEC-010');
  if (acceptedDecision?.url !== 'https://github.com/jidankim/mdplace/issues/10#issuecomment-5186946153' ||
      acceptedDecision?.status !== 'accepted' || acceptedDecision?.use !== 'input_without_reopening') {
    codes.push('traceability.decision_invalid');
  }
  return result('traceability', codes);
}

async function fixturePaths(packageRoot) {
  const paths = [];
  for (const directory of ['fixtures', 'scenarios']) {
    const root = resolve(packageRoot, 'conformance', directory);
    if (!existsSync(root)) continue;
    const visit = async (current) => {
      for (const entry of await readdir(current, {withFileTypes: true})) {
        const path = resolve(current, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith('.json')) {
          paths.push(path.slice(resolve(packageRoot, 'conformance').length + 1));
        }
      }
    };
    await visit(root);
  }
  return paths;
}

export async function runConformance(packageRoot, conformance, requirementIds) {
  const codes = [];
  const results = [];
  const entries = conformance.fixtures ?? [];
  const ids = entries.map(({fixture_id: fixtureId}) => fixtureId);
  const paths = entries.map(({path}) => path);
  if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) codes.push('conformance.duplicate_fixture');
  if (conformance.required_categories !== undefined &&
      [...requiredCategories].some((category) => !conformance.required_categories.includes(category) ||
        !entries.some((entry) => entry.category === category))) {
    codes.push('conformance.category_missing');
  }
  const actualPaths = await fixturePaths(packageRoot);
  if (!equalSets(paths, actualPaths)) codes.push('conformance.fixture_unlisted');
  for (const entry of entries) {
    const fixture = JSON.parse(await readFile(resolve(packageRoot, 'conformance', entry.path), 'utf8'));
    if (entry.fixture_id !== fixture.fixture_id ||
        (entry.category !== undefined && entry.category !== fixture.category) ||
        entry.expected_verdict !== fixture.expected.verdict ||
        (entry.requirement_ids !== undefined && fixture.requirement_ids !== undefined &&
          !equalSets(entry.requirement_ids, fixture.requirement_ids)) ||
        (requirementIds.length > 0 && entry.requirement_ids?.some((requirementId) => !requirementIds.includes(requirementId)))) {
      codes.push('conformance.manifest_mismatch');
    }
    const assertionKeys = ['inputs', 'outputs', 'operations', 'receipts', 'filesystem_effects', 'terminal_state'];
    if (entry.observable_assertions !== undefined &&
        assertionKeys.some((key) => entry.observable_assertions[key] !== true)) {
      codes.push('conformance.observable_assertion_missing');
    }
    if (entry.observable_assertions !== undefined &&
        entry.observable_assertions.illegal_transition !== fixture.expected.illegal_transition) {
      codes.push('conformance.observable_assertion_mismatch');
    }
    const observed = await observeFixture(fixture, packageRoot);
    const matches = isDeepStrictEqual(observed, fixture.expected);
    results.push({id: fixture.fixture_id, verdict: matches ? 'pass' : 'fail', codes: matches ? [] : ['fixture.oracle_mismatch']});
  }
  return {check: result('conformance-manifest', codes), fixtureResults: results};
}

export async function checkEvidence(packageRoot) {
  const versionFixture = JSON.parse(await readFile(resolve(packageRoot, 'conformance/fixtures/negative/mutable-release-content.json'), 'utf8'));
  const versionReport = JSON.parse(await readFile(resolve(packageRoot, 'conformance/evidence/version-amendment-report.json'), 'utf8'));
  const versionMatches = versionReport.fixture_id === versionFixture.fixture_id &&
    versionReport.source_release.version === versionFixture.subject.source_version &&
    versionReport.source_release.digest === versionFixture.subject.source_digest &&
    versionReport.source_release.path === versionFixture.subject.source_path &&
    versionReport.attempted_change.version === versionFixture.subject.target_version &&
    versionReport.attempted_change.digest === versionFixture.subject.target_digest &&
    versionReport.attempted_change.path === versionFixture.subject.target_path &&
    versionReport.verdict === versionFixture.expected.verdict &&
    versionReport.code === versionFixture.expected.codes[0] && versionReport.source_preserved === true;
  const recoveryFixture = JSON.parse(await readFile(resolve(packageRoot, 'conformance/scenarios/crash-recovery.json'), 'utf8'));
  const recoveryReport = JSON.parse(await readFile(resolve(packageRoot, 'conformance/evidence/recovery-report.json'), 'utf8'));
  const recoveryMatches = recoveryReport.fixture_id === recoveryFixture.fixture_id &&
    recoveryReport.source_state === recoveryFixture.subject.source_state &&
    recoveryReport.source_digest === recoveryFixture.subject.source_digest &&
    recoveryReport.crash_point === recoveryFixture.subject.crash_point &&
    isDeepStrictEqual(recoveryReport.operations, recoveryFixture.expected.operations) &&
    isDeepStrictEqual(recoveryReport.receipts, recoveryFixture.expected.receipts) &&
    isDeepStrictEqual(recoveryReport.filesystem_effects, recoveryFixture.expected.filesystem_effects) &&
    recoveryReport.terminal_state === recoveryFixture.expected.terminal_state &&
    recoveryReport.source_preserved === true && recoveryReport.verdict === 'pass';
  return [
    result('version-amendment-evidence', versionMatches ? [] : ['evidence.version_amendment_mismatch']),
    result('recovery-evidence', recoveryMatches ? [] : ['evidence.recovery_mismatch']),
  ];
}
