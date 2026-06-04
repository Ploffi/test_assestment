export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
  }
  if (typeof v === 'function') return '"<fn>"';
  return JSON.stringify(v);
}
