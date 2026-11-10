/* Fusion des graphes Python et TypeScript + liens HTTP front → back. */

const LAYER_ORDER = ["route", "ui", "worker", "service", "repository", "model", "core", "util", "other", "test"];
const SUM_KEYS = ["files", "functions", "classes", "loc", "dead", "duplicates", "cycles", "routes", "workers", "models", "securityHigh", "parsed", "cached", "seconds"];

type G = any;

const normSegments = (p: string): string[] =>
  p
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map((s) => (/^(\{.*\}|:.+|<.+>|\[.+\])$/.test(s) ? "{}" : s.toLowerCase()));

function matches(urlSegs: string[], routeSegs: string[]): boolean {
  const r = routeSegs.length;
  const t = urlSegs.length;
  if (r < 1 || t < r || t - r > 2) return false;
  if (r === 1 && routeSegs[0] === "{}") return false;
  let literal = 0;
  for (let i = 0; i < r; i++) {
    const a = urlSegs[t - r + i];
    const b = routeSegs[i];
    if (a !== b && a !== "{}" && b !== "{}") return false;
    if (a === b && a !== "{}") literal++;
  }
  return literal >= 1;
}

function sameMethod(callMethod: string, routeMethod: string): boolean {
  const ms = routeMethod.split(",");
  return ms.includes("ANY") || ms.includes("ALL") || ms.includes(callMethod);
}

/** Relie les appels fetch/axios aux routes (Python ou Next.js) dont le chemin correspond. */
export function linkHttp(g: G): void {
  const routes = g.nodes.filter((n: G) => n.route && n.route.method !== "PAGE").map((n: G) => ({ id: n.id, method: n.route.method, path: n.route.path || "/", segs: normSegments(n.route.path || "/") }));
  if (!routes.length) return;
  const find = (method: string, url: string) => {
    const segs = normSegments(url);
    return routes.filter((r: G) => matches(segs, r.segs) && sameMethod(method, r.method)).slice(0, 3);
  };
  const seen = new Set<string>();
  const sysOf = new Map<string, string>();
  for (const sn of g.system.nodes) for (const id of sn.ids ?? []) sysOf.set(id, sn.id);

  for (const c of g.httpCalls ?? []) {
    for (const r of find(c.method, c.url)) {
      if (c.fn === r.id) continue;
      const k = `${c.fn}>${r.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      g.edges.push({ source: c.fn, target: r.id, kind: "call", certain: true, count: 1, label: "HTTP" });
    }
  }
  const sysSeen = new Map<string, Set<string>>();
  for (const sn of g.system.nodes) {
    for (const h of sn.http ?? []) {
      for (const r of find(h.method, h.url)) {
        const target = sysOf.get(r.id);
        if (!target || target === sn.id) continue;
        const k = `${sn.id}>${target}`;
        const labels = sysSeen.get(k) ?? sysSeen.set(k, new Set()).get(k)!;
        labels.add(`${r.method.split(",")[0]} ${r.path}`);
      }
    }
  }
  for (const [k, labels] of sysSeen) {
    const [source, target] = k.split(">");
    g.system.edges.push({ source, target, kind: "http", label: [...labels].slice(0, 2).join(", ") });
  }
}

/** Fusionne les graphes de plusieurs analyseurs (Python, TypeScript, Go/Java/Rust…) puis relie les appels HTTP. */
export function mergeGraphs(list: (G | null | undefined)[]): G | null {
  const parts = list.filter((x): x is G => !!x && (x.metrics?.files ?? 0) > 0);
  if (parts.length === 0) return list.find((x) => !!x) ?? null;
  const g = parts.reduce((acc, cur) => (acc === cur ? acc : mergeTwo(acc, cur)));
  g.layers = LAYER_ORDER.filter((l) => g.layers.includes(l) || g.nodes.some((n: G) => n.layer === l));
  linkHttp(g);
  return g;
}

function mergeTwo(a: G, b: G): G {
  const offset = a.duplicates.length;
  const bNodes = b.nodes.map((n: G) => (n.dup !== null && n.dup !== undefined ? { ...n, dup: n.dup + offset } : n));
  const bIssues = b.issues.map((i: G) => (i.group !== undefined ? { ...i, group: i.group + offset } : i));

  const infra = new Map<string, G>();
  for (const i of [...a.infra, ...b.infra]) {
    const e = infra.get(i.id);
    infra.set(i.id, e ? { ...e, libs: [...new Set([...e.libs, ...i.libs])].sort(), declared: e.declared || i.declared, service: e.service ?? i.service, uses: e.uses + i.uses, queue: e.queue || i.queue } : { ...i });
  }
  const links = new Map<string, G>();
  for (const l of [...a.infraLinks, ...b.infraLinks]) links.set(`${l.source}>${l.target}`, l);

  const sysNodes = new Map<string, G>();
  for (const n of [...a.system.nodes, ...b.system.nodes]) {
    if (n.kind === "infra") continue;
    sysNodes.set(n.id, n);
  }
  for (const i of infra.values()) sysNodes.set(i.id, { id: i.id, label: i.label, kind: "infra", sub: i.type, declared: i.declared, service: i.service, libs: i.libs, uses: i.uses });
  const sysEdges = new Map<string, G>();
  for (const e of [...a.system.edges, ...b.system.edges]) {
    const k = `${e.source}>${e.target}>${e.kind}`;
    const old = sysEdges.get(k);
    sysEdges.set(k, old ? { ...old, label: [...new Set([...(old.label ?? "").split(", "), ...(e.label ?? "").split(", ")].filter(Boolean))].join(", ") || null } : e);
  }

  const metrics: G = {};
  for (const k of SUM_KEYS) metrics[k] = Math.round(((a.metrics[k] ?? 0) + (b.metrics[k] ?? 0)) * 100) / 100;
  const nf = a.metrics.functions + b.metrics.functions;
  metrics.avgComplexity = nf ? Math.round(((a.metrics.avgComplexity * a.metrics.functions + b.metrics.avgComplexity * b.metrics.functions) / nf) * 10) / 10 : 0;
  metrics.infra = infra.size;

  const issues = [...a.issues, ...bIssues].map((i: G, n: number) => ({ ...i, id: `i${n}` }));
  const g: G = {
    version: a.version, root: a.root, generatedAt: Math.max(a.generatedAt, b.generatedAt), metrics,
    nodes: [...a.nodes, ...bNodes], edges: [...a.edges, ...b.edges], modules: [...a.modules, ...b.modules],
    moduleEdges: [...a.moduleEdges, ...b.moduleEdges], models: [...a.models, ...b.models], modelEdges: [...a.modelEdges, ...b.modelEdges],
    infra: [...infra.values()], infraLinks: [...links.values()],
    system: { nodes: [...sysNodes.values()], edges: [...sysEdges.values()] },
    issues, duplicates: [...a.duplicates, ...b.duplicates], cycles: [...a.cycles, ...b.cycles],
    dbSchemas: [...(a.dbSchemas ?? []), ...(b.dbSchemas ?? [])], httpCalls: [...(a.httpCalls ?? []), ...(b.httpCalls ?? [])],
    layers: LAYER_ORDER,
  };
  return g;
}
