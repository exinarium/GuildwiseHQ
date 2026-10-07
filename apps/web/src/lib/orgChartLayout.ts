import type { OrgChartAgent } from '@aom/shared';

/**
 * Layout of the organization chart (a pure function, tested without a browser).
 *
 * The tree is the escalation tree: the manager at the top, the BAs below, then each department (a labelled box) with
 * one group per role: the seniors on the upper row and the juniors under them. A junior's line goes up to the seniors
 * of its role; a senior's (or a junior with no senior) goes up to the BAs; the BAs' go to the manager. DevOps engineers
 * are not part of the tree (they are listed per workstation).
 */
export const NODE_W = 188;
export const NODE_H = 92;
export const GAP_X = 16;
export const GAP_Y = 64;
const PAD = 16;
const BOX_HEAD = 34;
const MANAGER_W = 240;
const MANAGER_H = 92;

export interface LaidNode {
  id: string;
  kind: 'manager' | 'ba' | 'agent' | 'placeholder';
  agent?: OrgChartAgent;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface LaidEdge {
  id: string;
  from: string;
  to: string;
  /** What the line means: a question going up to a senior of the role, to the BA, or to the manager's desk. */
  kind: 'peer' | 'ba' | 'desk';
  d: string;
}
export interface LaidBox {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  roles: Array<{ key: string; label: string; x: number; w: number }>;
}
export interface OrgLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
  boxes: LaidBox[];
}

interface RoleGroup {
  key: string;
  label: string;
  tops: OrgChartAgent[];
  under: OrgChartAgent[];
  w: number;
}

const bySeniority = (a: OrgChartAgent, b: OrgChartAgent) =>
  Number(b.seniority === 'senior') - Number(a.seniority === 'senior') || a.name.localeCompare(b.name);

/** Elbow from a child's top-centre up to a bus line and across to the parent's bottom-centre. */
function elbow(cx: number, cy: number, px: number, py: number, bus: number): string {
  return `M${cx},${cy} V${bus} H${px} V${py}`;
}

