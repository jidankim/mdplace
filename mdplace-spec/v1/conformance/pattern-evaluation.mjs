function patternWithinBudget(pattern) {
  const frames = [{alternation: false, quantified: false, unbounded: 0}];
  let priorTokenIsRisky = false;
  let variableRepetitions = 0;
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
      if (priorTokenIsRisky) frames.at(-1).quantified = true;
      continue;
    }
    if (character === '|') {
      frames.at(-1).alternation = true;
      priorTokenIsRisky = false;
      continue;
    }
    const braceQuantifier = character === '{' ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index)) : null;
    if (character === '*' || character === '+' || character === '?' || braceQuantifier !== null) {
      const repetitionMinimum = character === '*' || character === '?' ? 0
        : character === '+' ? 1 : Number(braceQuantifier[1]);
      const repetitionMaximum = character === '*' || character === '+' ? Number.POSITIVE_INFINITY
        : character === '?' ? 1
          : braceQuantifier[2] === '' ? Number.POSITIVE_INFINITY
            : Number(braceQuantifier[2] ?? braceQuantifier[1]);
      const unbounded = repetitionMaximum === Number.POSITIVE_INFINITY;
      if (priorTokenIsRisky && repetitionMaximum > 1) return false;
      if (repetitionMinimum !== repetitionMaximum) {
        variableRepetitions += 1;
        if (variableRepetitions > 3) return false;
      }
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
  let expression;
  try {
    expression = new RegExp(pattern, 'u');
  } catch {
    return {status: 'invalidSchema'};
  }
  if (!patternWithinBudget(pattern)) return {status: 'resourceLimit'};
  return {status: 'complete', matches: expression.test(value)};
}
