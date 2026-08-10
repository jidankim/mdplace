function patternWithinBudget(pattern) {
  const frames = [{alternation: false, quantified: false, unbounded: 0}];
  let priorTokenIsRisky = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      if (/^[1-9]$/.test(pattern[index + 1] ?? '')) return false;
      index += 1;
      priorTokenIsRisky = false;
      continue;
    }
    if (character === '[') {
      for (index += 1; index < pattern.length && pattern[index] !== ']'; index += 1) {
        if (pattern[index] === '\\') index += 1;
      }
      priorTokenIsRisky = false;
      continue;
    }
    if (character === '(') {
      if (pattern[index + 1] === '?') {
        if ([':', '=', '!'].includes(pattern[index + 2])) index += 2;
        else if (pattern[index + 2] === '<' && ['=', '!'].includes(pattern[index + 3])) index += 3;
        else return false;
      }
      frames.push({alternation: false, quantified: false, unbounded: 0});
      priorTokenIsRisky = false;
      continue;
    }
    if (character === ')') {
      if (frames.length === 1) continue;
      const frame = frames.pop();
      priorTokenIsRisky = frame?.alternation === true || frame?.quantified === true;
      continue;
    }
    if (character === '|') {
      frames.at(-1).alternation = true;
      priorTokenIsRisky = false;
      continue;
    }
    const braceQuantifier = character === '{' && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(index));
    if (character === '*' || character === '+' || character === '?' || braceQuantifier) {
      const unbounded = character === '*' || character === '+' ||
        (braceQuantifier && /^\{\d+,\}/.test(pattern.slice(index)));
      if (priorTokenIsRisky && unbounded) return false;
      const frame = frames.at(-1);
      if (unbounded && frame.unbounded >= 2) return false;
      if (unbounded) frame.unbounded += 1;
      frame.quantified = true;
      priorTokenIsRisky = true;
      continue;
    }
    priorTokenIsRisky = false;
  }
  return true;
}

export function evaluatePattern(pattern, value) {
  if (!patternWithinBudget(pattern)) return {status: 'resourceLimit'};
  try {
    return {status: 'complete', matches: new RegExp(pattern, 'u').test(value)};
  } catch {
    return {status: 'invalidSchema'};
  }
}
