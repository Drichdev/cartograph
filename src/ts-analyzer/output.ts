import { INFRA, QUEUE_IDS, STRICT_LAYERS, VERSION, WRITE_METHODS, infraForPackage } from "./config";
import type { ModelsResult, ModelOut } from "./models";
import type { Issue, Rec, State } from "./types";

const LAYERS = ["route", "ui", "worker", "service", "repository", "model", "core", "util", "other", "test"];
const topN = (m: Map<string, number>, n = 3) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map((e) => e[0]);
const FRAMEWORK_METHODS = new Set(["canActivate", "intercept", "transform", "catch", "use", "onModuleInit", "onModuleDestroy", "onApplicationBootstrap", "onApplicationShutdown", "render", "componentDidMount", "componentDidUpdate", "componentWillUnmount", "ngOnInit", "ngOnDestroy", "ngOnChanges"]);
const INFRA_BY_ID = new Map(INFRA.map((i) => [i[0], i]));
const PRISMA_REMAP = new Set(["postgres", "mysql", "sqlite", "mongodb"]);

export function finalize(S: State, models: ModelOut[], t0: number, mr?: ModelsResult) {
  const recs = S.recs;
  const mods = [...S.modules.values()];
  const issue = (i: Omit<Issue, "id" | "source" | "level"> & { level?: Issue["level"] }) => S.issues.push({ id: "", source: "cartograph", level: null, params: {}, ...i });

  // ---- entrées, authentification, tests
  for (const r of recs) {
    const mod = S.modules.get(r.module)!;
    if (!r.entry && mod.layer === "test") r.entry = "test";
    if (!r.entry && r.name === "main" && !r.qual.includes(".")) r.entry = "main";
    if (!r.entry && r.qual.includes(".") && FRAMEWORK_METHODS.has(r.name)) r.entry = "handler";
    if (r.route) r.route.auth = r.route.method === "PAGE" || (r as any).authUnknown ? null : r.auth;
  }
  const layerOf = (r: Rec) => (r.route ? "route" : r.worker ? "worker" : S.modules.get(r.module)!.layer);

  // ---- infra : opérations par fonction
  const remap = new Map<string, string>();
  if (mr?.prismaStore && PRISMA_REMAP.has(mr.prismaStore)) remap.set("sql", mr.prismaStore);
  const opsBy = new Map<string, Map<string, Map<string, number>>>();
  for (const [k, ops] of S.infraOps) {
    const [fid, iid0] = k.split("|");
    const iid = remap.get(iid0) ?? iid0;
    const byInfra = opsBy.get(fid) ?? new Map();
    const m = byInfra.get(iid) ?? new Map<string, number>();
    for (const [op, n] of ops) m.set(op, (m.get(op) ?? 0) + n);
    byInfra.set(iid, m);
    opsBy.set(fid, byInfra);
  }
  const used = new Map<string, number>();
  const libs = new Map<string, Set<string>>();
  for (const [fid, byInfra] of opsBy) {
    void fid;
    for (const [iid, ops] of byInfra) used.set(iid, (used.get(iid) ?? 0) + [...ops.values()].reduce((a, b) => a + b, 0));
  }
  for (const m of mods) {
    for (const pkg of m.pkgs) {
      let id = infraForPackage(pkg);
      if (!id) continue;
      id = remap.get(id) ?? id;
      if (!used.has(id)) used.set(id, 0);
      (libs.get(id) ?? libs.set(id, new Set()).get(id)!).add(pkg);
    }
  }
  for (const [id0, set] of S.infraLibs) {
    const id = remap.get(id0) ?? id0;
    if (!used.has(id)) used.set(id, 0);
    for (const l of set) (libs.get(id) ?? libs.set(id, new Set()).get(id)!).add(l);
  }
  for (const mo of models) if (mo.store) used.set(mo.store, used.get(mo.store) ?? 0);
  const infraLinks: { source: string; target: string; kind: string; label: string }[] = [];
  if (used.has("bullmq")) {
    if (!used.has("redis")) used.set("redis", 0);
    infraLinks.push({ source: "infra:bullmq", target: "infra:redis", kind: "broker", label: "broker" });
  }
  if (recs.some((r) => r.worker?.lib === "scheduler") && !used.has("scheduler")) used.set("scheduler", 1);
  const infra = [...used.entries()].map(([id, n]) => {
    const spec = INFRA_BY_ID.get(id) ?? [id, id, "external", []];
    return { id: `infra:${id}`, label: spec[1], type: spec[2], libs: [...(libs.get(id) ?? [])].sort(), declared: false, service: null, uses: n, queue: QUEUE_IDS.has(id) };
  });

  // ---- arêtes
  const edges: any[] = [...S.edges.values()].map((e) => ({ ...e }));
  const infraEdges: any[] = [];
  for (const [fid, byInfra] of opsBy) for (const [iid, ops] of byInfra) infraEdges.push({ source: fid, target: `infra:${iid}`, kind: "uses", certain: true, count: [...ops.values()].reduce((a, b) => a + b, 0), label: topN(ops).join(", ") });
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const e of S.edges.values()) {
    incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + 1);
  }

  // ---- code mort
  for (const r of recs) {
    r.callers = incoming.get(r.id) ?? 0;
    r.callees2 = outgoing.get(r.id) ?? 0;
    if (r.callers || r.entry || r.name === "constructor" || r.name === "<init>") continue;
    const low = r.exported || r.qual.includes(".") || r.decorators.length > 0;
    r.dead = { confidence: low ? "low" : "high" };
    issue({
      severity: "info", category: "dead", rule: "unused-function",
      message: `« ${r.qual} » n'est référencée nulle part${low ? (r.exported ? " (exportée : API publique possible)" : " (méthode : appel dynamique possible)") : ""}`,
      params: { name: r.qual, why: low ? (r.exported ? "exported" : "dynamic") : "" },
      file: r.file, line: r.line, node: r.id, confidence: low ? "low" : "high",
    });
  }
  for (const r of recs) {
    if (r.complexity > 10) issue({ severity: r.complexity > 25 ? "error" : "warning", category: "complexity", rule: "high-complexity", message: `« ${r.qual} » a une complexité cyclomatique de ${r.complexity}`, params: { name: r.qual, n: r.complexity }, file: r.file, line: r.line, node: r.id });
    if (r.loc > 80) issue({ severity: "info", category: "quality", rule: "long-function", message: `« ${r.qual} » fait ${r.loc} lignes`, params: { name: r.qual, n: r.loc }, file: r.file, line: r.line, node: r.id });
    if (r.args.length > 7) issue({ severity: "info", category: "quality", rule: "many-args", message: `« ${r.qual} » prend ${r.args.length} arguments`, params: { name: r.qual, n: r.args.length }, file: r.file, line: r.line, node: r.id });
    if (r.route && r.route.auth === false && WRITE_METHODS.has(r.route.method)) issue({ severity: "warning", category: "security", rule: "route-no-auth", message: `Route ${r.route.method} ${r.route.path || "/"} sans authentification apparente`, params: { method: r.route.method, path: r.route.path || "/" }, file: r.file, line: r.line, node: r.id, level: "medium" });
  }

  // ---- doublons
  const groups: { kind: string; similarity: number; members: string[] }[] = [];
  const cands = recs.filter((r) => r.toks.length >= 30 && r.nstmts >= 2);
  const byHash = new Map<string, Rec[]>();
  for (const r of cands) {
    const h = r.toks.join(",") + "|" + r.callees.join(",");
    (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(r);
  }
  const seen = new Set<string>();
  for (const m of byHash.values()) if (m.length > 1) { groups.push({ kind: "exact", similarity: 1, members: m.map((x) => x.id) }); m.forEach((x) => seen.add(x.id)); }
  const pool = cands.filter((r) => r.toks.length >= 40 && !seen.has(r.id)).sort((a, b) => b.toks.length - a.toks.length).slice(0, 900);
  const sigs = new Map<string, Set<string>>();
  for (const r of pool) {
    const s = new Set<string>();
    for (let i = 0; i < r.toks.length - 2; i++) s.add(`${r.toks[i]} ${r.toks[i + 1]} ${r.toks[i + 2]}`);
    r.callees.forEach((c) => s.add("c:" + c));
    sigs.set(r.id, s);
  }
  const usedIds = new Set<string>();
  pool.forEach((a, i) => {
    if (usedIds.has(a.id)) return;
    const grp = [a.id];
    let best = 0;
    for (const b of pool.slice(i + 1)) {
      if (usedIds.has(b.id)) continue;
      if (b.toks.length < a.toks.length * 0.75) break;
      const sa = sigs.get(a.id)!, sb = sigs.get(b.id)!;
      let inter = 0;
      for (const x of sa) if (sb.has(x)) inter++;
      if (!inter) continue;
      const sim = inter / (sa.size + sb.size - inter);
      if (sim >= 0.85) { grp.push(b.id); best = Math.max(best, sim); }
    }
    if (grp.length > 1) { grp.forEach((g) => usedIds.add(g)); groups.push({ kind: "similar", similarity: Math.round(best * 100) / 100, members: grp }); }
  });
  groups.forEach((g, gi) => {
    for (const id of g.members) {
      const r = S.byId.get(id)!;
      r.dup = gi;
      const others = g.members.filter((m) => m !== id).map((m) => S.byId.get(m)!.qual).join(", ").slice(0, 160);
      issue({
        params: { others, pct: Math.round(g.similarity * 100) },
        severity: "info", category: "duplicate", rule: "duplicate-" + g.kind,
        message: (g.kind === "exact" ? "Structure identique à : " : `Fonction très similaire (${Math.round(g.similarity * 100)} %) à : `) + g.members.filter((m) => m !== id).map((m) => S.byId.get(m)!.qual).join(", ").slice(0, 160),
        file: r.file, line: r.line, node: id, group: gi,
      });
    }
  });

  // ---- modules
  const modEdgeMap = new Map<string, { imports: boolean; calls: number }>();
  for (const m of mods) {
    for (const f of m.imports) {
      const t = S.fileToMod.get(f);
      if (t && t.name !== m.name) modEdgeMap.set(`${m.name}>${t.name}`, { imports: true, calls: 0 });
    }
  }
  const modOf = (id: string) => (S.byId.get(id)?.module ?? (id.startsWith("mod:") ? id.slice(4) : null));
  for (const e of S.edges.values()) {
    const a = modOf(e.source), b = modOf(e.target);
    if (a && b && a !== b && S.modules.has(a) && S.modules.has(b)) {
      const d = modEdgeMap.get(`${a}>${b}`) ?? { imports: false, calls: 0 };
      d.calls += e.count;
      modEdgeMap.set(`${a}>${b}`, d);
    }
  }
  const moduleEdges: any[] = [];
  for (const [k, d] of modEdgeMap) {
    const [a, b] = k.split(">");
    const la = S.modules.get(a)!.layer, lb = S.modules.get(b)!.layer;
    const violation = la in STRICT_LAYERS && lb in STRICT_LAYERS && STRICT_LAYERS[la] > STRICT_LAYERS[lb];
    moduleEdges.push({ source: `mod:${a}`, target: `mod:${b}`, imports: d.imports, calls: d.calls, violation });
    if (violation) issue({ severity: "warning", category: "architecture", rule: "layer-violation", message: `Dépendance remontante : ${la} → ${lb} (${a} importe ${b})`, params: { from: la, to: lb, src: a, dst: b }, file: S.modules.get(a)!.file, line: 1, node: `mod:${a}` });
  }
  // cycles (Tarjan)
  const graph = new Map<string, string[]>();
  for (const e of moduleEdges) if (e.imports) (graph.get(e.source) ?? graph.set(e.source, []).get(e.source)!).push(e.target);
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>(), stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;
  const strong = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) { const w = stack.pop()!; onStack.delete(w); comp.push(w); if (w === v) break; }
      if (comp.length > 1) cycles.push(comp.map((c) => c.slice(4)).sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) strong(v);
  for (const comp of cycles) for (const mname of comp) issue({ severity: "warning", category: "architecture", rule: "circular-import", message: "Import circulaire : " + comp.slice(0, 5).join(" ↔ "), params: { mods: comp.slice(0, 5).join(" ↔ ") }, file: S.modules.get(mname)!.file, line: 1, node: `mod:${mname}` });

  // ---- système
  const adj = new Map<string, string[]>();
  for (const e of S.edges.values()) if (e.kind !== "async") (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
  const sysNodes = new Map<string, any>();
  const sysEdges = new Map<string, any>();
  const nodeFor = (r: Rec): string => {
    if (r.route && r.nextPage !== undefined) {
      const id = `grp:pages:${r.nextPage}`;
      const g = sysNodes.get(id) ?? { id, label: r.nextPage ? `Pages (${r.nextPage})` : "Pages", kind: "routes", unit: "page", sub: "", members: [], file: r.file, line: r.line, ids: [] };
      if (!g.ids.includes(r.id)) { g.members.push(`PAGE ${r.route.path}`); g.ids.push(r.id); }
      g.sub = "";
      sysNodes.set(id, g);
      return id;
    }
    if (r.route) {
      const id = r.nextApi !== undefined ? `grp:api:${r.nextApi}` : `grp:${r.module}`;
      const label = r.nextApi !== undefined ? (r.nextApi ? `API routes (${r.nextApi})` : "API routes") : r.module.split("/").pop()!;
      const g = sysNodes.get(id) ?? { id, label, kind: "routes", unit: "route", sub: "", members: [], file: r.file, line: r.line, ids: [] };
      if (!g.ids.includes(r.id)) { g.members.push(`${r.route.method} ${r.route.path || "/"}`); g.ids.push(r.id); }
      g.sub = "";
      sysNodes.set(id, g);
      return id;
    }
    const kind = r.worker ? "worker" : "entry";
    if (!sysNodes.has(r.id)) sysNodes.set(r.id, { id: r.id, label: r.qual, kind, sub: r.worker ? r.worker.lib : r.entry, file: r.file, line: r.line, ids: [r.id] });
    return r.id;
  };
  const addSys = (s: string, t: string, kind: string, label: string | null) => {
    const k = `${s}>${t}>${kind}`;
    const e = sysEdges.get(k) ?? { source: s, target: t, kind, labels: new Map<string, number>() };
    if (label) for (const p of label.split(", ")) e.labels.set(p, (e.labels.get(p) ?? 0) + 1);
    sysEdges.set(k, e);
  };
  const infraById = new Map(infra.map((i) => [i.id, i]));
  for (const r of recs.filter((x) => ["route", "worker", "handler"].includes(x.entry ?? ""))) {
    const visited = new Set([r.id]);
    const stack = [r.id];
    const reachInfra = new Map<string, Map<string, number>>();
    const reachHttp: { method: string; url: string }[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      const rec = S.byId.get(cur);
      if (rec) rec.http.forEach((h) => { if (!reachHttp.some((x) => x.method === h.method && x.url === h.url)) reachHttp.push({ method: h.method, url: h.url }); });
      for (const [iid, ops] of opsBy.get(cur) ?? []) {
        const m = reachInfra.get(iid) ?? new Map<string, number>();
        ops.forEach((n, o) => m.set(o, (m.get(o) ?? 0) + n));
        reachInfra.set(iid, m);
      }
      for (const t of adj.get(cur) ?? []) if (!visited.has(t) && S.byId.has(t)) { visited.add(t); stack.push(t); }
    }
    if (r.entry === "handler" && reachInfra.size === 0 && reachHttp.length === 0) continue;
    const src = nodeFor(r);
    for (const [iid, ops] of reachInfra) {
      const inf = infraById.get(`infra:${iid}`);
      if (inf) addSys(src, inf.id, inf.queue ? "async" : "uses", inf.queue ? "enqueue" : topN(ops).join(", "));
    }
    if (reachHttp.length) {
      const n = sysNodes.get(src);
      n.http = [...(n.http ?? []), ...reachHttp.filter((h) => !(n.http ?? []).some((x: any) => x.method === h.method && x.url === h.url))];
    }
    if (r.worker) {
      const q = infraById.get(`infra:${r.worker.queue}`);
      if (q) addSys(q.id, src, "consume", null);
    }
  }
  for (const i of infra) sysNodes.set(i.id, { id: i.id, label: i.label, kind: "infra", sub: i.type, declared: i.declared, service: i.service, libs: i.libs, uses: i.uses });
  const valid = new Set(sysNodes.keys());
  const system = {
    nodes: [...sysNodes.values()],
    edges: [...sysEdges.values()].filter((e) => valid.has(e.source) && valid.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind, label: topN(e.labels).join(", ") || null })),
  };
  for (const l of infraLinks) system.edges.push({ source: l.source, target: l.target, kind: "broker", label: "broker" });

  // ---- nœuds
  const hasEdge = new Set<string>();
  for (const e of S.edges.values()) { hasEdge.add(e.source); hasEdge.add(e.target); }
  for (const e of infraEdges) hasEdge.add(e.source);
  const nodes: any[] = recs.map((r) => ({
    id: r.id, kind: r.kind, label: r.qual, name: r.name, module: r.module, file: r.file, line: r.line, end: r.end, layer: layerOf(r),
    complexity: r.complexity, loc: r.loc, args: r.args, async: r.async, decorators: r.decorators, doc: r.doc, entry: r.entry,
    route: r.route, worker: r.worker, dead: r.dead, dup: r.dup, callers: r.callers, callees: r.callees2, tag: r.tag,
  }));
  for (const m of mods) {
    if (hasEdge.has(m.top.id)) nodes.push({
      id: m.top.id, kind: "module", label: m.name, name: m.name, module: m.name, file: m.file, line: 1, end: 1, layer: m.layer,
      complexity: 0, loc: 0, args: [], async: false, decorators: [], doc: "", entry: null, route: null, worker: null, dead: null, dup: null, callers: 0,
      callees: outgoing.get(m.top.id) ?? 0, tag: null,
    });
  }
  const classCount = new Map<string, number>();
  for (const c of S.classDecls) classCount.set(c.mod, (classCount.get(c.mod) ?? 0) + 1);
  const modulesOut = mods.map((m) => {
    const fs_ = recs.filter((r) => r.module === m.name);
    return { id: `mod:${m.name}`, name: m.name, file: m.file, layer: m.layer, loc: m.loc, functions: fs_.length, classes: classCount.get(m.name) ?? 0, avgComplexity: fs_.length ? Math.round((fs_.reduce((a, b) => a + b.complexity, 0) / fs_.length) * 10) / 10 : 0, isPackage: false };
  });
  S.issues.forEach((i, n) => (i.id = `t${n}`));
  const modelsOut = models.map((m) => ({
    id: m.id, name: m.name, module: m.module, file: m.file, line: m.line, kind: m.kind, store: m.store && remap.has(m.store) ? remap.get(m.store) : m.store,
    fields: m.fields.slice(0, 40), nFields: m.nFields, tablename: m.tablename, usedBy: [...m.used].slice(0, 60),
  }));
  const httpCalls = recs.flatMap((r) => r.http.map((h) => ({ fn: r.id, method: h.method, url: h.url, line: h.line })));
  return {
    version: VERSION, root: S.root, generatedAt: Math.floor(Date.now() / 1000), lang: "ts", dbSchemas: [],
    metrics: {
      files: mods.length, functions: recs.length, classes: S.classDecls.length, loc: mods.reduce((a, b) => a + b.loc, 0),
      avgComplexity: recs.length ? Math.round((recs.reduce((a, b) => a + b.complexity, 0) / recs.length) * 10) / 10 : 0,
      dead: recs.filter((r) => r.dead).length, duplicates: groups.length, cycles: cycles.length, routes: recs.filter((r) => r.route).length,
      workers: recs.filter((r) => r.worker).length, infra: infra.length, models: models.length,
      securityHigh: S.issues.filter((i) => i.category === "security" && i.level === "high").length, seconds: Math.round((Date.now() - t0) / 10) / 100,
      parsed: mods.length, cached: 0,
    },
    nodes, edges: [...edges, ...infraEdges], modules: modulesOut, moduleEdges, models: modelsOut, modelEdges: mr?.edges ?? [], infra, infraLinks,
    system, issues: S.issues, duplicates: groups, cycles, layers: LAYERS, httpCalls,
  };
}
