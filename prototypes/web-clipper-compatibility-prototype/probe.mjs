#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import {CdpClient, evaluate, findTarget} from './cdp.mjs';
import {injectFileText} from './probe-expression.mjs';

const targetType = process.argv[2] ?? 'service_worker';
let expression = process.argv[3];
const targetUrlPrefix = process.argv[4] ?? process.env.TARGET_URL_PREFIX;
const debugBase = process.argv[5] ?? process.env.CHROME_DEBUG_BASE ?? 'http://127.0.0.1:9228';
const inputFile = process.argv[6];

if (!expression) {
  console.error('usage: node probe.mjs <target-type> <expression> [target-url-prefix] [debug-base] [input-file]');
  process.exit(2);
}

if (inputFile) {
  expression = injectFileText(expression, await readFile(inputFile, 'utf8'));
}

const target = await findTarget(
  debugBase,
  (candidate) => candidate.type === targetType && (!targetUrlPrefix || candidate.url.startsWith(targetUrlPrefix)),
  `${targetType} probe target`,
);
const client = new CdpClient(target.webSocketDebuggerUrl);

try {
  if (expression.startsWith('@')) {
    const command = JSON.parse(expression.slice(1));
    console.log(JSON.stringify(await client.send(command.method, command.params), null, 2));
  } else {
    console.log(JSON.stringify(await evaluate(client, expression), null, 2));
  }
} finally {
  client.close();
}
