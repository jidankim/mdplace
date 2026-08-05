#!/usr/bin/env node

import {readFile} from 'node:fs/promises';

const targetType = process.argv[2] ?? 'service_worker';
let expression = process.argv[3];
const targetUrlPrefix = process.argv[4] ?? process.env.TARGET_URL_PREFIX;
const debugBase = process.argv[5] ?? process.env.CHROME_DEBUG_BASE ?? 'http://127.0.0.1:9226';
const inputFile = process.argv[6];

if (!expression) {
  console.error('usage: node probe.mjs <target-type> <expression> [target-url-prefix] [debug-base] [input-file]');
  process.exit(2);
}

if (inputFile) {
  expression = expression.replace('__FILE_TEXT__', JSON.stringify(await readFile(inputFile, 'utf8')));
}

const targets = await fetch(`${debugBase}/json/list`).then((response) => {
  if (!response.ok) throw new Error(`target discovery failed: HTTP ${response.status}`);
  return response.json();
});
const target = targets.find((candidate) =>
  candidate.type === targetType && (!targetUrlPrefix || candidate.url.startsWith(targetUrlPrefix))
);
if (!target) throw new Error(`no ${targetType} target found`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
const opened = new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, {once: true});
  socket.addEventListener('error', reject, {once: true});
});
await opened;

let sequence = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const {resolve, reject} = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({id, method, params}));
  return new Promise((resolve, reject) => pending.set(id, {resolve, reject}));
}

if (expression.startsWith('@')) {
  const command = JSON.parse(expression.slice(1));
  console.log(JSON.stringify(await send(command.method, command.params), null, 2));
} else {
  const evaluation = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text);
  }

  console.log(JSON.stringify(evaluation.result.value, null, 2));
}
socket.close();
