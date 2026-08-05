#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {CdpClient, evaluate, findTarget} from './cdp.mjs';
import {capturePopupState, reloadPopup, selectTemplate} from './clipper-popup.mjs';

const debugBase = process.env.CHROME_DEBUG_BASE ?? 'http://127.0.0.1:9228';
const fixtureBase = process.env.FIXTURE_BASE ?? 'http://127.0.0.1:8766';
const extensionId = process.env.WEB_CLIPPER_EXTENSION_ID;
const withheldTemplateName = 'mdplace Capture Candidate v1 — URL withheld';
const retainedTemplateName = 'mdplace Capture Candidate v1 — protected local URL';
const intakePath = '.mdplace/intake/web-clipper/pending';
const propertyNames = [
  'mdplace_candidate_schema',
  'capture_source',
  'source_version_claim',
  'source_version_verified',
  'capture_template',
  'capture_template_version',
  'source_captured_at_claim',
];

if (!extensionId) {
  console.error('WEB_CLIPPER_EXTENSION_ID is required');
  process.exit(2);
}

const cases = [
  {id: 'semantic_article', path: '/semantic-article.html', sentinel: 'SEMANTIC\\_ARTICLE\\_SENTINEL'},
  {id: 'documentation', path: '/documentation.html', sentinel: 'DOCUMENTATION\\_SENTINEL'},
  {id: 'schema_article', path: '/schema-article.html', sentinel: 'SCHEMA\\_ARTICLE\\_SENTINEL'},
  {id: 'dynamic_spa', path: '/dynamic-spa.html', sentinel: 'DYNAMIC\\_SPA\\_SENTINEL', settleMs: 500},
  {id: 'open_shadow_dom', path: '/open-shadow-dom.html', sentinel: 'OPEN\\_SHADOW\\_SENTINEL'},
  {id: 'closed_shadow_dom', path: '/closed-shadow-dom.html'},
  {id: 'iframe_only', path: '/iframe-only.html'},
  {id: 'metadata_only', path: '/metadata-only.html'},
  {id: 'paywall_shell', path: '/paywall-shell.html', sentinel: 'PAYWALL\\_TEASER\\_SENTINEL', diagnostic: 'access_limited_content'},
  {id: 'unsafe_resources', path: '/unsafe-resources.html', sentinel: 'UNSAFE\\_RESOURCES\\_SENTINEL', diagnostic: 'markdown_safety_transform_required'},
  {id: 'marker_collision', path: '/marker-collision.html', sentinel: 'MARKER\\_COLLISION\\_SENTINEL'},
  {id: 'live_selection', path: '/semantic-article.html', sentinel: 'SEMANTIC\\_ARTICLE\\_SENTINEL', selectText: true},
];

function inspectCandidate(candidate) {
  if (!candidate) {
    return {candidateCreated: false, candidateEnvelopeConforming: false, candidateSha256: null, promotionGate: null, reasons: []};
  }
  const reasons = [];
  const liveSelectionPresent = candidate.includes('<!-- mdplace:candidate:live-selection:present -->');
  const articleMatch = candidate.match(/<!-- mdplace:candidate:article:start -->\n([\s\S]*?)\n<!-- mdplace:candidate:article:end -->/);
  const frontmatter = candidate.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatterLines = (frontmatter?.[1] ?? '').split('\n');
  const candidatePropertyNames = frontmatterLines.map((line) => line.match(/^([a-z_]+):/)?.[1]).filter(Boolean);
  const valuesConforming =
    frontmatterLines[0] === 'mdplace_candidate_schema: "mdplace.capture-candidate/v1"' &&
    frontmatterLines[1] === 'capture_source: "obsidian_web_clipper"' &&
    frontmatterLines[2] === 'source_version_claim: "1.7.0"' &&
    frontmatterLines[3] === 'source_version_verified: false' &&
    /^capture_template: "mdplace-web-clipper-candidate-url-(?:withheld|retained)"$/.test(frontmatterLines[4]) &&
    frontmatterLines[5] === 'capture_template_version: "1"' &&
    /^source_captured_at_claim: "?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})"?$/.test(frontmatterLines[6]);
  const canonicalMarkers = candidate.match(/^<!-- mdplace:candidate:[^\n]+ -->$/gm) ?? [];
  const uniqueMarkers = new Set(canonicalMarkers);
  const injectedMarker = canonicalMarkers.length !== uniqueMarkers.size;
  if (liveSelectionPresent) reasons.push('live_selection_present');
  if (!articleMatch || !articleMatch[1].trim()) reasons.push('article_empty');
  if (injectedMarker) reasons.push('marker_grammar_invalid');
  return {
    candidateCreated: true,
    candidateEnvelopeConforming: valuesConforming && JSON.stringify(candidatePropertyNames) === JSON.stringify(propertyNames),
    candidateSha256: createHash('sha256').update(candidate, 'utf8').digest('hex'),
    decodedTimestampType: 'string_under_yaml_1_2_core',
    promotionGate: reasons.length ? 'fails_after_intake' : 'eligible_for_adapter_validation',
    reasons,
  };
}

