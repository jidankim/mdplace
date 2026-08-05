import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {inspectCandidate, inspectProperties} from './candidate-contract.mjs';
import {CdpClient, closeTarget, findTarget} from './cdp.mjs';
import {classifyCaptureState} from './clipper-popup.mjs';
import {injectFileText} from './probe-expression.mjs';

const withheldTemplate = 'mdplace-web-clipper-candidate-url-withheld';

function candidate(markers, {
  captureTemplate = withheldTemplate,
  extraBody = '',
  extraFrontmatter = '',
  plainStrings = false,
  timestamp = '"2026-08-05T12:34:56.789Z"',
  warning = '> [!warning] CAPTURE CANDIDATE — NOT A NOTE\n> Untrusted local intake. Not valid for placement or processing.',
} = {}) {
  const stringValue = (value) => plainStrings ? value : `"${value}"`;
  return `---
mdplace_candidate_schema: ${stringValue('mdplace.capture-candidate/v1')}
capture_source: ${stringValue('obsidian_web_clipper')}
source_version_claim: ${stringValue('1.7.0')}
source_version_verified: false
capture_template: ${stringValue(captureTemplate)}
capture_template_version: "1"
source_captured_at_claim: ${timestamp}${extraFrontmatter}
---
${warning}

${markers.join('\n')}${extraBody ? `\n${extraBody.trimEnd()}` : ''}
`;
}

const validWithheldMarkers = [
  '<!-- mdplace:candidate:v1:start -->',
  '<!-- mdplace:candidate:live-selection:absent -->',
  '<!-- mdplace:candidate:source-url:withheld-by-policy -->',
  '<!-- mdplace:candidate:source-title-raw:start -->',
  'Fixture title',
  '<!-- mdplace:candidate:source-title-raw:end -->',
  '<!-- mdplace:candidate:article:start -->',
  'Readable article',
  '<!-- mdplace:candidate:article:end -->',
  '<!-- mdplace:candidate:v1:end -->',
];

test('exact candidate grammar accepts the approved withheld marker order', () => {
  const result = inspectCandidate(candidate(validWithheldMarkers), withheldTemplate);
  assert.equal(result.candidateEnvelopeConforming, true);
  assert.equal(result.promotionGate, 'eligible_for_adapter_validation');
});

test('exact candidate grammar rejects a unique injected canonical marker', () => {
  const markers = validWithheldMarkers.toSpliced(7, 0, '<!-- mdplace:candidate:source-author-raw:end -->');
  const result = inspectCandidate(candidate(markers), withheldTemplate);
  assert.ok(result.reasons.includes('marker_grammar_invalid'));
  assert.equal(result.promotionGate, 'fails_after_intake');
});

test('exact candidate grammar rejects reordered optional marker pairs', () => {
  const markers = [...validWithheldMarkers];
  markers.splice(3, 3);
  markers.splice(8, 0,
    '<!-- mdplace:candidate:source-title-raw:start -->',
    'Fixture title',
    '<!-- mdplace:candidate:source-title-raw:end -->',
  );
  const result = inspectCandidate(candidate(markers), withheldTemplate);
  assert.ok(result.reasons.includes('marker_grammar_invalid'));
});

test('candidate envelope rejects undeclared frontmatter and a mismatched template', () => {
  const extra = inspectCandidate(candidate(validWithheldMarkers, {extraFrontmatter: '\nunexpected: value'}), withheldTemplate);
  const mismatch = inspectCandidate(candidate(validWithheldMarkers, {
    captureTemplate: 'mdplace-web-clipper-candidate-url-retained',
  }), withheldTemplate);
  assert.equal(extra.candidateEnvelopeConforming, false);
  assert.equal(mismatch.candidateEnvelopeConforming, false);
  assert.equal(extra.promotionGate, 'fails_after_intake');
  assert.equal(mismatch.promotionGate, 'fails_after_intake');
  assert.ok(extra.reasons.includes('candidate_envelope_invalid'));
  assert.ok(mismatch.reasons.includes('candidate_envelope_invalid'));
});

