export function injectFileText(expression, text) {
  return expression.replace('__FILE_TEXT__', () => JSON.stringify(text));
}