function inspectProperties(properties, captureTemplate) {
  const expectedValues = [
    'mdplace.capture-candidate/v1',
    'obsidian_web_clipper',
    '1.7.0',
    false,
    captureTemplate,
    '1',
  ];
  const envelopeConforming = properties.length === propertyNames.length && properties.every((property, index) =>
    property.name === propertyNames[index] &&
    property.type === ['text', 'text', 'text', 'checkbox', 'text', 'text', 'datetime'][index] &&
    (index === 6 ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})$/.test(property.value) : property.value === expectedValues[index])
  );
  return {propertyCount: properties.length, propertyEnvelopeConforming: envelopeConforming};
}

const fixtureTarget = await findTarget(
  debugBase,
  (target) => target.type === 'page' && target.url.startsWith(fixtureBase),
  'fixture page',
);
const popupTarget = await findTarget(
  debugBase,
  (target) => target.type === 'page' && target.url === `chrome-extension://${extensionId}/popup.html`,
  'Web Clipper popup',
);
const fixture = new CdpClient(fixtureTarget.webSocketDebuggerUrl);
const popup = new CdpClient(popupTarget.webSocketDebuggerUrl);

const results = [];
for (const testCase of cases) {
  const url = testCase.url ?? `${fixtureBase}${testCase.path}`;
  await fixture.send('Page.navigate', {url});
  await evaluate(fixture, `(async()=>{
    while(document.readyState!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
    await new Promise(resolve=>setTimeout(resolve,${testCase.settleMs ?? 100}));
    return document.title;
  })()`);

  if (testCase.selectText) {
    await evaluate(fixture, `(()=>{
      const paragraph=document.querySelector('article p:nth-of-type(2)');
      const range=document.createRange();
      range.selectNodeContents(paragraph);
      const selection=getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`);
  }

  await reloadPopup(popup);
  await selectTemplate(popup, withheldTemplateName);
  const state = await capturePopupState(popup);
  const inspection = inspectCandidate(state.candidate);
  results.push({
    id: testCase.id,
    url,
    extraction: state.candidate ? 'rendered_candidate' : 'failed_before_intake',
    sentinelPresent: testCase.sentinel ? Boolean(state.candidate?.includes(testCase.sentinel)) : null,
    diagnostic: testCase.diagnostic ?? null,
    error: state.error,
    noteName: state.noteName,
    path: state.path,
    template: state.template,
    ...inspectProperties(state.properties, 'mdplace-web-clipper-candidate-url-withheld'),
    ...inspection,
  });
}

await fixture.send('Page.navigate', {url: `${fixtureBase}/semantic-article.html?session=fixture-secret#fragment`});
await evaluate(fixture, `(async()=>{
  while(document.readyState!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
  return true;
})()`);
await reloadPopup(popup);
await selectTemplate(popup, retainedTemplateName);
const retained = await capturePopupState(popup);
results.push({
  id: 'protected_local_url_profile',
  url: `${fixtureBase}/semantic-article.html?session=fixture-secret#fragment`,
  extraction: retained.candidate ? 'rendered_candidate' : 'failed_before_intake',
  rawUrlPreservedInProtectedIntake: retained.candidate?.includes('?session=fixture-secret#fragment') ?? false,
  diagnostic: 'url_sanitization_required_before_promotion',
  error: retained.error,
  noteName: retained.noteName,
  path: retained.path,
  template: retained.template,
  ...inspectProperties(retained.properties, 'mdplace-web-clipper-candidate-url-retained'),
  ...inspectCandidate(retained.candidate),
});

