#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import {CdpClient, evaluate, findTarget} from './cdp.mjs';
import {compressToUTF16} from './lz-string.mjs';

const debugBase = process.env.CHROME_DEBUG_BASE;
const fixtureBase = process.env.FIXTURE_BASE;
const extensionId = process.env.WEB_CLIPPER_EXTENSION_ID;
const withheldPath = process.env.WITHHELD_TEMPLATE;
const retainedPath = process.env.RETAINED_TEMPLATE;

if (!debugBase || !fixtureBase || !extensionId || !withheldPath || !retainedPath) {
  console.error('missing bootstrap environment');
  process.exit(2);
}

function prepareTemplate(templatePath, id) {
  return readFile(templatePath, 'utf8').then((source) => {
    const template = JSON.parse(source);
    template.id = id;
    template.properties = template.properties.map((property, index) => ({
      ...property,
      id: `${id}-property-${index + 1}`,
    }));
    return template;
  });
}

function storageChunks(template) {
  const compressed = compressToUTF16(JSON.stringify(template));
  const chunks = [];
  for (let index = 0; index < compressed.length; index += 8000) {
    chunks.push(compressed.slice(index, index + 8000));
  }
  return chunks;
}

const hostUrl = `chrome-extension://${extensionId}/highlights.html`;
const readinessDeadline = Date.now() + 15000;
let host = null;
let manifest = null;
let readinessError = null;
while (Date.now() < readinessDeadline && !host) {
  let candidate = null;
  try {
    const response = await fetch(`${debugBase}/json/new?${encodeURIComponent(hostUrl)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error(`bootstrap target creation failed: HTTP ${response.status}`);
    const hostTarget = await findTarget(
      debugBase,
      (target) => target.type === 'page' && target.url === hostUrl,
      'Web Clipper bootstrap host',
      {timeoutMs: Math.min(1000, readinessDeadline - Date.now())},
    );
    candidate = new CdpClient(hostTarget.webSocketDebuggerUrl, {commandTimeoutMs: 1000});
    const APIsReady = await evaluate(candidate, `
      typeof globalThis.chrome==='object' &&
      typeof chrome.runtime?.getManifest==='function' &&
      typeof chrome.storage?.sync?.get==='function' &&
      typeof chrome.tabs?.query==='function' &&
      typeof chrome.action?.openPopup==='function'
    `);
    if (!APIsReady) throw new Error('Web Clipper extension APIs are not ready');
    manifest = await evaluate(candidate, 'chrome.runtime.getManifest()');
    host = candidate;
  } catch (error) {
    readinessError = error;
    candidate?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!host || !manifest) {
  throw new Error(`Web Clipper extension readiness timed out: ${readinessError?.message ?? 'unknown error'}`);
}
if (manifest.name !== 'Obsidian Web Clipper' || manifest.version !== '1.7.0') {
  throw new Error(`unexpected extension: ${manifest.name} ${manifest.version}`);
}

const withheld = await prepareTemplate(withheldPath, 'mdplace-withheld-v1');
const retained = await prepareTemplate(retainedPath, 'mdplace-retained-v1');
const propertyTypes = withheld.properties.map((property) => ({
  name: property.name,
  type: property.type,
  defaultValue: property.value,
}));
const storage = {
  template_list: [withheld.id, retained.id],
  [`template_${withheld.id}`]: storageChunks(withheld),
  [`template_${retained.id}`]: storageChunks(retained),
  property_types: propertyTypes,
  highlighter_settings: {
    highlighterEnabled: true,
    alwaysShowHighlights: false,
    highlightBehavior: 'no-highlights',
  },
  interpreter_settings: {
    interpreterEnabled: false,
    interpreterAutoRun: false,
  },
};
const stored = await evaluate(host, `chrome.storage.sync.set(${JSON.stringify(storage)}).then(()=>
  chrome.storage.sync.get(['template_list','property_types'])
)`);
if (stored.template_list?.join(',') !== 'mdplace-withheld-v1,mdplace-retained-v1') {
  throw new Error('template storage bootstrap failed');
}
if (stored.property_types?.length !== propertyTypes.length || stored.property_types.some((property, index) =>
  property.name !== propertyTypes[index].name ||
  property.type !== propertyTypes[index].type ||
  property.defaultValue !== propertyTypes[index].defaultValue
)) {
  throw new Error('property type storage bootstrap failed');
}

const fixtureTabId = await evaluate(host, `chrome.tabs.query({url:${JSON.stringify(`${fixtureBase}/*`)}}).then(([tab])=>
  chrome.tabs.update(tab.id,{active:true}).then(()=>tab.id)
)`);

await evaluate(host, 'chrome.action.openPopup().then(()=>true)');

const popupTarget = await findTarget(
  debugBase,
  (target) => target.type === 'page' && target.url === `chrome-extension://${extensionId}/popup.html`,
  'Web Clipper popup',
);
if (!popupTarget.webSocketDebuggerUrl) throw new Error('Web Clipper popup is not debuggable');

host.close();

console.log(JSON.stringify({
  extensionId,
  fixtureTabId,
  name: manifest.name,
  propertyTypes,
  version: manifest.version,
}, null, 2));