test('candidate envelope requires the static warning and no content outside the outer envelope', () => {
  const wrongWarning = inspectCandidate(candidate(validWithheldMarkers, {warning: '> different warning'}), withheldTemplate);
  const trailing = inspectCandidate(candidate(validWithheldMarkers, {extraBody: 'outside envelope\n'}), withheldTemplate);
  assert.equal(typeof wrongWarning.candidateEnvelopeConforming, 'boolean');
  assert.equal(wrongWarning.candidateEnvelopeConforming, false);
  assert.equal(wrongWarning.promotionGate, 'fails_after_intake');
  assert.equal(trailing.promotionGate, 'fails_after_intake');
  assert.ok(wrongWarning.reasons.includes('candidate_envelope_invalid'));
  assert.ok(trailing.reasons.includes('candidate_envelope_invalid'));
});

test('candidate frontmatter accepts safe plain strings and rejects invalid timestamp quoting', () => {
  const plain = inspectCandidate(candidate(validWithheldMarkers, {plainStrings: true}), withheldTemplate);
  const unquotedTimestamp = inspectCandidate(candidate(validWithheldMarkers, {
    timestamp: '2026-08-05T12:34:56.789Z',
  }), withheldTemplate);
  const unmatched = inspectCandidate(candidate(validWithheldMarkers, {
    timestamp: '"2026-08-05T12:34:56.789Z',
  }), withheldTemplate);
  assert.equal(plain.candidateEnvelopeConforming, true);
  assert.equal(plain.promotionGate, 'eligible_for_adapter_validation');
  assert.equal(unquotedTimestamp.candidateEnvelopeConforming, false);
  assert.equal(unquotedTimestamp.promotionGate, 'fails_after_intake');
  assert.equal(unmatched.candidateEnvelopeConforming, false);
  assert.equal(unmatched.promotionGate, 'fails_after_intake');
});

test('candidate envelope requires a real RFC 3339 millisecond timestamp', () => {
  const validOffset = inspectCandidate(candidate(validWithheldMarkers, {
    timestamp: '"2026-08-05T12:34:56.789+09:00"',
  }), withheldTemplate);
  const offsetWithoutColon = inspectCandidate(candidate(validWithheldMarkers, {
    timestamp: '"2026-08-05T12:34:56.789+0900"',
  }), withheldTemplate);
  const impossibleDate = inspectCandidate(candidate(validWithheldMarkers, {
    timestamp: '"2026-99-99T99:99:99.999Z"',
  }), withheldTemplate);
  const properties = [
    {name: 'mdplace_candidate_schema', type: 'text', value: 'mdplace.capture-candidate/v1'},
    {name: 'capture_source', type: 'text', value: 'obsidian_web_clipper'},
    {name: 'source_version_claim', type: 'text', value: '1.7.0'},
    {name: 'source_version_verified', type: 'checkbox', value: false},
    {name: 'capture_template', type: 'text', value: withheldTemplate},
    {name: 'capture_template_version', type: 'text', value: '1'},
    {name: 'source_captured_at_claim', type: 'text', value: '2026-02-30T12:34:56.789Z'},
  ];

  assert.equal(validOffset.candidateEnvelopeConforming, true);
  assert.equal(offsetWithoutColon.candidateEnvelopeConforming, false);
  assert.equal(impossibleDate.candidateEnvelopeConforming, false);
  assert.equal(inspectProperties(properties, withheldTemplate).propertyEnvelopeConforming, false);
});

test('clipboard timeout is infrastructure failure, not pre-intake rejection', () => {
  assert.equal(classifyCaptureState({candidate: null, clipboardStatus: 'clipboard_timed_out', note: 'rendered'}), 'capture_infrastructure_failed');
  assert.equal(classifyCaptureState({candidate: null, clipboardStatus: 'copy_control_missing', note: 'rendered'}), 'capture_infrastructure_failed');
  assert.equal(classifyCaptureState({candidate: null, clipboardStatus: 'no_note', note: null}), 'failed_before_intake');
});

test('probe file text replacement preserves replacement-pattern characters', () => {
  const text = 'literal $& $` $\' value';
  assert.equal(
    injectFileText('const value=__FILE_TEXT__;', text),
    `const value=${JSON.stringify(text)};`,
  );
});

class FakeSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({listener, once: options.once ?? false});
    this.listeners.set(type, listeners);
  }

  emit(type, event) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter(({once}) => !once));
    for (const {listener} of listeners) listener(event);
  }

  send() {}

  close() {
    this.closed = true;
    this.emit('close', {});
  }
}

