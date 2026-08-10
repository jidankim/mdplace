import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import {validatePackage} from './validator-test-support.mjs';
import {extensionId, schemaFor, validatorVersion} from './validator-evidence-support.mjs';

export async function runExtensionFixture({
  fixtureId,
  extension = extensionId,
  schemaPath,
  subjectSchemas = [schemaPath],
  document,
  oracle,
  extraFiles = {},
}) {
  const defaultFiles = {
    'contracts/verdicts/validator-verdicts.json': await readFile(
      new URL('../contracts/verdicts/validator-verdicts.json', import.meta.url),
      'utf8',
    ),
    'normative/requirements.json': await readFile(
      new URL('../normative/requirements.json', import.meta.url),
      'utf8',
    ),
  };
  const fixture = {
    $schema: '../../contracts/schemas/conformance-fixture.schema.json',
    schema_id: 'mdplace.conformance-fixture/v1',
    fixture_id: fixtureId,
    category: 'negative',
    requirement_ids: ['REQ-VAL-002'],
    subject: {kind: 'extension', extension_id: extension, schema: schemaPath, document},
    expected: oracle,
  };
  const conformance = {
    fixtures: [{
      fixture_id: fixtureId,
      path: `fixtures/${fixtureId.toLowerCase()}.json`,
      category: fixture.category,
      requirement_ids: fixture.requirement_ids,
      expected_verdict: oracle.verdict,
      observable_assertions: {
        inputs: true,
        outputs: true,
        operations: true,
        receipts: true,
        filesystem_effects: true,
        terminal_state: true,
        illegal_transition: oracle.illegal_transition,
      },
    }],
  };
  const registry = {
    schema_id: 'mdplace.validator-extension-registry/v1',
    package_series: 'mdplace-spec/v1',
    release_version: '1.0.0',
    validator_version: validatorVersion,
    extensions: [{
      extension_id: extensionId,
      validator_id: 'mdplace.package-validator',
      validator_version: validatorVersion,
      subject_schemas: subjectSchemas,
    }],
  };
  const result = await validatePackage({
    'package-manifest.yaml': {validator_version: validatorVersion},
    'contracts/validator-extensions.json': registry,
    [schemaPath]: schemaFor(document),
    'conformance/manifest.yaml': conformance,
    [`conformance/fixtures/${fixtureId.toLowerCase()}.json`]: fixture,
    ...defaultFiles,
    ...extraFiles,
  });
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.fixture_results, [{id: fixtureId, verdict: 'pass', codes: []}]);
}