export function layoutOrgChart(
  agents: OrgChartAgent[],
  departments: Array<{ key: string; label: string }>,
): OrgLayout {
  const tree = agents.filter((a) => !a.isDevops);
  const bas = tree.filter((a) => a.roleKey === 'ba').sort(bySeniority);
  const rest = tree.filter((a) => a.roleKey !== 'ba');

  // department -> role groups
  const groupsOf = (dept: string): RoleGroup[] => {
    const inDept = rest.filter((a) => (a.department ?? 'other') === dept);
    const roleKeys = [...new Set(inDept.map((a) => a.roleKey))].sort();
    return roleKeys.map((key) => {
      const mine = inDept.filter((a) => a.roleKey === key).sort(bySeniority);
      const seniors = mine.filter((a) => a.seniority === 'senior');
      const juniors = mine.filter((a) => a.seniority !== 'senior');
      const tops = seniors.length ? seniors : juniors;
      const under = seniors.length ? juniors : [];
      const cols = Math.max(tops.length, under.length, 1);
      return {
        key,
        label: mine[0]?.roleLabel ?? key,
        tops,
        under,
        w: cols * NODE_W + (cols - 1) * GAP_X,
      };
    });
  };

  const deptKeys = departments
    .map((d) => d.key)
    .filter((k) => rest.some((a) => (a.department ?? 'other') === k));
  const depts = deptKeys.map((key) => {
    const groups = groupsOf(key);
    const inner = groups.reduce((s, g) => s + g.w, 0) + (groups.length - 1) * GAP_X;
    return { key, label: departments.find((d) => d.key === key)?.label ?? key, groups, w: inner + PAD * 2 };
  });

  const baRowW = Math.max(bas.length, 1) * NODE_W + (Math.max(bas.length, 1) - 1) * GAP_X;
  const deptRowW = depts.reduce((s, d) => s + d.w, 0) + Math.max(0, depts.length - 1) * GAP_X * 2;
  const width = Math.max(baRowW, deptRowW, MANAGER_W) + PAD * 2;

  const yManager = 0;
  const yBa = yManager + MANAGER_H + GAP_Y;
  const yBox = yBa + NODE_H + GAP_Y;
  const yTop = yBox + BOX_HEAD + PAD / 2;
  const yUnder = yTop + NODE_H + GAP_Y * 0.75;
  const hasUnder = depts.some((d) => d.groups.some((g) => g.under.length));
  const boxH = BOX_HEAD + PAD / 2 + NODE_H + (hasUnder ? GAP_Y * 0.75 + NODE_H : 0) + PAD;

  const nodes: LaidNode[] = [];
  const edges: LaidEdge[] = [];
  const boxes: LaidBox[] = [];
  const pos = new Map<string, LaidNode>();
  const add = (n: LaidNode) => {
    nodes.push(n);
    pos.set(n.id, n);
  };

  const mx = (width - MANAGER_W) / 2;
  add({ id: 'manager', kind: 'manager', x: mx, y: yManager, w: MANAGER_W, h: MANAGER_H });

  // BAs, centred
  const baX0 = (width - baRowW) / 2;
  if (bas.length === 0) {
    add({ id: 'ba-none', kind: 'placeholder', x: (width - NODE_W) / 2, y: yBa, w: NODE_W, h: NODE_H });
  } else {
    for (const [i, a] of bas.entries())
      add({ id: a.id, kind: 'ba', agent: a, x: baX0 + i * (NODE_W + GAP_X), y: yBa, w: NODE_W, h: NODE_H });
  }
  const baIds = bas.length ? bas.map((a) => a.id) : ['ba-none'];

  // departments, left to right, centred as a row
  let x = (width - deptRowW) / 2;
  for (const d of depts) {
    const box: LaidBox = { key: d.key, label: d.label, x, y: yBox, w: d.w, h: boxH, roles: [] };
    let gx = x + PAD;
    for (const g of d.groups) {
      box.roles.push({ key: g.key, label: g.label, x: gx, w: g.w });
      const topX0 = gx + (g.w - (g.tops.length * NODE_W + (g.tops.length - 1) * GAP_X)) / 2;
      for (const [i, a] of g.tops.entries())
        add({
          id: a.id,
          kind: 'agent',
          agent: a,
          x: topX0 + i * (NODE_W + GAP_X),
          y: yTop,
          w: NODE_W,
          h: NODE_H,
        });
      const underX0 = gx + (g.w - (g.under.length * NODE_W + (g.under.length - 1) * GAP_X)) / 2;
      for (const [i, a] of g.under.entries())
        add({
          id: a.id,
          kind: 'agent',
          agent: a,
          x: underX0 + i * (NODE_W + GAP_X),
          y: yUnder,
          w: NODE_W,
          h: NODE_H,
        });
      gx += g.w + GAP_X;
    }
    boxes.push(box);
    x += d.w + GAP_X * 2;
  }

  // Edges. The bus sits in the gap above the row the lines leave from.
  const centre = (n: LaidNode) => n.x + n.w / 2;
  const connect = (child: LaidNode, parent: LaidNode, kind: LaidEdge['kind'], bus: number) =>
    edges.push({
      id: `${child.id}>${parent.id}`,
      from: child.id,
      to: parent.id,
      kind,
      d: elbow(centre(child), child.y, centre(parent), parent.y + parent.h, bus),
    });
  const managerNode = pos.get('manager') as LaidNode;
  for (const id of baIds) connect(pos.get(id) as LaidNode, managerNode, 'desk', yBa - GAP_Y / 2);
  for (const d of depts)
    for (const g of d.groups) {
      for (const a of g.tops) {
        const n = pos.get(a.id) as LaidNode;
        for (const id of baIds) connect(n, pos.get(id) as LaidNode, 'ba', yBox - GAP_Y / 2);
      }
      for (const a of g.under)
        for (const s of g.tops)
          connect(
            pos.get(a.id) as LaidNode,
            pos.get(s.id) as LaidNode,
            'peer',
            yTop + NODE_H + (yUnder - yTop - NODE_H) / 2,
          );
    }
  return { width, height: yBox + boxH, nodes, edges, boxes };
}
