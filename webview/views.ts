import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { CallFilters, Graph, IssueCount } from "./types";
import type { TFn } from "./i18n";
import type { DiffStatus } from "./diff";
import { EDGE_COLORS } from "./theme";
import { columnLayout, dagreLayout } from "./layout";

export interface ViewResult {
  nodes: Node[];
  edges: Edge[];
  meta: { total: number; shown: number; truncated: boolean };
}

const MAX_CALL_NODES = 450;

/** Traduit les libellés d'arêtes produits par les analyseurs (« enqueue », « broker »…) ; le reste est conservé. */
export function tl(t: TFn, label: string | null | undefined): string | null {
  if (!label) return null;
  return label.split(", ").map((p) => (p === "enqueue" || p === "broker" || p === "DI" ? t("edge." + p) : p)).join(", ");
}
const EMPTY: IssueCount = { error: 0, warning: 0, info: 0, security: 0 };

export function countIssues(g: Graph): Map<string, IssueCount> {
  const map = new Map<string, IssueCount>();
  for (const i of g.issues) {
    if (!i.node) continue;
    const c = map.get(i.node) ?? { error: 0, warning: 0, info: 0, security: 0 };
    c[i.severity]++;
    if (i.category === "security") c.security++;
    map.set(i.node, c);
  }
  return map;
}

type EdgeKind = "call" | "ref" | "async" | "uses" | "consume" | "broker" | "depends" | "runs" | "relation" | "http";

function mkEdge(
  id: string,
  source: string,
  target: string,
  kind: EdgeKind,
  o: { label?: string | null; dim?: boolean; certain?: boolean; count?: number; danger?: boolean } = {}
): Edge {
  const col = o.danger ? EDGE_COLORS.danger : EDGE_COLORS[kind];
  const dash =
    kind === "ref" ? "2 4" : kind === "async" ? "7 5" : kind === "depends" ? "1 5" : kind === "runs" ? "5 5" : o.certain === false ? "5 4" : undefined;
  const width = kind === "broker" || kind === "http" ? 2.2 : Math.min(3.2, 1.1 + Math.log2((o.count ?? 1) + 0.5) * 0.45);
  return {
    id,
    source,
    target,
    type: "default",
    animated: kind === "async",
    label: o.label ?? undefined,
    labelStyle: { fontSize: 10, fill: col },
    labelBgStyle: { fill: "var(--vscode-editor-background)", fillOpacity: 0.85 },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: col },
    style: {
      stroke: col,
      strokeWidth: width,
      strokeDasharray: dash,
      opacity: o.dim ? 0.08 : o.certain === false || kind === "ref" ? 0.55 : 0.9,
    },
    data: { kind },
  };
}

/** Tous les nœuds en amont et en aval (chaîne d'impact) d'un nœud. */
function chain(edges: { source: string; target: string }[], id: string, depth = 8): Set<string> {
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of edges) {
    (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    (inc.get(e.target) ?? inc.set(e.target, []).get(e.target)!).push(e.source);
  }
  const seen = new Set<string>([id]);
  for (const adj of [out, inc]) {
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const m of adj.get(n) ?? []) {
          if (!seen.has(m)) {
            seen.add(m);
            next.push(m);
          }
        }
      }
      frontier = next;
    }
  }
  return seen;
}

function neighbors(edges: { source: string; target: string }[], id: string): Set<string> {
  const s = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) s.add(e.target);
    if (e.target === id) s.add(e.source);
  }
  return s;
}

