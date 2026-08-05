import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {inspectCandidate} from './candidate-contract.mjs';
import {CdpClient, findTarget} from './cdp.mjs';
import {classifyCaptureState} from './clipper-popup.mjs';
import {injectFileText} from './probe-expression.mjs';

const withheldTemplate = 'mdplace-web-clipper-candidate-url-withheld';

function candidate(markers, {captureTemplate = withheldTemplate, extraFrontmatter = ''} = {}) {
  return `---
mdplace_candidate_schema: "mdplace.capture-candidate/v1"
capture_source: "obsidian_web_clipper"
source_version_claim: "1.7.0"
source_version_verified: false
capture_template: "${captureTemplate}"
capture_template_version: "1"
source_captured_at_claim: "2026-08-05T12:34:56.789Z"${extraFrontmatter}
---
> [!warning] CAPTURE CANDIDATE — NOT A NOTE

${markers.join('\n')}
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
  assert.match(readme, /evidence\/matrix-chrome-150-macos-arm64\.json/);
  assert.match(probe, /127\.0\.0\.1:9228/);
  assert.match(fixture, /id="live-selection-target"/);
  assert.match(matrix, /getElementById\('live-selection-target'\)/);
  assert.ok(popup.templateExpectations instanceof Map);
});
