const canonicalBase64Syntax = /^[A-Za-z0-9+/]*={0,2}$/;

export function canonicalBase64Bytes(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !canonicalBase64Syntax.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}
