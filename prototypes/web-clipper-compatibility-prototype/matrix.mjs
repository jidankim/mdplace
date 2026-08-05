#!/usr/bin/env node

import {inspectCandidate, inspectProperties} from './candidate-contract.mjs';
import {CdpClient, evaluate, findTarget} from './cdp.mjs';
import {
  capturePopupState,
  classifyCaptureState,
  reloadPopup,
  selectTemplate,
  templateExpectations,
} from './clipper-popup.mjs';

const debugBase = process.env.CHROME_DEBUG_BASE ?? 'http://127.0.0.1:9228';
const fixtureBase = process.env.FIXTURE_BASE ?? 'http://127.0.0.1:8766';
const extensionId = process.env.WEB_CLIPPER_EXTENSION_ID;
const withheldTemplateName = 'mdplace Capture Candidate v1 — URL withheld';
const retainedTemplateName = 'mdplace Capture Candidate v1 — protected local URL';
const withheldTemplate = templateExpectations.get(withheldTemplateName).captureTemplate;
const retainedTemplate = templateExpectations.get(retainedTemplateName).captureTemplate;
const intakePath = '.mdplace/intake/web-clipper/pending';
const retainedFixtureUrl = `${fixtureBase}/semantic-article.html?session=synthetic-fixture-value#fragment`;
const templateArtifacts = [
  {
    identifier: withheldTemplate,
    sha256: 'fa72c5fbe5e0da5cfd88d58427af875ded19c75866e0b47d9e2ec6117af10fff',
    version: '1',
  },
  {
    identifier: retainedTemplate,
    sha256: '0c3d4be3391f12cc5aab5b4b85e4d14153e7bf5e1dd1edcac6faa9ae76ed7084',
    version: '1',
  },
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
      const paragraph=document.getElementById('live-selection-target');
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
  const inspection = inspectCandidate(state.candidate, withheldTemplate);
  results.push({
    id: testCase.id,
    url,
    extraction: classifyCaptureState(state),
    clipboardStatus: state.clipboardStatus,
    sentinelPresent: testCase.sentinel ? Boolean(state.candidate?.includes(testCase.sentinel)) : null,
    diagnostic: testCase.diagnostic ?? null,
    error: state.error,
    noteName: state.noteName,
    path: state.path,
    template: state.template,
    ...inspectProperties(state.properties, withheldTemplate),
    ...inspection,
  });
}

await fixture.send('Page.navigate', {url: retainedFixtureUrl});
await evaluate(fixture, `(async()=>{
  while(document.readyState!=='complete')await new Promise(resolve=>setTimeout(resolve,20));
  return true;
})()`);
await reloadPopup(popup);
await selectTemplate(popup, retainedTemplateName);
const retained = await capturePopupState(popup);
results.push({
  id: 'protected_local_url_profile',
  url: retainedFixtureUrl,
  extraction: classifyCaptureState(retained),
  clipboardStatus: retained.clipboardStatus,
  rawUrlPreservedInProtectedIntake: retained.candidate?.includes('?session=synthetic-fixture-value#fragment') ?? false,
  diagnostic: 'url_sanitization_required_before_promotion',
  error: retained.error,
  noteName: retained.noteName,
  path: retained.path,
  template: retained.template,
  ...inspectProperties(retained.properties, retainedTemplate),
  ...inspectCandidate(retained.candidate, retainedTemplate),
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
    extraction: classifyCaptureState(state),
    clipboardStatus: state.clipboardStatus,
    sentinelPresent: null,
    diagnostic: null,
    error: state.error,
    noteName: state.noteName,
    path: state.path,
    template: state.template,
    ...inspectProperties(state.properties, withheldTemplate),
    ...inspectCandidate(state.candidate, withheldTemplate),
  });
}

for (const result of results) {
  result.compatibilityStatus = result.extraction === 'failed_before_intake'
    ? 'pre_intake_no_candidate'
    : result.promotionGate === 'eligible_for_adapter_validation'
      ? 'candidate_eligible'
      : 'candidate_failed';
}

fixture.close();
popup.close();

const assertions = [];
const expect = (condition, message) => assertions.push({pass: Boolean(condition), message});
for (const result of results.filter((candidate) => candidate.candidateCreated)) {
  expect(result.clipboardStatus === 'captured', `${result.id} captured candidate bytes through the stock clipboard action`);
  expect(
    result.id === 'marker_collision' ? !result.candidateEnvelopeConforming : result.candidateEnvelopeConforming,
    `${result.id} received the expected exact candidate-envelope verdict`,
  );
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
    result?.extraction === 'failed_before_intake' &&
      result.clipboardStatus === 'no_note' &&
      result.error === 'This page cannot be clipped.' &&
      !result.candidateCreated &&
      result.candidateSha256 === null,
    `${id} reports the exact stock rejection and creates no candidate or digest`,
  );
}
expect(
  results.every((result) => result.extraction !== 'capture_infrastructure_failed'),
  'clipboard capture infrastructure succeeded for every rendered candidate',
);
expect(
  results.find((candidate) => candidate.id === 'protected_local_url_profile')?.rawUrlPreservedInProtectedIntake,
  'protected-local profile retains the synthetic raw query and fragment only in intake',
);

const report = {
  activationArtifact: false,
  activationBlockers: [
    'source_profile_hash',
    'processing_policy_hash',
    'disposable_vault_persistence_smoke',
  ],
  reportKind: 'browser_compatibility_observation',
  source: {
    browser: {
      archiveSha256: process.env.CHROME_ARCHIVE_SHA256 ?? null,
      family: process.env.BROWSER_FAMILY ?? null,
      version: process.env.BROWSER_VERSION ?? null,
    },
    extension: {
      archiveSha256: process.env.WEB_CLIPPER_ARCHIVE_SHA256 ?? null,
      name: 'Obsidian Web Clipper',
      sourceRevision: '48228dce63195681e9dfc4fb8760c3c36db51079',
      version: '1.7.0',
    },
    fixtureBase,
    fixtureSuiteRevision: process.env.FIXTURE_SUITE_REVISION ?? null,
    captureContractSha256: process.env.CAPTURE_CONTRACT_SHA256 ?? null,
    observedAt: new Date().toISOString(),
    platform: {
      architecture: process.arch,
      operatingSystem: process.platform,
    },
    templateArtifacts,
  },
  assertions,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (assertions.some((assertion) => !assertion.pass)) process.exitCode = 1;
