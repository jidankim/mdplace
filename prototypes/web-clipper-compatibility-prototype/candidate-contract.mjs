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
const warningByTemplate = new Map([
  ['mdplace-web-clipper-candidate-url-withheld', '> [!warning] CAPTURE CANDIDATE — NOT A NOTE\n> Untrusted local intake. Not valid for placement or processing.'],
  ['mdplace-web-clipper-candidate-url-retained', '> [!warning] CAPTURE CANDIDATE — NOT A NOTE\n> Untrusted protected local intake. Not valid for placement or processing.'],
]);

export function isRfc3339MillisTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetValid = offsetHourText === undefined ||
    (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);
  return month >= 1 && month <= 12 &&
    day >= 1 && day <= daysInMonth[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 60 && offsetValid;
}

function decodedString(line, name) {
  const prefix = `${name}: `;
  if (!line?.startsWith(prefix)) return null;
  const source = line.slice(prefix.length);
  const startsQuoted = source.startsWith('"');
  const endsQuoted = source.endsWith('"');
  if (startsQuoted !== endsQuoted) return null;
  if (!startsQuoted) return source;
  try {
    const value = JSON.parse(source);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

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
  const normalizedCandidate = candidate.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const frontmatter = normalizedCandidate.match(/^---\n([\s\S]*?)\n---\n/);
  const frontmatterLines = (frontmatter?.[1] ?? '').split('\n');
  const candidatePropertyNames = frontmatterLines.map((line) => line.match(/^([a-z_]+):/)?.[1]).filter(Boolean);
  const captureTemplate = decodedString(frontmatterLines[4], 'capture_template');
  const sourceCapturedAt = frontmatterLines[6]?.startsWith('source_captured_at_claim: "')
    ? decodedString(frontmatterLines[6], 'source_captured_at_claim')
    : null;
  const valuesConforming =
    frontmatterLines.length === propertyNames.length &&
    decodedString(frontmatterLines[0], 'mdplace_candidate_schema') === 'mdplace.capture-candidate/v1' &&
    decodedString(frontmatterLines[1], 'capture_source') === 'obsidian_web_clipper' &&
    decodedString(frontmatterLines[2], 'source_version_claim') === '1.7.0' &&
    frontmatterLines[3] === 'source_version_verified: false' &&
    captureTemplate === expectedCaptureTemplate &&
    decodedString(frontmatterLines[5], 'capture_template_version') === '1' &&
    isRfc3339MillisTimestamp(sourceCapturedAt ?? '');
  const expectedWarning = warningByTemplate.get(captureTemplate);
  const body = frontmatter ? normalizedCandidate.slice(frontmatter[0].length) : '';
  const envelope = expectedWarning && body.startsWith(`${expectedWarning}\n\n`)
    ? body.slice(expectedWarning.length + 2)
    : null;
  const bodyConforming = envelope?.startsWith('<!-- mdplace:candidate:v1:start -->\n') &&
    envelope.endsWith('<!-- mdplace:candidate:v1:end -->\n');
  const propertyEnvelopeConforming = valuesConforming &&
    JSON.stringify(candidatePropertyNames) === JSON.stringify(propertyNames);
  const grammar = inspectMarkerGrammar(normalizedCandidate, captureTemplate);
  if (grammar.liveSelectionPresent) reasons.push('live_selection_present');
  if (!grammar.article?.trim()) reasons.push('article_empty');
  if (!grammar.valid) reasons.push('marker_grammar_invalid');
  if (!propertyEnvelopeConforming || !bodyConforming) reasons.push('candidate_envelope_invalid');
  return {
    candidateCreated: true,
    candidateEnvelopeConforming: propertyEnvelopeConforming &&
      bodyConforming &&
      grammar.valid,
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
    property.type === ['text', 'text', 'text', 'checkbox', 'text', 'text', 'text'][index] &&
    (index === 6 ? isRfc3339MillisTimestamp(property.value) : property.value === expectedValues[index])
  );
  return {propertyCount: properties.length, propertyEnvelopeConforming: envelopeConforming};
}
