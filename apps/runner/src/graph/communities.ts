/**
 * Communities of the module graph (docs/design/project-graphs.md section 5, step 6): Louvain modularity clustering with a
 * fixed seed, so the same module graph always gives the same communities. No model call; labels are the names of the most
 * connected modules. Written for Guildwise from the published method (Blondel et al., 2008).
 */

export interface Link {
  a: string;
  b: string;
  w: number;
}

export interface Community {
  /** 1-based, by size (largest first). */
  id: number;
  label: string;
  members: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clusters `ids` (sorted) by the weighted `links`; returns the communities as arrays of ids, largest first. */
export function louvain(ids: string[], links: Link[], seed = 1): string[][] {
  const sorted = [...ids].sort();
  const index = new Map(sorted.map((id, i) => [id, i]));
  const n = sorted.length;
  if (n === 0) return [];
  let adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map());
  for (const l of links) {
    const i = index.get(l.a);
    const j = index.get(l.b);
    if (i === undefined || j === undefined || l.w <= 0) continue;
    adj[i]?.set(j, (adj[i]?.get(j) ?? 0) + l.w);
    if (i !== j) adj[j]?.set(i, (adj[j]?.get(i) ?? 0) + l.w);
  }
  // membership of every original node in the current aggregate node
  let member = sorted.map((_, i) => i);
  const rand = mulberry32(seed);

  for (let level = 0; level < 20; level++) {
    const size = adj.length;
    const k = adj.map((m, i) => {
      let s = 0;
      for (const [j, w] of m) s += j === i ? 2 * w : w;
      return s;
    });
    const m2 = k.reduce((x, y) => x + y, 0);
    if (m2 === 0) break;
    const comm = Array.from({ length: size }, (_, i) => i);
    const tot = [...k];
    const order = Array.from({ length: size }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j] as number, order[i] as number];
    }
    let moved = true;
    let passes = 0;
    while (moved && passes++ < 50) {
      moved = false;
      for (const i of order) {
        const ci = comm[i] as number;
        const ki = k[i] as number;
        const toComm = new Map<number, number>();
        for (const [j, w] of adj[i] as Map<number, number>) {
          if (j === i) continue;
          const cj = comm[j] as number;
          toComm.set(cj, (toComm.get(cj) ?? 0) + w);
        }
        tot[ci] = (tot[ci] as number) - ki;
        let best = ci;
        let bestGain = (toComm.get(ci) ?? 0) - ((tot[ci] as number) * ki) / m2;
        for (const c of [...toComm.keys()].sort((a, b) => a - b)) {
          const gain = (toComm.get(c) as number) - ((tot[c] as number) * ki) / m2;
          if (gain > bestGain + 1e-12) {
            bestGain = gain;
            best = c;
          }
        }
        tot[best] = (tot[best] as number) + ki;
        if (best !== ci) {
          comm[i] = best;
          moved = true;
        }
      }
    }
    const labels = [...new Set(comm)].sort((a, b) => a - b);
    if (labels.length === size) break; // nothing merged: done
    const renum = new Map(labels.map((c, i) => [c, i]));
    member = member.map((m) => renum.get(comm[m] as number) as number);
    const next: Array<Map<number, number>> = Array.from({ length: labels.length }, () => new Map());
    for (let i = 0; i < size; i++) {
      const ci = renum.get(comm[i] as number) as number;
      for (const [j, w] of adj[i] as Map<number, number>) {
        const cj = renum.get(comm[j] as number) as number;
        // each undirected edge is stored twice; a self loop once
        const add = i === j ? w : w / 2;
        (next[ci] as Map<number, number>).set(cj, ((next[ci] as Map<number, number>).get(cj) ?? 0) + add);
        if (ci !== cj)
          (next[cj] as Map<number, number>).set(ci, ((next[cj] as Map<number, number>).get(ci) ?? 0) + add);
      }
    }
    adj = next;
  }
  const groups = new Map<number, string[]>();
  member.forEach((c, i) => {
    const g = groups.get(c) ?? [];
    g.push(sorted[i] as string);
    groups.set(c, g);
  });
  return [...groups.values()]
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || ((a[0] as string) < (b[0] as string) ? -1 : 1));
}

/** Labels a community by its most connected members (by weighted degree), no model involved. */
export function labelCommunities(
  groups: string[][],
  links: Link[],
  nameOf: (id: string) => string,
): Community[] {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.a, (degree.get(l.a) ?? 0) + l.w);
    degree.set(l.b, (degree.get(l.b) ?? 0) + l.w);
  }
  return groups.map((members, i) => {
    const top = [...members]
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 3)
      .map(nameOf);
    return { id: i + 1, label: top.join(' + ') || 'group', members };
  });
}
