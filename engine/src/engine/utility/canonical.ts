export function canonicalJson(v: unknown): string {
  return canonicalJsonInner(v, new WeakSet<object>());
}

function canonicalJsonInner(v: unknown, ancestors: WeakSet<object>): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (Array.isArray(v)) {
    if (ancestors.has(v)) return '"<cycle>"';
    ancestors.add(v);
    try {
      return '[' + v.map((item) => canonicalJsonInner(item, ancestors)).join(',') + ']';
    } finally {
      ancestors.delete(v);
    }
  }
  if (typeof v === 'object') {
    if (ancestors.has(v)) return '"<cycle>"';
    ancestors.add(v);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    try {
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonInner(o[k], ancestors)).join(',') + '}';
    } finally {
      ancestors.delete(v);
    }
  }
  if (typeof v === 'function') return '"<fn>"';
  return JSON.stringify(v);
}
