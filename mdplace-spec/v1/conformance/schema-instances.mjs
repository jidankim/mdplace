import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

import {schemaErrorCode, validateAgainstSchemaPath} from './json-schema.mjs';

function result(codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id: 'schema-instances', verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

export async function checkSchemaInstances(packageRoot, conformance) {
  const codes = [];
  const bindings = [
    ['package-manifest.yaml', 'contracts/schemas/package-manifest.schema.json'],
    ['normative/requirements.json', 'contracts/schemas/requirements.schema.json'],
    ['contracts/transitions/package-lifecycle.json', 'contracts/schemas/transition-table.schema.json'],
    ['conformance/manifest.yaml', 'contracts/schemas/conformance-manifest.schema.json'],
    ['traceability.yaml', 'contracts/schemas/traceability.schema.json'],
    ['conformance/evidence/validation-report.json', 'contracts/schemas/validation-report.schema.json'],
    ['conformance/evidence/version-amendment-report.json', 'contracts/schemas/version-amendment-report.schema.json'],
    ['conformance/evidence/recovery-report.json', 'contracts/schemas/recovery-report.schema.json'],
  ];
  for (const entry of conformance.fixtures ?? []) {
    bindings.push([`conformance/${entry.path}`, 'contracts/schemas/conformance-fixture.schema.json']);
  }
  for (const [instancePath, schemaPath] of bindings) {
    const target = resolve(packageRoot, instancePath);
    if (!existsSync(target) || !existsSync(resolve(packageRoot, schemaPath))) continue;
    const value = JSON.parse(await readFile(target, 'utf8'));
    const errors = await validateAgainstSchemaPath(packageRoot, schemaPath, value);
    const code = schemaErrorCode(errors);
    if (code !== null) codes.push(code);
  }
  return result(codes);
}