test('CDP close rejects every pending command instead of hanging', async (context) => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  context.after(() => { globalThis.WebSocket = originalWebSocket; });
  const client = new CdpClient('ws://fixture');
  const response = client.send('Runtime.evaluate');
  await new Promise((resolve) => setTimeout(resolve, 0));
  client.socket.emit('close', {});
  const guarded = Promise.race([
    response,
    new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 30)),
  ]);
  await assert.rejects(guarded, /CDP WebSocket closed/);
});

test('target discovery has a bounded fetch deadline', async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, options = {}) => new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal.reason), {once: true});
  });
  context.after(() => { globalThis.fetch = originalFetch; });
  const discovery = findTarget('http://127.0.0.1:1', () => false, 'fixture', {timeoutMs: 10});
  const guarded = Promise.race([
    discovery,
    new Promise((_, reject) => setTimeout(() => reject(new Error('test guard expired')), 30)),
  ]);
  await assert.rejects(guarded, /target not found: fixture/);
});

test('CDP open timeout closes its socket and target cleanup is bounded', async () => {
  class NeverOpenSocket extends FakeSocket {
    emit(type, event) {
      if (type !== 'open') super.emit(type, event);
    }
  }
  const client = new CdpClient('ws://never-opens', {commandTimeoutMs: 5, WebSocketImpl: NeverOpenSocket});
  await assert.rejects(client.send('Runtime.evaluate'), /open timed out/);
  assert.equal(client.socket.closed, true);

  const requests = [];
  await closeTarget('http://127.0.0.1:9228', 'target/id', {
    fetchImpl: async (url, options) => {
      requests.push({options, url});
      return {ok: true, status: 200};
    },
  });
  assert.equal(requests[0].url, 'http://127.0.0.1:9228/json/close/target%2Fid');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('runner authenticates Chrome, preserves sandboxing, and documents evidence', async () => {
  const [runner, readme, probe, fixture, matrix, popup] = await Promise.all([
    readFile(new URL('./run.sh', import.meta.url), 'utf8'),
    readFile(new URL('./README.md', import.meta.url), 'utf8'),
    readFile(new URL('./probe.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/semantic-article.html', import.meta.url), 'utf8'),
    readFile(new URL('./matrix.mjs', import.meta.url), 'utf8'),
    import('./clipper-popup.mjs'),
  ]);
  assert.match(runner, /36c8b5fe04c08a418a172206bb392600ec1550941bde6af2d4353df21db87a47/);
  assert.doesNotMatch(runner, /--no-sandbox/);
  const focusIndex = runner.indexOf('set frontmost of first process whose unix id is ${chrome_pid} to true');
  const bootstrapIndex = runner.indexOf('node "$prototype_dir/bootstrap.mjs"');
  assert.ok(focusIndex >= 0, 'run.sh must foreground the Chrome process by PID');
  assert.ok(bootstrapIndex >= 0, 'run.sh must invoke bootstrap.mjs');
  assert.ok(focusIndex < bootstrapIndex, 'Chrome must be foregrounded before opening the popup');
  assert.match(runner, /probe\.setsockopt\(socket\.SOL_SOCKET, socket\.SO_REUSEADDR, 1\)[\s\S]*probe\.bind/);
  assert.match(runner, /evidence_temp=\n[\s\S]*rm -f -- "\$evidence_temp"/);
  assert.match(runner, /if \[\[ "\$matrix_status" == 0 && -n \$\{EVIDENCE_OUTPUT:-\} \]\]; then[\s\S]*evidence_temp=\$\(mktemp "\$\{EVIDENCE_OUTPUT\}\.tmp\.XXXXXX"\)[\s\S]*cp -- "\$matrix_output" "\$evidence_temp"[\s\S]*mv -- "\$evidence_temp" "\$EVIDENCE_OUTPUT"[\s\S]*evidence_temp=\nelif/);
  assert.match(readme, /FIXTURE_PORT[\s\S]*8766[\s\S]*DEBUG_PORT[\s\S]*9228[\s\S]*FIXTURE_SUITE_REVISION/);
  assert.match(readme, /outside a Git checkout[\s\S]*EVIDENCE_OUTPUT[\s\S]*passing matrix/i);
  assert.match(readme, /evidence\/matrix-chrome-150-macos-arm64\.json/);
  assert.match(probe, /127\.0\.0\.1:9228/);
  assert.match(fixture, /id="live-selection-target"/);
  assert.match(matrix, /getElementById\('live-selection-target'\)/);
  assert.ok(popup.templateExpectations instanceof Map);
});
