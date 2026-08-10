import {isDeepStrictEqual} from 'node:util';

import {observeFixture} from './fixture-observer.mjs';
import {listPackageFiles, readPackageFile} from './safe-path.mjs';

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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

export async function checkTraceability(packageRoot, requirements, traceability, conformance) {
  const codes = [];
  const records = Array.isArray(traceability?.records) ? traceability.records : [];
  const requirementEntries = Array.isArray(requirements?.requirements) ? requirements.requirements : [];
  if (!Array.isArray(traceability?.records) || !Array.isArray(requirements?.requirements)) codes.push('schema.constraint');
  const requirementIds = requirementEntries.map((entry) => entry?.id);
  const tracedIds = records.map((record) => record?.requirement_id);
  if (!equalSets(requirementIds, tracedIds) || new Set(tracedIds).size !== tracedIds.length) {
    codes.push('traceability.untraced_requirement');
  }
  const decisionEntries = Array.isArray(traceability?.decisions) ? traceability.decisions : [];
  const decisions = new Map(decisionEntries.map((decision) => [decision?.decision_id, decision]));
  if (decisions.size !== decisionEntries.length) codes.push('traceability.duplicate_decision');
  const fixtureEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  const fixtures = new Map(fixtureEntries.map((fixture) => [fixture?.fixture_id, fixture]));
  for (const record of records) {
    if (!isRecord(record)) {
      codes.push('schema.constraint');
      continue;
    }
    const requirement = requirementEntries.find((entry) => entry?.id === record.requirement_id);
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
    for (const path of [...stringList(record.normative_anchors), ...stringList(record.schema_or_transition_refs)]) {
      const read = await readPackageFile(packageRoot, path.split('#')[0]);
      if (read.status !== 'present') codes.push(read.status === 'unsafe' ? 'traceability.path_invalid' : 'traceability.path_unresolved');
    }
    for (const fixtureId of stringList(record.positive_fixture_ids)) {
      const fixture = fixtures.get(fixtureId);
      if (fixture?.expected_verdict !== 'pass' || !fixture.requirement_ids?.includes(record.requirement_id)) {
        codes.push('traceability.positive_fixture_unresolved');
      }
    }
    for (const fixtureId of stringList(record.negative_fixture_ids)) {
      const fixture = fixtures.get(fixtureId);
      if (fixture?.expected_verdict !== 'fail' || !fixture.requirement_ids?.includes(record.requirement_id)) {
        codes.push('traceability.negative_fixture_unresolved');
      }
    }
    for (const path of stringList(record.evidence_refs)) {
      const isGeneratedReport = path === 'conformance/evidence/validation-report.json';
      if (!isGeneratedReport) {
        const read = await readPackageFile(packageRoot, path);
        if (read.status !== 'present') codes.push(read.status === 'unsafe' ? 'traceability.path_invalid' : 'traceability.evidence_unresolved');
      }
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
  const listing = await listPackageFiles(packageRoot);
  if (listing.status !== 'present') return [];
  return listing.paths
    .filter((path) => /^conformance\/(?:fixtures|scenarios)\/.+\.json$/.test(path))
    .map((path) => path.slice('conformance/'.length));
}

export async function runConformance(packageRoot, conformance, requirementIds) {
  const codes = [];
  const results = [];
  const entries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  if (!Array.isArray(conformance?.fixtures)) codes.push('schema.constraint');
  const ids = entries.map((entry) => entry?.fixture_id);
  const paths = entries.map((entry) => entry?.path);
  if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) codes.push('conformance.duplicate_fixture');
  if (conformance.required_categories !== undefined &&
      (!Array.isArray(conformance.required_categories) || [...requiredCategories].some((category) => !conformance.required_categories.includes(category) ||
        !entries.some((entry) => entry?.category === category)))) {
    codes.push('conformance.category_missing');
  }
  const actualPaths = await fixturePaths(packageRoot);
  if (!equalSets(paths, actualPaths)) codes.push('conformance.fixture_unlisted');
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || !/^(?:fixtures|scenarios)\/[a-z0-9][a-z0-9./-]*\.json$/.test(entry.path)) {
      codes.push('conformance.path_invalid');
      continue;
    }
    const read = await readPackageFile(packageRoot, `conformance/${entry.path}`);
    if (read.status !== 'present') {
      codes.push(read.status === 'unsafe' ? 'conformance.path_invalid' : 'conformance.fixture_unresolved');
      continue;
    }
    let fixture;
    try {
      fixture = JSON.parse(read.content.toString('utf8'));
    } catch {
      codes.push('boundary.invalid_json');
      continue;
    }
    if (!isRecord(fixture) || !isRecord(fixture.expected)) {
      codes.push('schema.constraint');
      results.push({id: entry.fixture_id, verdict: 'fail', codes: ['fixture.schema_invalid']});
      continue;
    }
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
  const readJson = async (path) => {
    const read = await readPackageFile(packageRoot, path);
    if (read.status !== 'present') return null;
    try {
      return JSON.parse(read.content.toString('utf8'));
    } catch {
      return null;
    }
  };
  const versionFixture = await readJson('conformance/fixtures/negative/mutable-release-content.json');
  const versionReport = await readJson('conformance/evidence/version-amendment-report.json');
  if (versionFixture === null || versionReport === null) {
    return [
      result('version-amendment-evidence', ['evidence.version_amendment_mismatch']),
      result('recovery-evidence', ['evidence.recovery_mismatch']),
      result('traceability-evidence', ['evidence.traceability_mismatch']),
    ];
  }
  const versionMatches = versionReport.fixture_id === versionFixture.fixture_id &&
    versionReport.source_release.version === versionFixture.subject.source_version &&
    versionReport.source_release.digest === versionFixture.subject.source_digest &&
    versionReport.source_release.path === versionFixture.subject.source_path &&
    versionReport.attempted_change.version === versionFixture.subject.target_version &&
    versionReport.attempted_change.digest === versionFixture.subject.target_digest &&
    versionReport.attempted_change.path === versionFixture.subject.target_path &&
    versionReport.verdict === versionFixture.expected.verdict &&
    versionReport.code === versionFixture.expected.codes[0] && versionReport.source_preserved === true;
  const recoveryFixture = await readJson('conformance/scenarios/crash-recovery.json');
  const recoveryReport = await readJson('conformance/evidence/recovery-report.json');
  if (recoveryFixture === null || recoveryReport === null) {
    return [
      result('version-amendment-evidence', versionMatches ? [] : ['evidence.version_amendment_mismatch']),
      result('recovery-evidence', ['evidence.recovery_mismatch']),
      result('traceability-evidence', ['evidence.traceability_mismatch']),
    ];
  }
  const recoveryMatches = recoveryReport.fixture_id === recoveryFixture.fixture_id &&
    recoveryReport.source_state === recoveryFixture.subject.source_state &&
    recoveryReport.source_digest === recoveryFixture.subject.source_digest &&
    recoveryReport.crash_point === recoveryFixture.subject.crash_point &&
    isDeepStrictEqual(recoveryReport.operations, recoveryFixture.expected.operations) &&
    isDeepStrictEqual(recoveryReport.receipts, recoveryFixture.expected.receipts) &&
    isDeepStrictEqual(recoveryReport.filesystem_effects, recoveryFixture.expected.filesystem_effects) &&
    recoveryReport.terminal_state === recoveryFixture.expected.terminal_state &&
    recoveryReport.source_preserved === true && recoveryReport.verdict === 'pass';
  const manifest = await readJson('package-manifest.yaml');
  const requirements = await readJson('normative/requirements.json');
  const traceability = await readJson('traceability.yaml');
  const traceabilityReport = await readJson('conformance/evidence/traceability-report.json');
  const requirementIds = Array.isArray(requirements?.requirements)
    ? requirements.requirements.map(({id}) => id)
    : [];
  const tracedIds = Array.isArray(traceability?.records)
    ? traceability.records.map(({requirement_id: id}) => id)
    : [];
  const unresolved = requirementIds.filter((id) => !tracedIds.includes(id));
  const traceabilityMatches = traceabilityReport?.schema_id === 'mdplace.traceability-report/v1' &&
    traceabilityReport.package_series === manifest?.package_series &&
    traceabilityReport.release_version === manifest?.release_version &&
    traceabilityReport.validator_version === manifest?.validator_version &&
    traceabilityReport.normative_digest === manifest?.normative_digest &&
    traceabilityReport.requirements_total === requirementIds.length &&
    traceabilityReport.records_total === tracedIds.length &&
    isDeepStrictEqual(traceabilityReport.unresolved_requirement_ids, unresolved) &&
    traceabilityReport.verdict === (unresolved.length === 0 ? 'pass' : 'fail');
  return [
    result('version-amendment-evidence', versionMatches ? [] : ['evidence.version_amendment_mismatch']),
    result('recovery-evidence', recoveryMatches ? [] : ['evidence.recovery_mismatch']),
    result('traceability-evidence', traceabilityMatches ? [] : ['evidence.traceability_mismatch']),
  ];
}
