import {createHash} from 'node:crypto';

const propertyNames = [
  'mdplace_candidate_schema',
  'capture_source',
  'source_version_claim',
  'source_version_verified',
  'capture_template',
  'capture_template_version',
  'source_captured_at_claim',
];

const markerPrefix = '<!-- mdplace:candidate:';

function inspectMarkerGrammar(candidate, captureTemplate) {
  const lines = candidate.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const markers = lines.flatMap((line, lineIndex) => {
    if (!line.startsWith(markerPrefix) || !line.endsWith(' -->')) return [];
    return [{lineIndex, value: line.slice(markerPrefix.length, -4)}];
  });
  const markerOccurrences = candidate.match(/<!-- mdplace:candidate:/g)?.length ?? 0;
  let index = 0;
  let articleStart = null;
  let articleEnd = null;

  const consume = (value) => {
    if (markers[index]?.value !== value) return false;
    index += 1;
    return true;
  };
  const consumeOptionalPair = (name) => {
    if (markers[index]?.value !== `${name}:start`) return true;
    index += 1;
    return consume(`${name}:end`);
  };

  let valid = markerOccurrences === markers.length &&
    consume('v1:start') &&
    ['live-selection:present', 'live-selection:absent'].includes(markers[index]?.value);
  if (valid) index += 1;

  if (valid && captureTemplate === 'mdplace-web-clipper-candidate-url-withheld') {
    valid = consume('source-url:withheld-by-policy');
  } else if (valid && captureTemplate === 'mdplace-web-clipper-candidate-url-retained') {
    valid = consumeOptionalPair('source-url-raw');
  } else {
    valid = false;
  }

  for (const name of ['source-title-raw', 'source-author-raw', 'source-published-at-raw', 'source-site-raw']) {
    if (valid) valid = consumeOptionalPair(name);
  }
  if (valid && markers[index]?.value === 'article:start') {
    articleStart = markers[index].lineIndex;
    index += 1;
    if (markers[index]?.value === 'article:end') {
      articleEnd = markers[index].lineIndex;
      index += 1;
    } else {
      valid = false;
    }
  } else {
    valid = false;
  }
  if (valid) valid = consumeOptionalPair('annotations');
  if (valid) valid = consume('v1:end') && index === markers.length;

  return {
    article: articleStart === null || articleEnd === null ? null : lines.slice(articleStart + 1, articleEnd).join('\n'),
    liveSelectionPresent: markers.some(({value}) => value === 'live-selection:present'),
    valid,
  };
}

export function inspectCandidate(candidate, expectedCaptureTemplate) {
  if (!candidate) {
    return {candidateCreated: false, candidateEnvelopeConforming: false, candidateSha256: null, promotionGate: null, reasons: []};
  }
  const reasons = [];
  const frontmatter = candidate.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatterLines = (frontmatter?.[1] ?? '').split('\n');
  const candidatePropertyNames = frontmatterLines.map((line) => line.match(/^([a-z_]+):/)?.[1]).filter(Boolean);
  const captureTemplate = frontmatterLines[4]?.match(/^capture_template: "([^"]+)"$/)?.[1] ?? null;
  const valuesConforming =
    frontmatterLines.length === propertyNames.length &&
    frontmatterLines[0] === 'mdplace_candidate_schema: "mdplace.capture-candidate/v1"' &&
    frontmatterLines[1] === 'capture_source: "obsidian_web_clipper"' &&
    frontmatterLines[2] === 'source_version_claim: "1.7.0"' &&
    frontmatterLines[3] === 'source_version_verified: false' &&
    captureTemplate === expectedCaptureTemplate &&
    frontmatterLines[5] === 'capture_template_version: "1"' &&
    /^source_captured_at_claim: "?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})"?$/.test(frontmatterLines[6]);
  const grammar = inspectMarkerGrammar(candidate, captureTemplate);
  if (grammar.liveSelectionPresent) reasons.push('live_selection_present');
  if (!grammar.article?.trim()) reasons.push('article_empty');
  if (!grammar.valid) reasons.push('marker_grammar_invalid');
  return {
    candidateCreated: true,
    candidateEnvelopeConforming: valuesConforming &&
      grammar.valid &&
      JSON.stringify(candidatePropertyNames) === JSON.stringify(propertyNames),
    candidateSha256: createHash('sha256').update(candidate, 'utf8').digest('hex'),
    decodedTimestampType: 'string_under_yaml_1_2_core',
    promotionGate: reasons.length ? 'fails_after_intake' : 'eligible_for_adapter_validation',
    reasons,
  };
}

export function inspectProperties(properties, captureTemplate) {
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
