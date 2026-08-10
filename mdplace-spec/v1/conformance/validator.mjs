#!/usr/bin/env node

import {resolve} from 'node:path';

import {writePackageFile} from './safe-path.mjs';
import {buildValidationReport, deterministicFailureReport} from './validation-report.mjs';

function check(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

const arguments_ = process.argv.slice(2);
const packageRoot = resolve(arguments_.find((argument) => !argument.startsWith('--')) ?? 'mdplace-spec/v1');
const writeEvidence = arguments_.includes('--write-evidence');
let report;
try {
  report = await buildValidationReport(packageRoot);
} catch (error) {
  report = deterministicFailureReport();
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
