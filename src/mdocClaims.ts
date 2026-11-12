// mdoc (mDL) claims come back as CBOR values; turn them into plain JSON for the business rules and the UI.

/** mdoc dates are CBOR full-date values; show them as plain YYYY-MM-DD text. */
export function plainClaims(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(plainClaims);
  if (value instanceof Map) return plainClaims(Object.fromEntries(value));
  if (value && typeof value === 'object') {
    if (value.constructor?.name === 'DateOnly') return String(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainClaims(v)]));
  }
  return value;
}
