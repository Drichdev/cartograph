import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { Baseline, CallFilters, Graph, ViewId } from "./types";
import { nodeTypes } from "./nodes";
import { buildArchitecture, buildCalls, buildData, buildSystem, countIssues, type ViewResult } from "./views";
import { EDGE_COLORS, LAYER_COLORS, layerColor } from "./theme";
import { LangContext, makeT, type Lang } from "./i18n";
import { diffGraphs } from "./diff";
import Drawer from "./Drawer";
import Quality from "./Quality";
import DiffView from "./DiffView";
import { snapshot, toMermaid } from "./export";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

const VIEW_IDS: ViewId[] = ["system", "architecture", "calls", "data", "changes", "quality"];
const DEFAULT_FILTERS: CallFilters = { focus: "all", tests: false, refs: true, uncertain: true, infra: true, modules: false };

function FitController({ fitKey, focusId, focusTick }: { fitKey: string; focusId: string | null; focusTick: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.14, duration: 250, maxZoom: 1.1 }), 60);
    return () => clearTimeout(t);
  }, [fitKey, fitView]);
  useEffect(() => {
    if (!focusTick || !focusId) return;
    const t = setTimeout(() => fitView({ nodes: [{ id: focusId }], padding: 1.2, duration: 300, maxZoom: 1.1 }), 120);
    return () => clearTimeout(t);
  }, [focusTick, focusId, fitView]);
  return null;
}

