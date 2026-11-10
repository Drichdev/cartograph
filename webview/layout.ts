import * as dagre from "@dagrejs/dagre";

export interface Box {
  id: string;
  width: number;
  height: number;
}

export function dagreLayout(
  boxes: Box[],
  edges: { source: string; target: string }[],
  opts: { dir?: "LR" | "TB"; ranksep?: number; nodesep?: number } = {}
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: opts.dir ?? "LR",
    ranksep: opts.ranksep ?? 90,
    nodesep: opts.nodesep ?? 28,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  const ids = new Set(boxes.map((b) => b.id));
  for (const b of boxes) g.setNode(b.id, { width: b.width, height: b.height });
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const b of boxes) {
    const n = g.node(b.id);
    out.set(b.id, { x: n.x - b.width / 2, y: n.y - b.height / 2 });
  }
  return out;
}

/** Colonnes par couche : lecture « de l'entrée vers les données ». */
export function columnLayout(
  boxes: (Box & { column: number; sort: string })[],
  gapX = 120,
  gapY = 22
): Map<string, { x: number; y: number }> {
  const cols = new Map<number, (Box & { column: number; sort: string })[]>();
  for (const b of boxes) {
    if (!cols.has(b.column)) cols.set(b.column, []);
    cols.get(b.column)!.push(b);
  }
  const used = [...cols.keys()].sort((a, b) => a - b);
  const out = new Map<string, { x: number; y: number }>();
  let x = 0;
  for (const c of used) {
    const items = cols.get(c)!.sort((a, b) => a.sort.localeCompare(b.sort));
    let y = 0;
    let w = 0;
    for (const it of items) {
      out.set(it.id, { x, y });
      y += it.height + gapY;
      w = Math.max(w, it.width);
    }
    x += w + gapX;
  }
  return out;
}
