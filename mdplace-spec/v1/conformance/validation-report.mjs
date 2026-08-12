import {
  checkArtifactBindings,
  checkManifest,
  checkRequirements,
  checkSchemas,
  checkTransitionTable,
} from './package-checks.mjs';
import {checkControlPlaneContract} from './control-plane-checks.mjs';
import {readPackageFile} from './safe-path.mjs';
import {checkSchemaInstances} from './schema-instances.mjs';
import {checkSemanticKernelContract} from './semantic-kernel-checks.mjs';
import {checkTraceability, runConformance} from './traceability-checks.mjs';
import {checkValidatorEvidence} from './validator-evidence-checks.mjs';

function check(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

export async function buildValidationReport(packageRoot, options = {}) {
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
  const evidenceTable = await readJson('contracts/transitions/evidence-lifecycle.json', true);
  const semanticKernelTable = await readJson('contracts/transitions/semantic-kernel-lifecycle.json', true);
  const conformance = await readJson('conformance/manifest.yaml', true);
  const traceability = await readJson('traceability.yaml', true);
  const checks = [];
  if (boundaryCodes.length > 0) checks.push(check('boundary-inputs', boundaryCodes));
  checks.push(await checkManifest(packageRoot, manifest));
  checks.push((await checkArtifactBindings(packageRoot, manifest)).check);
  if (requirements !== null) checks.push(await checkRequirements(packageRoot, requirements));
  if (table !== null) checks.push(checkTransitionTable(table));
  if (evidenceTable !== null) checks.push(checkTransitionTable(evidenceTable, 'evidence-lifecycle'));
  if (semanticKernelTable !== null) checks.push(checkTransitionTable(semanticKernelTable, 'semantic-kernel-lifecycle'));
  checks.push(await checkSchemas(packageRoot));
  checks.push(await checkSchemaInstances(packageRoot, conformance ?? {fixtures: []}));
  checks.push(await checkValidatorEvidence(packageRoot));
  checks.push(await checkSemanticKernelContract(packageRoot, manifest, conformance, traceability));
  checks.push(await checkControlPlaneContract(packageRoot, manifest, conformance, traceability));
  if (traceability !== null) {
    checks.push(await checkTraceability(
      packageRoot,
      requirements ?? {requirements: []},
      traceability,
      conformance ?? {fixtures: []},
    ));
  }

  const requirementIds = (Array.isArray(requirements?.requirements) ? requirements.requirements : [])
    .map((entry) => entry?.id);
  const conformanceResult = conformance === null
    ? {check: null, fixtureResults: []}
    : await runConformance(packageRoot, conformance, requirementIds, options);
  if (conformanceResult.check !== null) checks.push(conformanceResult.check);
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
    conformance_digest: typeof manifest.conformance_digest === 'string' ? manifest.conformance_digest : '0'.repeat(64),
    verdict,
    checks,
    fixture_results: conformanceResult.fixtureResults,
  };
}

export function deterministicFailureReport() {
  return {
    schema_id: 'mdplace.validation-report/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_version: '1.0.0',
    normative_digest: '0'.repeat(64),
    conformance_digest: '0'.repeat(64),
    verdict: 'fail',
    checks: [check('validator-boundary', ['validator.deterministic_failure'])],
    fixture_results: [],
  };
}
