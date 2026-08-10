#!/usr/bin/env node

import {resolve} from 'node:path';

import {
  checkArtifactBindings,
  checkManifest,
  checkRequirements,
  checkSchemas,
  checkTransitionTable,
} from './package-checks.mjs';
import {readPackageFile, writePackageFile} from './safe-path.mjs';
import {checkSchemaInstances} from './schema-instances.mjs';
import {checkEvidence, checkTraceability, runConformance} from './traceability-checks.mjs';

function check(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

async function validate(packageRoot) {
  const boundaryCodes = [];
  const readJson = async (path, required = false) => {
    const read = await readPackageFile(packageRoot, path);
    if (read.status !== 'present') {
      if (read.status === 'absent' && !required) return null;
      const code = read.status === 'too_large'
        ? 'schema.resource_limit'
        : read.status === 'unsafe' ? 'artifact.path_unsafe' : 'schema.instance_missing';
      boundaryCodes.push(code);
      return null;
    }
    try {
      return JSON.parse(read.content.toString('utf8'));
    } catch {
      boundaryCodes.push('boundary.invalid_json');
      return null;
    }
  };

  const manifest = await readJson('package-manifest.yaml', true) ?? {};
  const requirements = await readJson('normative/requirements.json', true);
  const table = await readJson('contracts/transitions/package-lifecycle.json', true);
  const conformance = await readJson('conformance/manifest.yaml', true);
  const traceability = await readJson('traceability.yaml', true);
  const checks = [];
  if (boundaryCodes.length > 0) checks.push(check('boundary-inputs', boundaryCodes));
  checks.push(await checkManifest(packageRoot, manifest));
  checks.push((await checkArtifactBindings(packageRoot, manifest)).check);
  if (requirements !== null) checks.push(await checkRequirements(packageRoot, requirements));
  if (table !== null) checks.push(checkTransitionTable(table));
  checks.push(await checkSchemas(packageRoot));
  checks.push(await checkSchemaInstances(packageRoot, conformance ?? {fixtures: []}));
  if (traceability !== null) {
    checks.push(await checkTraceability(packageRoot, requirements ?? {requirements: []}, traceability, conformance ?? {fixtures: []}));
  }

  const conformanceResult = conformance === null
    ? {check: null, fixtureResults: []}
    : await runConformance(
      packageRoot,
      conformance,
      (Array.isArray(requirements?.requirements) ? requirements.requirements : []).map((entry) => entry?.id),
    );
  if (conformanceResult.check !== null) checks.push(conformanceResult.check);
  const evidencePaths = [
    'conformance/evidence/version-amendment-report.json',
    'conformance/evidence/recovery-report.json',
    'conformance/evidence/traceability-report.json',
  ];
  const evidenceReads = await Promise.all(evidencePaths.map((path) => readPackageFile(packageRoot, path)));
  if (evidenceReads.every(({status}) => status === 'present')) checks.push(...await checkEvidence(packageRoot));

  const verdict = checks.every(({verdict: checkVerdict}) => checkVerdict === 'pass') &&
    conformanceResult.fixtureResults.every(({verdict: fixtureVerdict}) => fixtureVerdict === 'pass')
    ? 'pass'
    : 'fail';
  return {
    schema_id: 'mdplace.validation-report/v1',
    package_series: typeof manifest.package_series === 'string' ? manifest.package_series : 'mdplace-spec/v1',
    release_version: typeof manifest.release_version === 'string' ? manifest.release_version : '1.0.0',
    validator_version: typeof manifest.validator_version === 'string' ? manifest.validator_version : '1.0.0',
    normative_digest: typeof manifest.normative_digest === 'string' ? manifest.normative_digest : '0'.repeat(64),
    verdict,
    checks,
    fixture_results: conformanceResult.fixtureResults,
  };
}

const arguments_ = process.argv.slice(2);
const packageRoot = resolve(arguments_.find((argument) => !argument.startsWith('--')) ?? 'mdplace-spec/v1');
const writeEvidence = arguments_.includes('--write-evidence');
let report;
try {
  report = await validate(packageRoot);
} catch (error) {
  report = {
    schema_id: 'mdplace.validation-report/v1', package_series: 'mdplace-spec/v1',
    release_version: '1.0.0', validator_version: '1.0.0', normative_digest: '0'.repeat(64),
    verdict: 'fail', checks: [check('validator-boundary', ['validator.deterministic_failure'])], fixture_results: [],
  };
  if (!(error instanceof Error)) throw error;
}
if (writeEvidence && report.verdict === 'pass') {
  const write = await writePackageFile(
    packageRoot,
    'conformance/evidence/validation-report.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (write.status !== 'written') {
    report = {
      ...report,
      verdict: 'fail',
      checks: [...report.checks, check('evidence-output', [
        write.status === 'too_large' ? 'schema.resource_limit' : 'artifact.path_unsafe',
      ])],
    };
  }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.verdict === 'pass' ? 0 : 1;