for (const control of [
  {id: 'restricted_browser_page', url: 'chrome://version/'},
  {id: 'blank_page', url: 'about:blank'},
]) {
  await fixture.send('Page.navigate', {url: control.url});
  await evaluate(fixture, `(async()=>{
    while(document.readyState!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
    return true;
  })()`);
  await reloadPopup(popup);
  const state = await capturePopupState(popup);
  results.push({
    id: control.id,
    url: control.url,
    extraction: state.candidate ? 'rendered_candidate' : 'failed_before_intake',
    sentinelPresent: null,
    diagnostic: null,
    error: state.error,
    noteName: state.noteName,
    path: state.path,
    template: state.template,
    ...inspectProperties(state.properties, 'mdplace-web-clipper-candidate-url-withheld'),
    ...inspectCandidate(state.candidate),
  });
}

fixture.close();
popup.close();

const assertions = [];
const expect = (condition, message) => assertions.push({pass: Boolean(condition), message});
for (const result of results.filter((candidate) => candidate.candidateCreated)) {
  expect(result.candidateEnvelopeConforming, `${result.id} copied the exact seven-property candidate envelope`);
  expect(result.propertyEnvelopeConforming, `${result.id} rendered the approved property values and types`);
  expect(result.path === intakePath, `${result.id} targets protected Capture Intake`);
  expect(/^candidate-\d{8}-\d{6}-\d{3}$/.test(result.noteName), `${result.id} uses the create-only candidate filename`);
  expect(/^[0-9a-f]{64}$/.test(result.candidateSha256), `${result.id} reports the exact candidate digest`);
  expect(
    result.template === (result.id === 'protected_local_url_profile' ? retainedTemplateName : withheldTemplateName),
    `${result.id} rendered the approved template`,
  );
}
for (const testCase of cases.filter((candidate) => candidate.sentinel)) {
  expect(results.find((result) => result.id === testCase.id)?.sentinelPresent, `${testCase.id} preserved its fixture sentinel`);
}
for (const id of [
  'semantic_article',
  'documentation',
  'schema_article',
  'dynamic_spa',
  'open_shadow_dom',
  'paywall_shell',
  'unsafe_resources',
  'protected_local_url_profile',
]) {
  const result = results.find((candidate) => candidate.id === id);
  expect(result?.promotionGate === 'eligible_for_adapter_validation', `${id} reaches adapter validation`);
}
for (const [id, reason] of [
  ['closed_shadow_dom', 'article_empty'],
  ['iframe_only', 'article_empty'],
  ['metadata_only', 'article_empty'],
  ['marker_collision', 'marker_grammar_invalid'],
  ['live_selection', 'live_selection_present'],
]) {
  const result = results.find((candidate) => candidate.id === id);
  expect(result?.promotionGate === 'fails_after_intake' && result.reasons.includes(reason), `${id} fails ${reason}`);
}
for (const id of ['restricted_browser_page', 'blank_page']) {
  const result = results.find((candidate) => candidate.id === id);
  expect(
    result?.extraction === 'failed_before_intake' && !result.candidateCreated && result.candidateSha256 === null,
    `${id} creates no candidate or candidate digest`,
  );
}
expect(
  results.find((candidate) => candidate.id === 'protected_local_url_profile')?.rawUrlPreservedInProtectedIntake,
  'protected-local profile retains the synthetic raw query and fragment only in intake',
);

const report = {
  source: {
    extension: 'Obsidian Web Clipper',
    version: '1.7.0',
    fixtureBase,
  },
  assertions,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (assertions.some((assertion) => !assertion.pass)) process.exitCode = 1;
