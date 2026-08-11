import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';
import {readPackageFile} from './safe-path.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'schema-instances', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

export async function checkSchemaInstances(packageRoot, conformance) {
  const codes = [];
  const bindings = [
    ['package-manifest.yaml', 'contracts/schemas/package-manifest.schema.json'],
    ['conformance/state-observations/draft/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/candidate/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/release-ready/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['conformance/state-observations/released/package-manifest.yaml', 'contracts/schemas/package-state-observation.schema.json'],
    ['normative/requirements.json', 'contracts/schemas/requirements.schema.json'],
    ['contracts/transitions/package-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/transitions/evidence-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['contracts/validator-extensions.json', 'contracts/schemas/validator-extension-registry.schema.json'],
    ['contracts/verdicts/validator-verdicts.json', 'contracts/schemas/verdict-table.schema.json'],
    ['conformance/manifest.yaml', 'contracts/schemas/conformance-manifest.schema.json'],
    ['traceability.yaml', 'contracts/schemas/traceability.schema.json'],
    ['claims-and-evidence.yaml', 'contracts/schemas/claims-and-evidence.schema.json'],
    ['conformance/evidence/invocations/validator-evidence-reference.json', 'contracts/schemas/validator-invocation.schema.json'],
    ['conformance/evidence/envelopes/validator-evidence-reference.json', 'contracts/schemas/evidence-envelope.schema.json'],
    ['conformance/evidence/evidence-recovery-report.json', 'contracts/schemas/evidence-recovery-report.schema.json'],
  ];
  const fixtureEntries = Array.isArray(conformance?.fixtures) ? conformance.fixtures : [];
  for (const entry of fixtureEntries) {
    if (typeof entry?.path === 'string') {
      bindings.push([`conformance/${entry.path}`, 'contracts/schemas/conformance-fixture.schema.json']);
    }
  }
  const claimsRead = await readPackageFile(packageRoot, 'claims-and-evidence.yaml');
  if (claimsRead.status === 'present') {
    try {
      const claims = JSON.parse(claimsRead.content.toString('utf8'));
      for (const entry of claims.claims ?? []) {
        if (typeof entry.manifest_ref === 'string') {
          bindings.push([entry.manifest_ref, 'contracts/schemas/claim-manifest.schema.json']);
        }
      }
    } catch {
      codes.push('boundary.invalid_json');
    }
  }
  for (const [instancePath, schemaPath] of bindings) {
    const [instanceRead, schemaRead] = await Promise.all([
      readPackageFile(packageRoot, instancePath),
      readPackageFile(packageRoot, schemaPath),
    ]);
    if (schemaRead.status !== 'present') {
      codes.push('schema.required_artifact');
      continue;
    }
    if (instanceRead.status !== 'present') {
      codes.push(instanceRead.status === 'too_large' ? 'schema.resource_limit' : 'schema.instance_missing');
      continue;
    }
    let value;
    try {
      value = JSON.parse(instanceRead.content.toString('utf8'));
    } catch {
      codes.push('boundary.invalid_json');
      continue;
    }
    const errors = await validateAgainstSchemaPath(packageRoot, schemaPath, value);
    const code = schemaErrorCode(errors);
    if (code !== null) codes.push(code);
  }
  return result(codes);
}