export default function App() {
  const saved = vscode.getState() ?? {};
  const [lang, setLang] = useState<Lang>(saved.lang ?? (navigator.language.startsWith("fr") ? "fr" : "en"));
  const t = useMemo(() => makeT(lang), [lang]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>(saved.view ?? "system");
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<CallFilters>(DEFAULT_FILTERS);
  const [archTests, setArchTests] = useState(false);
  const [showSchema, setShowSchema] = useState(true);
  const [focusTick, setFocusTick] = useState(0);
  const [menu, setMenu] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === "graph") {
        setGraph(m.data);
        setWarnings(m.warnings ?? []);
        setLoading(false);
        setError(null);
      } else if (m.type === "loading") {
        setLoading(true);
      } else if (m.type === "error") {
        setError(m.message);
        setLoading(false);
      } else if (m.type === "config") {
        if (m.language === "fr" || m.language === "en") setLang(m.language);
      } else if (m.type === "baseline") {
        setBaseline(m.data ? { graph: m.data, label: m.label ?? "", savedAt: m.savedAt ?? 0 } : null);
      }
    };
    window.addEventListener("message", onMsg);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    vscode.setState({ view, lang });
  }, [view, lang]);

  const changeLang = (l: Lang) => {
    setLang(l);
    vscode.postMessage({ type: "setLanguage", language: l });
  };

  const counts = useMemo(() => (graph ? countIssues(graph) : new Map()), [graph]);
  const diff = useMemo(() => (graph && baseline ? diffGraphs(baseline.graph, graph) : null), [graph, baseline]);

  const result: ViewResult | null = useMemo(() => {
    if (!graph) return null;
    switch (view) {
      case "calls":
        return buildCalls(graph, filters, deferredSearch, selected, counts, t, diff?.status ?? null);
      case "architecture":
        return buildArchitecture(graph, archTests, deferredSearch, selected, counts, t);
      case "system":
        return buildSystem(graph, deferredSearch, selected, t);
      case "data":
        return buildData(graph, deferredSearch, selected, showSchema, t);
      default:
        return null;
    }
  }, [graph, view, filters, deferredSearch, selected, counts, archTests, showSchema, t, diff]);

  // Les nœuds gardent leur position (déplacement manuel) tant que la structure ne change pas.
  const [nodes, setNodes] = useState<Node[]>([]);
  const sigRef = useRef("");
  useEffect(() => {
    if (!result) return;
    const sig = view + "|" + result.nodes.map((n) => n.id).join(",");
    setNodes((prev) => {
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        return result.nodes;
      }
      const old = new Map(prev.map((n) => [n.id, n]));
      return result.nodes.map((n) => {
        const p = old.get(n.id);
        return p ? { ...p, data: n.data, selected: n.selected } : n;
      });
    });
  }, [result, view]);
  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  const open = useCallback((file: string, line: number, end?: number) => vscode.postMessage({ type: "open", file, line, end }), []);

  const locate = useCallback(
    (id: string) => {
      if (!graph) return;
      const fn = graph.nodes.find((n) => n.id === id);
      if (fn) return open(fn.file, fn.line, fn.end);
      const mod = graph.modules.find((m) => m.id === id);
      if (mod) return open(mod.file, 1);
      const model = graph.models.find((m) => m.id === id);
      if (model) return open(model.file, model.line);
      const sn = graph.system.nodes.find((n) => n.id === id);
      if (sn?.file) return open(sn.file, sn.line ?? 1);
    },
    [graph, open]
  );

  const showInCalls = useCallback((id: string) => {
    setSearch("");
    setFilters((f) => ({ ...f, focus: "all" }));
    setView("calls");
    setSelected(id);
    setFocusTick((n) => n + 1);
  }, []);

  const doExport = useCallback(
    async (kind: "png" | "svg" | "mermaid") => {
      setMenu(false);
      if (!result || nodes.length === 0) return;
      const base = `cartograph-${view}`;
      try {
        if (kind === "mermaid") {
          const text = "```mermaid\n" + toMermaid(nodes, result.edges, t(`tab.${view}`)) + "```\n";
          vscode.postMessage({ type: "save", name: `${base}.md`, data: text, encoding: "text" });
        } else {
          const url = await snapshot(kind, nodes);
          vscode.postMessage({ type: "save", name: `${base}.${kind}`, data: url, encoding: "dataUrl" });
        }
      } catch (e) {
        vscode.postMessage({ type: "notify", message: t("export.failed", { error: String(e) }) });
      }
    },
    [result, nodes, view, t]
  );

  const issueCount = graph ? graph.issues.filter((i) => i.severity !== "info").length : 0;
  const changeCount = diff ? diff.total : 0;
  const fitKey = `${view}|${result?.nodes.length ?? 0}|${filters.focus}|${deferredSearch}|${filters.tests}|${archTests}|${showSchema}`;
  const layersPresent = useMemo(() => {
    if (!graph) return [] as string[];
    const s = new Set<string>();
    for (const n of nodes) {
      const d: any = n.data;
      if (n.type === "fn") s.add(d.fn.layer);
      else if (n.type === "mod") s.add(d.mod.layer);
      else if (n.type === "infra") s.add("infra");
    }
    return graph.layers.concat("infra").filter((l) => s.has(l));
  }, [nodes, graph]);

  const empty = graph && graph.nodes.length === 0 && graph.modules.length === 0;
  const graphView = view !== "quality" && view !== "changes";

  return (
    <LangContext.Provider value={{ lang, t }}>
      <div className="app">
        <header className="topbar">
          <div className="brand">Cartograph</div>
          <nav className="tabs" role="tablist">
            {VIEW_IDS.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={view === v ? "tab active" : "tab"}
                title={t(`tab.${v}.hint`)}
                onClick={() => {
                  setView(v);
                  setSelected(null);
                }}
              >
                {t(`tab.${v}`)}
                {v === "quality" && issueCount > 0 && <span className="badge">{issueCount}</span>}
                {v === "changes" && changeCount > 0 && <span className="badge badge-info">{changeCount}</span>}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <input className="search" type="search" placeholder={t("top.search")} aria-label={t("top.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {graphView && (
            <div className="menu">
              <button className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} disabled={!graph || nodes.length === 0}>
                {t("top.export")}
              </button>
              {menu && (
                <div className="menu-list" role="menu" onMouseLeave={() => setMenu(false)}>
                  <button role="menuitem" onClick={() => doExport("png")}>{t("export.png")}</button>
                  <button role="menuitem" onClick={() => doExport("svg")}>{t("export.svg")}</button>
                  <button role="menuitem" onClick={() => doExport("mermaid")}>{t("export.mermaid")}</button>
                </div>
              )}
            </div>
          )}
          <button className="btn" onClick={() => vscode.postMessage({ type: "refresh" })} disabled={loading}>
            {loading ? t("top.analyzing") : t("top.refresh")}
          </button>
          <div className="seg" role="group" aria-label={t("top.language")}>
            {(["fr", "en"] as Lang[]).map((l) => (
              <button key={l} className={lang === l ? "active" : ""} aria-pressed={lang === l} onClick={() => changeLang(l)}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
        </header>

        {warnings.length > 0 && (
          <div className="warn-bar" role="status">
            <span>{warnings.join(" · ")}</span>
            <button className="icon-btn" onClick={() => setWarnings([])} aria-label={t("warn.hide")}>×</button>
          </div>
        )}
        <main className="main">
          <div className="canvas">
            {error && (
              <div className="overlay">
                <div className="card">
                  <h3>{t("error.title")}</h3>
                  <pre>{error}</pre>
                  <button className="btn" onClick={() => vscode.postMessage({ type: "refresh" })}>{t("error.retry")}</button>
                </div>
              </div>
            )}
            {!error && !graph && (
              <div className="overlay">
                <div className="card">
                  <div className="spinner" />
                  <p>{t("loading.analysis")}</p>
                </div>
              </div>
            )}
            {!error && empty && (
              <div className="overlay">
                <div className="card">
                  <h3>{t("empty.title")}</h3>
                  <p>{t("empty.text")}</p>
                </div>
              </div>
            )}
            {graph && view === "quality" && <Quality g={graph} issues={graph.issues} search={deferredSearch} onOpen={open} onShow={showInCalls} />}
            {graph && view === "changes" && (
              <DiffView
                g={graph}
                baseline={baseline}
                diff={diff}
                onOpen={open}
                onShow={showInCalls}
                onSave={() => vscode.postMessage({ type: "saveBaseline" })}
                onClear={() => vscode.postMessage({ type: "clearBaseline" })}
                onGit={() => vscode.postMessage({ type: "compareGit" })}
              />
            )}
            {graph && graphView && result && !empty && (
              <ReactFlowProvider>
                <ReactFlow
                  nodes={nodes}
                  edges={result.edges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onNodeClick={(_, n) => setSelected(n.id)}
                  onNodeDoubleClick={(_, n) => locate(n.id)}
                  onPaneClick={() => setSelected(null)}
                  minZoom={0.05}
                  maxZoom={1.6}
                  nodesConnectable={false}
                  elementsSelectable
                  proOptions={{ hideAttribution: true }}
                  onlyRenderVisibleElements={nodes.length > 200}
                >
                  <FitController fitKey={fitKey} focusId={selected} focusTick={focusTick} />
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
                  <Controls showInteractive={false} />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(n) => {
                      const d: any = n.data;
                      if (n.type === "table") return LAYER_COLORS.infra;
                      return n.type === "fn" ? layerColor(d.fn.layer) : n.type === "mod" ? layerColor(d.mod.layer) : n.type === "infra" ? LAYER_COLORS.infra : n.type === "model" ? LAYER_COLORS.model : layerColor(d.node?.kind === "routes" ? "route" : d.node?.kind === "worker" ? "worker" : "core");
                    }}
                  />
                  {view === "calls" && (
                    <Panel position="top-left" className="panel toolbar">
                      <label className="field">
                        <span>{t("calls.focus")}</span>
                        <select value={filters.focus} onChange={(e) => setFilters({ ...filters, focus: e.target.value as CallFilters["focus"] })}>
                          {(["all", "dead", "dup", "security", "complex", "errors"] as const).map((f) => (
                            <option key={f} value={f}>{t(`focus.${f}`)}</option>
                          ))}
                        </select>
                      </label>
                      {(["infra", "refs", "uncertain", "tests", "modules"] as const).map((k) => (
                        <label key={k} className="check">
                          <input type="checkbox" checked={filters[k]} onChange={(e) => setFilters({ ...filters, [k]: e.target.checked })} />
                          {t(`opt.${k}`)}
                        </label>
                      ))}
                      <div className="meta">
                        {t("calls.shown", { n: result.meta.shown })}
                        {result.meta.total > result.meta.shown ? " " + t("calls.of", { total: result.meta.total }) : ""}
                        {result.meta.truncated && " " + t("calls.truncated")}
                      </div>
                    </Panel>
                  )}
                  {view === "architecture" && (
                    <Panel position="top-left" className="panel toolbar">
                      <label className="check">
                        <input type="checkbox" checked={archTests} onChange={(e) => setArchTests(e.target.checked)} />
                        {t("opt.tests")}
                      </label>
                      <div className="meta">{t("arch.hint")}</div>
                    </Panel>
                  )}
                  {view === "data" && (
                    <Panel position="top-left" className="panel toolbar">
                      {(graph.dbSchemas ?? []).some((d) => d.tables.length > 0) ? (
                        <label className="check">
                          <input type="checkbox" checked={showSchema} onChange={(e) => setShowSchema(e.target.checked)} />
                          {t("data.schema")}
                        </label>
                      ) : (
                        <div className="meta">{t("data.noSchema")}</div>
                      )}
                      {(graph.dbSchemas ?? []).filter((d) => d.error).map((d) => (
                        <div key={d.id} className="meta meta-warn">{d.name} : {d.error}</div>
                      ))}
                      {graph.models.length === 0 && <div className="meta">{t("data.noModels")}</div>}
                    </Panel>
                  )}
                  <Panel position="top-right" className="panel legend">
                    {view !== "system" && view !== "data" &&
                      layersPresent.map((l) => (
                        <span key={l} className="lg">
                          <i style={{ background: LAYER_COLORS[l] }} />
                          {t(`layer.${l}`)}
                        </span>
                      ))}
                    <span className="lg"><i className="ln" style={{ borderColor: EDGE_COLORS.call }} />{t("legend.call")}</span>
                    <span className="lg"><i className="ln dashed" style={{ borderColor: EDGE_COLORS.async }} />{t("legend.async")}</span>
                    <span className="lg"><i className="ln" style={{ borderColor: EDGE_COLORS.uses }} />{t("legend.infra")}</span>
                    {graph.edges.some((e) => e.label === "HTTP") || graph.system.edges.some((e) => e.kind === "http") ? (
                      <span className="lg"><i className="ln" style={{ borderColor: EDGE_COLORS.http }} />{t("legend.http")}</span>
                    ) : null}
                  </Panel>
                </ReactFlow>
              </ReactFlowProvider>
            )}
            {loading && graph && <div className="busy">{t("busy.refreshing")}</div>}
          </div>
          {graph && selected && graphView && (
            <Drawer g={graph} id={selected} issues={graph.issues} onSelect={setSelected} onOpen={open} onShowCalls={showInCalls} onClose={() => setSelected(null)} />
          )}
        </main>
      </div>
    </LangContext.Provider>
  );
}
