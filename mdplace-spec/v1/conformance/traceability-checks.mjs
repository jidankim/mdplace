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

function markdownAnchor(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function fragmentResolves(path, fragment, content) {
  if (fragment === '') return true;
  let decoded;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return false;
  }
  if (path.endsWith('.md')) {
    return content.split(/\r?\n/)
      .filter((line) => /^#{1,6}\s+/.test(line))
      .map((line) => markdownAnchor(line.replace(/^#{1,6}\s+/, '')))
      .includes(decoded);
  }
  if (!path.endsWith('.json') && !path.endsWith('.yaml')) return false;
  let document;
  try {
    document = JSON.parse(content);
  } catch {
    return false;
  }
  if (!decoded.startsWith('/')) return false;
  try {
    decoded.slice(1).split('/').reduce((node, token) => {
      const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
      if ((node === null || typeof node !== 'object') || !Object.hasOwn(node, key)) throw new Error();
      return node[key];
    }, document);
    return true;
  } catch {
    return false;
  }
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
    const [, requirementFragment = ''] = typeof requirement.normative_anchor === 'string'
      ? requirement.normative_anchor.split('#', 2)
      : [];
    const expectedRequirementFragment = typeof requirement.title === 'string'
      ? markdownAnchor(`${requirement.id}: ${requirement.title}`)
      : '';
    if (!equalSets(record.canonical_terms ?? [], requirement.canonical_terms ?? []) ||
        !(record.normative_anchors ?? []).includes(requirement.normative_anchor) ||
        requirementFragment !== expectedRequirementFragment ||
        record.acceptance_gate !== requirement.acceptance_gate || record.scope !== requirement.scope) {
      codes.push('traceability.requirement_mismatch');
    }
    if ((record.decision_ids ?? []).some((decisionId) => !decisions.has(decisionId))) {
      codes.push('traceability.decision_unresolved');
    }
    for (const reference of [...stringList(record.normative_anchors), ...stringList(record.schema_or_transition_refs)]) {
      const [path, fragment = ''] = reference.split('#', 2);
      const read = await readPackageFile(packageRoot, path);
      if (read.status !== 'present') {
        codes.push(read.status === 'unsafe' ? 'traceability.path_invalid' : 'traceability.path_unresolved');
      } else if (!fragmentResolves(path, fragment, read.content.toString('utf8'))) {
        codes.push('traceability.anchor_unresolved');
      }
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

export async function runConformance(packageRoot, conformance, requirementIds, options = {}) {
  const codes = [];
  const results = [];
  const coveredIllegalPairs = new Set();
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
    if (entry.category === 'illegal_transition' && fixture.category === 'illegal_transition' &&
        fixture.expected.illegal_transition === true && fixture.subject?.kind === 'transition') {
      coveredIllegalPairs.add(`${fixture.subject.from_state}:${fixture.subject.command}`);
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
    const observed = await observeFixture(fixture, packageRoot, options);
    const matches = isDeepStrictEqual(observed, fixture.expected);
    results.push({id: fixture.fixture_id, verdict: matches ? 'pass' : 'fail', codes: matches ? [] : ['fixture.oracle_mismatch']});
  }
  const tableRead = await readPackageFile(packageRoot, 'contracts/transitions/package-lifecycle.json');
  if (tableRead.status === 'present') {
    try {
      const table = JSON.parse(tableRead.content.toString('utf8'));
      const deniedPairs = (Array.isArray(table.transitions) ? table.transitions : [])
        .filter(({allowed}) => allowed === false)
        .map(({from_state: state, command_or_event: command}) => `${state}:${command}`);
      if (deniedPairs.some((pair) => !coveredIllegalPairs.has(pair))) {
        codes.push('conformance.illegal_transition_uncovered');
      }
    } catch {
      codes.push('boundary.invalid_json');
    }
  }
  return {check: result('conformance-manifest', codes), fixtureResults: results};
}
