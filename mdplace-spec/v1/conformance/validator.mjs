#!/usr/bin/env node

import {resolve} from 'node:path';

import {buildValidationReport, deterministicFailureReport} from './validation-report.mjs';

function check(id, codes) {
  const uniqueCodes = [...new Set(codes)];
  return {id, verdict: uniqueCodes.length === 0 ? 'pass' : 'fail', codes: uniqueCodes};
}

const arguments_ = process.argv.slice(2);
const options = arguments_.filter((argument) => argument.startsWith('--'));
const positionalArguments = arguments_.filter((argument) => !argument.startsWith('--'));
const packageRoot = resolve(positionalArguments[0] ?? 'mdplace-spec/v1');
let report;
if (options.length > 0 || positionalArguments.length > 1) {
  report = {
    ...deterministicFailureReport(),
    checks: [check('validator-arguments', ['validator.argument_unknown'])],
  };
} else {
  try {
    report = await buildValidationReport(packageRoot);
  } catch (error) {
    report = deterministicFailureReport();
    if (!(error instanceof Error)) throw error;
  }
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.verdict === 'pass' ? 0 : 1;
