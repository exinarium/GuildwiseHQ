/**
 * Deep equality of two JSON values that does not depend on key order. Postgres `jsonb` returns keys in its own order
 * (shorter keys first), so comparing `JSON.stringify` of a stored value with a fresh one reported a change on every sweep:
 * 36,733 no-op `BaSignalUpdated` events in production. `undefined` properties count as absent, like in JSON.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      );
    }
    return val;
  });
}
