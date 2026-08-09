#!/usr/bin/env node

import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {
  checkArtifactBindings,
  checkManifest,
  checkRequirements,
  checkSchemas,
  checkTransitionTable,
} from './package-checks.mjs';
import {checkEvidence, checkTraceability, runConformance} from './traceability-checks.mjs';
import {checkSchemaInstances} from './schema-instances.mjs';

const arguments_ = process.argv.slice(2);
const packageRoot = resolve(arguments_.find((argument) => !argument.startsWith('--')) ?? 'mdplace-spec/v1');
const writeEvidence = arguments_.includes('--write-evidence');
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package-manifest.yaml'), 'utf8'));
const checks = [checkManifest(packageRoot, manifest)];
const {check: artifactCheck} = await checkArtifactBindings(packageRoot, manifest);
checks.push(artifactCheck);

const requirementsPath = resolve(packageRoot, 'normative/requirements.json');
let requirements = {requirements: []};
if (existsSync(requirementsPath)) {
  requirements = JSON.parse(await readFile(requirementsPath, 'utf8'));
  checks.push(await checkRequirements(packageRoot, requirements));
}

const transitionPath = resolve(packageRoot, 'contracts/transitions/package-lifecycle.json');
if (existsSync(transitionPath)) {
  const table = JSON.parse(await readFile(transitionPath, 'utf8'));
  checks.push(checkTransitionTable(table));
}
const schemasPath = resolve(packageRoot, 'contracts/schemas');
if (existsSync(schemasPath)) checks.push(await checkSchemas(packageRoot));

const conformancePath = resolve(packageRoot, 'conformance/manifest.yaml');
const conformance = existsSync(conformancePath)
  ? JSON.parse(await readFile(conformancePath, 'utf8'))
  : {fixtures: []};
if (existsSync(schemasPath)) checks.push(await checkSchemaInstances(packageRoot, conformance));
const traceabilityPath = resolve(packageRoot, 'traceability.yaml');
if (existsSync(traceabilityPath)) {
  const traceability = JSON.parse(await readFile(traceabilityPath, 'utf8'));
  checks.push(checkTraceability(packageRoot, requirements, traceability, conformance));
}

const fixtureResults = [];
if (existsSync(conformancePath)) {
  const conformanceResult = await runConformance(
    packageRoot,
    conformance,
    requirements.requirements.map(({id}) => id),
  );
  checks.push(conformanceResult.check);
  fixtureResults.push(...conformanceResult.fixtureResults);
}

const versionEvidencePath = resolve(packageRoot, 'conformance/evidence/version-amendment-report.json');
const recoveryEvidencePath = resolve(packageRoot, 'conformance/evidence/recovery-report.json');
if (existsSync(versionEvidencePath) && existsSync(recoveryEvidencePath)) {
  checks.push(...await checkEvidence(packageRoot));
}

const verdict = checks.every(({verdict: checkVerdict}) => checkVerdict === 'pass') &&
  fixtureResults.every(({verdict: fixtureVerdict}) => fixtureVerdict === 'pass')
  ? 'pass'
  : 'fail';
const report = {
  schema_id: 'mdplace.validation-report/v1',
  package_series: manifest.package_series,
  release_version: manifest.release_version,
  validator_version: manifest.validator_version,
  normative_digest: manifest.normative_digest,
  verdict,
  checks,
  fixture_results: fixtureResults,
};

if (writeEvidence && report.verdict === 'pass') {
  const reportPath = resolve(packageRoot, manifest.conformance.report);
  await mkdir(resolve(reportPath, '..'), {recursive: true});
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.verdict === 'pass' ? 0 : 1;