// ------------------------------------------------------------------ Appels
export function buildCalls(g: Graph, f: CallFilters, search: string, selected: string | null, counts: Map<string, IssueCount>, t: TFn, diff: Map<string, DiffStatus> | null = null): ViewResult {
  const q = search.trim().toLowerCase();
  const base = g.nodes.filter((n) => (f.modules || n.kind !== "module") && (f.tests || (n.entry !== "test" && n.layer !== "test")));
  const baseIds = new Set(base.map((n) => n.id));
  const edgesAll = g.edges.filter(
    (e) => e.kind !== "uses" && baseIds.has(e.source) && baseIds.has(e.target) && (f.refs || e.kind !== "ref") && (f.uncertain || e.certain)
  );
  const matches = new Set<string>();
  const filtering = !!q || f.focus !== "all";
  let visible = new Set<string>();
  if (filtering) {
    for (const n of base) {
      if (q && !(n.label.toLowerCase().includes(q) || n.file.toLowerCase().includes(q))) continue;
      const c = counts.get(n.id) ?? EMPTY;
      const ok =
        f.focus === "all" ||
        (f.focus === "dead" && !!n.dead) ||
        (f.focus === "dup" && n.dup !== null && n.dup !== undefined) ||
        (f.focus === "security" && c.security > 0) ||
        (f.focus === "complex" && n.complexity > 10) ||
        (f.focus === "errors" && c.error > 0);
      if (ok) matches.add(n.id);
    }
    visible = new Set(matches);
    for (const e of edgesAll) {
      if (matches.has(e.source)) visible.add(e.target);
      if (matches.has(e.target)) visible.add(e.source);
    }
  } else {
    visible = new Set(baseIds);
  }
  const total = visible.size;
  let truncated = false;
  if (visible.size > MAX_CALL_NODES) {
    const degree = new Map<string, number>();
    for (const e of edgesAll) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const ranked = [...visible].sort((a, b) => (matches.has(b) ? 1e6 : 0) + (degree.get(b) ?? 0) - ((matches.has(a) ? 1e6 : 0) + (degree.get(a) ?? 0)));
    visible = new Set(ranked.slice(0, MAX_CALL_NODES));
    truncated = true;
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edges = edgesAll.filter((e) => visible.has(e.source) && visible.has(e.target));

  // infrastructure rattachée aux fonctions visibles
  const infraEdges = f.infra ? g.edges.filter((e) => e.kind === "uses" && visible.has(e.source)) : [];
  const infraIds = new Set(infraEdges.map((e) => e.target));
  const infraNodes = g.infra.filter((i) => infraIds.has(i.id));

  const boxes = [
    ...[...visible].map((id) => ({ id, width: 214, height: 62 })),
    ...infraNodes.map((i) => ({ id: i.id, width: 190, height: 66 })),
  ];
  const dense = boxes.length > 220;
  const pos = dagreLayout(boxes, [...edges, ...infraEdges], { dir: "LR", ranksep: dense ? 70 : 100, nodesep: dense ? 12 : 26 });
  const focusSet = selected && (visible.has(selected) || infraIds.has(selected)) ? chain([...edges, ...infraEdges], selected) : null;

  const nodes: Node[] = [...visible].map((id) => {
    const fn = byId.get(id)!;
    return {
      id,
      type: "fn",
      position: pos.get(id)!,
      selected: id === selected,
      data: { fn, counts: counts.get(id) ?? EMPTY, dim: !!focusSet && !focusSet.has(id), match: matches.has(id) && filtering, diff: diff?.get(id) },
    };
  });
  for (const i of infraNodes) {
    nodes.push({
      id: i.id,
      type: "infra",
      position: pos.get(i.id)!,
      selected: i.id === selected,
      data: { label: i.label, sub: i.type, declared: i.declared, service: i.service, libs: i.libs, uses: i.uses, dim: !!focusSet && !focusSet.has(i.id) },
    });
  }
  const labelled = edges.length + infraEdges.length < 70;
  const out: Edge[] = [
    ...edges.map((e) =>
      mkEdge(`${e.source}>${e.target}>${e.kind}`, e.source, e.target, e.kind, {
        certain: e.certain,
        count: e.count,
        label: e.kind === "async" && labelled ? tl(t, e.label) : null,
        dim: !!focusSet && !(focusSet.has(e.source) && focusSet.has(e.target)),
      })
    ),
    ...infraEdges.map((e) =>
      mkEdge(`${e.source}>${e.target}>uses`, e.source, e.target, "uses", {
        count: e.count,
        label: labelled ? tl(t, e.label) : null,
        dim: !!focusSet && !(focusSet.has(e.source) && focusSet.has(e.target)),
      })
    ),
  ];
  return { nodes, edges: out, meta: { total, shown: visible.size, truncated } };
}

// ------------------------------------------------------------------ Architecture
export function buildArchitecture(g: Graph, showTests: boolean, search: string, selected: string | null, counts: Map<string, IssueCount>, t: TFn): ViewResult {
  const q = search.trim().toLowerCase();
  const connected = new Set<string>();
  for (const e of g.moduleEdges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  const cycleSet = new Set(g.cycles.flat().map((n) => `mod:${n}`));
  const mods = g.modules.filter((m) => (showTests || m.layer !== "test") && (m.functions > 0 || m.classes > 0 || connected.has(m.id)));
  const ids = new Set(mods.map((m) => m.id));
  const edges = g.moduleEdges.filter((e) => ids.has(e.source) && ids.has(e.target));

  const infraAgg = new Map<string, { count: number; ops: Set<string> }>();
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    if (e.kind !== "uses") continue;
    const src = byId.get(e.source);
    const mid = `mod:${src ? src.module : e.source.replace(/^mod:/, "")}`;
    if (!ids.has(mid)) continue;
    const k = `${mid}|${e.target}`;
    const a = infraAgg.get(k) ?? { count: 0, ops: new Set<string>() };
    a.count += e.count;
    (e.label ?? "").split(", ").filter(Boolean).forEach((o) => a.ops.add(o));
    infraAgg.set(k, a);
  }
  const infraUsed = new Set([...infraAgg.keys()].map((k) => k.split("|")[1]));
  const infra = g.infra.filter((i) => infraUsed.has(i.id) || i.uses === 0);

  const order = [...g.layers, "infra"];
  const boxes = [
    ...mods.map((m) => ({ id: m.id, width: 226, height: 74, column: order.indexOf(m.layer), sort: m.name })),
    ...infra.map((i) => ({ id: i.id, width: 190, height: 66, column: order.length, sort: i.label })),
  ];
  const pos = columnLayout(boxes, 150, 18);
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const focus = selected ? neighbors([...edges, ...[...infraAgg.keys()].map((k) => ({ source: k.split("|")[0], target: k.split("|")[1] }))], selected) : null;

  const nodes: Node[] = [
    ...mods.map((m) => ({
      id: m.id,
      type: "mod",
      position: pos.get(m.id)!,
      selected: m.id === selected,
      data: { mod: m, counts: counts.get(m.id) ?? EMPTY, inCycle: cycleSet.has(m.id), dim: !match(m.name) || (!!focus && !focus.has(m.id)) },
    })),
    ...infra.map((i) => ({
      id: i.id,
      type: "infra",
      position: pos.get(i.id)!,
      selected: i.id === selected,
      data: { label: i.label, sub: i.type, declared: i.declared, service: i.service, libs: i.libs, uses: i.uses, dim: !match(i.label) || (!!focus && !focus.has(i.id)) },
    })),
  ];
  const out: Edge[] = [
    ...edges.map((e) =>
      mkEdge(`${e.source}>${e.target}`, e.source, e.target, e.calls > 0 ? "call" : "ref", {
        count: e.calls || 1,
        danger: e.violation,
        label: e.violation ? t("edge.violation") : null,
        dim: !!focus && !(focus.has(e.source) && focus.has(e.target)),
      })
    ),
    ...[...infraAgg.entries()].map(([k, a]) => {
      const [s, t] = k.split("|");
      return mkEdge(`${k}>uses`, s, t, "uses", { count: a.count, label: [...a.ops].slice(0, 3).join(", "), dim: !!focus && !(focus.has(s) && focus.has(t)) });
    }),
    ...g.infraLinks
      .filter((l) => infra.some((i) => i.id === l.source) && infra.some((i) => i.id === l.target))
      .map((l) => mkEdge(`${l.source}>${l.target}>broker`, l.source, l.target, "broker", { label: t("edge.broker") })),
  ];
  return { nodes, edges: out, meta: { total: mods.length, shown: mods.length, truncated: false } };
}

// ------------------------------------------------------------------ Système
export function buildSystem(g: Graph, search: string, selected: string | null, t: TFn): ViewResult {
  const q = search.trim().toLowerCase();
  const sys = g.system;
  const boxes = sys.nodes.map((n) => ({
    id: n.id,
    width: n.kind === "infra" ? 196 : n.kind === "routes" ? 236 : 224,
    height: n.kind === "routes" ? 66 + Math.min(4, (n.members ?? []).length) * 15 : n.kind === "infra" ? 70 : 64,
  }));
  const pos = dagreLayout(boxes, sys.edges, { dir: "LR", ranksep: 130, nodesep: 30 });
  const focus = selected ? neighbors(sys.edges, selected) : null;
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const nodes: Node[] = sys.nodes.map((n) =>
    n.kind === "infra"
      ? {
          id: n.id,
          type: "infra",
          position: pos.get(n.id)!,
          selected: n.id === selected,
          data: { label: n.label, sub: n.sub, declared: n.declared, service: n.service, libs: n.libs, uses: n.uses, dim: !match(n.label) || (!!focus && !focus.has(n.id)) },
        }
      : {
          id: n.id,
          type: "sys",
          position: pos.get(n.id)!,
          selected: n.id === selected,
          data: { node: n, dim: !match(n.label + " " + (n.members ?? []).join(" ")) || (!!focus && !focus.has(n.id)) },
        }
  );
  const edges = sys.edges.map((e) =>
    mkEdge(`${e.source}>${e.target}>${e.kind}`, e.source, e.target, e.kind, {
      label: tl(t, e.label),
      dim: !!focus && !(focus.has(e.source) && focus.has(e.target)),
    })
  );
  return { nodes, edges, meta: { total: nodes.length, shown: nodes.length, truncated: false } };
}

// ------------------------------------------------------------------ Données
const singular = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
export function modelForTable(g: Graph, table: string): Graph["models"][number] | null {
  const t = singular(table);
  for (const m of g.models) {
    const n = singular(m.name);
    if ((m.tablename && singular(m.tablename) === t) || n === t || n + "s" === t || n + "es" === t || n === t + "s") return m;
  }
  return null;
}

export function tableId(dbId: string, table: string): string {
  return `tbl:${dbId}:${table}`;
}

export function buildData(g: Graph, search: string, selected: string | null, schema: boolean, tr: TFn): ViewResult {
  const q = search.trim().toLowerCase();
  const stores = new Set(g.models.map((m) => (m.store ? `infra:${m.store}` : null)).filter(Boolean) as string[]);
  const infra = g.infra.filter((i) => stores.has(i.id));
  const edgesBase: { source: string; target: string; label: string; kind: string }[] = [
    ...g.modelEdges,
    ...g.models.filter((m) => m.store && stores.has(`infra:${m.store}`)).map((m) => ({ source: m.id, target: `infra:${m.store}`, label: tr("edge.stored"), kind: "store" })),
  ];
  const boxes: { id: string; width: number; height: number }[] = [
    ...g.models.map((m) => ({ id: m.id, width: 240, height: 48 + Math.min(8, m.nFields || 1) * 21 + (m.nFields > 8 ? 20 : 0) })),
    ...infra.map((i) => ({ id: i.id, width: 196, height: 70 })),
  ];
  const tableNodes: { id: string; t: Graph["models"][number] | null; db: NonNullable<Graph["dbSchemas"]>[number]; table: NonNullable<Graph["dbSchemas"]>[number]["tables"][number] }[] = [];
  if (schema) {
    for (const db of g.dbSchemas ?? []) {
      const names = new Set(db.tables.map((t) => t.name));
      for (const t of db.tables) {
        const id = tableId(db.id, t.name);
        const m = modelForTable(g, t.name);
        tableNodes.push({ id, t: m, db, table: t });
        boxes.push({ id, width: 240, height: 66 + Math.min(8, t.columns.length) * 21 + (t.columns.length > 8 ? 20 : 0) + 22 });
        for (const c of t.columns) {
          if (!c.fk) continue;
          const target = c.fk.split(".")[0];
          if (names.has(target) && target !== t.name) edgesBase.push({ source: id, target: tableId(db.id, target), label: c.name, kind: "relation" });
        }
        if (m) edgesBase.push({ source: m.id, target: id, label: tr("edge.table"), kind: "depends" });
      }
    }
  }
  const pos = dagreLayout(boxes, edgesBase, { dir: "LR", ranksep: 120, nodesep: 30 });
  const focus = selected ? neighbors(edgesBase, selected) : null;
  const nodes: Node[] = [
    ...g.models.map((m) => ({
      id: m.id,
      type: "model",
      position: pos.get(m.id)!,
      selected: m.id === selected,
      data: { model: m, dim: (!!q && !m.name.toLowerCase().includes(q)) || (!!focus && !focus.has(m.id)) },
    })),
    ...infra.map((i) => ({
      id: i.id,
      type: "infra",
      position: pos.get(i.id)!,
      selected: i.id === selected,
      data: { label: i.label, sub: i.type, declared: i.declared, service: i.service, libs: i.libs, uses: i.uses, dim: !!focus && !focus.has(i.id) },
    })),
    ...tableNodes.map((tn) => ({
      id: tn.id,
      type: "table",
      position: pos.get(tn.id)!,
      selected: tn.id === selected,
      data: { table: tn.table, db: tn.db.name, dbType: tn.db.type, model: tn.t?.name ?? null, dim: (!!q && !tn.table.name.toLowerCase().includes(q)) || (!!focus && !focus.has(tn.id)) },
    })),
  ];
  const edges = edgesBase.map((e, idx) =>
    mkEdge(`m${idx}`, e.source, e.target, e.kind === "store" ? "uses" : e.kind === "depends" ? "depends" : "relation", {
      label: e.label,
      dim: !!focus && !(focus.has(e.source) && focus.has(e.target)),
    })
  );
  return { nodes, edges, meta: { total: g.models.length + tableNodes.length, shown: nodes.length, truncated: false } };
}
