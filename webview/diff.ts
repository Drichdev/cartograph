import type { FnNode, GEdge, Graph, Infra, Issue, Model } from "./types";

export type DiffStatus = "added" | "changed";

export interface FnChange {
  cur: FnNode;
  base: FnNode;
  dCx: number;
  dLoc: number;
  argsChanged: boolean;
}

export interface Diff {
  fnAdded: FnNode[];
  fnRemoved: FnNode[];
  fnChanged: FnChange[];
  fnMoved: { from: FnNode; to: FnNode }[];
  routesAdded: string[];
  routesRemoved: string[];
  infraAdded: Infra[];
  infraRemoved: Infra[];
  depsAdded: { source: string; target: string }[];
  depsRemoved: { source: string; target: string }[];
  callsAdded: GEdge[];
  callsRemoved: GEdge[];
  issuesNew: Issue[];
  issuesResolved: Issue[];
  modelsAdded: Model[];
  modelsRemoved: Model[];
  modelsChanged: { name: string; added: string[]; removed: string[]; cur: Model }[];
  metrics: { key: string; base: number; cur: number }[];
  status: Map<string, DiffStatus>;
  total: number;
}

const METRIC_KEYS = ["files", "functions", "loc", "avgComplexity", "dead", "duplicates", "cycles", "routes", "workers", "infra", "models", "securityHigh"] as const;

const routeKey = (n: FnNode) => `${n.route!.method} ${n.route!.path || "/"}`;
const issueKey = (i: Issue) => `${i.category}|${i.rule}|${i.file}|${i.message}`;
const edgeKey = (e: { source: string; target: string }) => `${e.source}>${e.target}`;

export function diffGraphs(base: Graph, cur: Graph): Diff {
  const baseFns = new Map(base.nodes.filter((n) => n.kind !== "module").map((n) => [n.id, n]));
  const curFns = new Map(cur.nodes.filter((n) => n.kind !== "module").map((n) => [n.id, n]));
  const status = new Map<string, DiffStatus>();

  let fnAdded = [...curFns.values()].filter((n) => !baseFns.has(n.id));
  let fnRemoved = [...baseFns.values()].filter((n) => !curFns.has(n.id));

  // déplacement : même nom qualifié, autre module
  const fnMoved: { from: FnNode; to: FnNode }[] = [];
  const removedByQual = new Map<string, FnNode[]>();
  for (const r of fnRemoved) (removedByQual.get(r.label) ?? removedByQual.set(r.label, []).get(r.label)!).push(r);
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const a of fnAdded) {
    const cand = (removedByQual.get(a.label) ?? []).find((r) => !movedFrom.has(r.id) && r.module !== a.module);
    if (cand) {
      fnMoved.push({ from: cand, to: a });
      movedFrom.add(cand.id);
      movedTo.add(a.id);
    }
  }
  fnAdded = fnAdded.filter((n) => !movedTo.has(n.id));
  fnRemoved = fnRemoved.filter((n) => !movedFrom.has(n.id));

  const fnChanged: FnChange[] = [];
  for (const [id, c] of curFns) {
    const b = baseFns.get(id);
    if (!b) continue;
    const dCx = c.complexity - b.complexity;
    const dLoc = c.loc - b.loc;
    const argsChanged = c.args.join(",") !== b.args.join(",");
    if (Math.abs(dCx) >= 3 || Math.abs(dLoc) >= Math.max(10, b.loc * 0.2) || argsChanged) fnChanged.push({ cur: c, base: b, dCx, dLoc, argsChanged });
  }
  fnAdded.forEach((n) => status.set(n.id, "added"));
  fnMoved.forEach((m) => status.set(m.to.id, "added"));
  fnChanged.forEach((c) => status.set(c.cur.id, "changed"));

  const routes = (g: Graph) => new Set(g.nodes.filter((n) => n.route).map(routeKey));
  const bR = routes(base), cR = routes(cur);
  const routesAdded = [...cR].filter((r) => !bR.has(r));
  const routesRemoved = [...bR].filter((r) => !cR.has(r));

  const bI = new Map(base.infra.map((i) => [i.id, i]));
  const cI = new Map(cur.infra.map((i) => [i.id, i]));
  const infraAdded = [...cI.values()].filter((i) => !bI.has(i.id));
  const infraRemoved = [...bI.values()].filter((i) => !cI.has(i.id));

  const deps = (g: Graph) => new Map(g.moduleEdges.map((e) => [edgeKey(e), e]));
  const bD = deps(base), cD = deps(cur);
  const depsAdded = [...cD.entries()].filter(([k]) => !bD.has(k)).map(([, e]) => ({ source: e.source, target: e.target }));
  const depsRemoved = [...bD.entries()].filter(([k]) => !cD.has(k)).map(([, e]) => ({ source: e.source, target: e.target }));

  const calls = (g: Graph) => new Map(g.edges.filter((e) => e.kind === "call" || e.kind === "async").map((e) => [edgeKey(e), e]));
  const bC = calls(base), cC = calls(cur);
  const callsAdded = [...cC.entries()].filter(([k, e]) => !bC.has(k) && baseFns.has(e.source) && baseFns.has(e.target)).map(([, e]) => e);
  const callsRemoved = [...bC.entries()].filter(([k, e]) => !cC.has(k) && curFns.has(e.source) && curFns.has(e.target)).map(([, e]) => e);

  const own = (g: Graph) => g.issues.filter((i) => i.source === "cartograph" && i.category !== "dead");
  const bIs = new Map(own(base).map((i) => [issueKey(i), i]));
  const cIs = new Map(own(cur).map((i) => [issueKey(i), i]));
  const issuesNew = [...cIs.entries()].filter(([k]) => !bIs.has(k)).map(([, i]) => i);
  const issuesResolved = [...bIs.entries()].filter(([k]) => !cIs.has(k)).map(([, i]) => i);

  const bM = new Map(base.models.map((m) => [m.id, m]));
  const cM = new Map(cur.models.map((m) => [m.id, m]));
  const modelsAdded = [...cM.values()].filter((m) => !bM.has(m.id));
  const modelsRemoved = [...bM.values()].filter((m) => !cM.has(m.id));
  const modelsChanged: Diff["modelsChanged"] = [];
  for (const [id, m] of cM) {
    const b = bM.get(id);
    if (!b) continue;
    const bf = new Set(b.fields.map((f) => f.name)), cf = new Set(m.fields.map((f) => f.name));
    const added = [...cf].filter((f) => !bf.has(f)), removed = [...bf].filter((f) => !cf.has(f));
    if (added.length || removed.length) modelsChanged.push({ name: m.name, added, removed, cur: m });
  }

  const metrics = METRIC_KEYS.map((key) => ({ key, base: Number((base.metrics as any)[key] ?? 0), cur: Number((cur.metrics as any)[key] ?? 0) }));
  const total =
    fnAdded.length + fnRemoved.length + fnChanged.length + fnMoved.length + routesAdded.length + routesRemoved.length + infraAdded.length + infraRemoved.length +
    depsAdded.length + depsRemoved.length + callsAdded.length + callsRemoved.length + issuesNew.length + issuesResolved.length + modelsAdded.length + modelsRemoved.length + modelsChanged.length;
  return {
    fnAdded, fnRemoved, fnChanged, fnMoved, routesAdded, routesRemoved, infraAdded, infraRemoved, depsAdded, depsRemoved, callsAdded, callsRemoved,
    issuesNew, issuesResolved, modelsAdded, modelsRemoved, modelsChanged, metrics, status, total,
  };
}
