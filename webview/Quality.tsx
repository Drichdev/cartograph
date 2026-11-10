import { useMemo, useState } from "react";
import type { Graph, Issue } from "./types";
import { issueMessage, useT } from "./i18n";

type Tab = "security" | "error" | "dead" | "duplicate" | "complexity" | "architecture" | "quality";
const TABS: Tab[] = ["security", "error", "dead", "duplicate", "complexity", "architecture", "quality"];
const SEV = { error: 0, warning: 1, info: 2 } as const;

interface Props {
  g: Graph;
  issues: Issue[];
  search: string;
  onOpen: (file: string, line: number) => void;
  onShow: (id: string) => void;
}

export default function Quality({ g, issues, search, onOpen, onShow }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>("security");
  const [lowDead, setLowDead] = useState(false);
  const q = search.trim().toLowerCase();
  const byTab = useMemo(() => {
    const m = new Map<Tab, Issue[]>();
    for (const x of TABS) m.set(x, []);
    for (const i of issues) m.get(i.category as Tab)?.push(i);
    for (const list of m.values()) list.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    return m;
  }, [issues]);

  const fnById = useMemo(() => new Map(g.nodes.map((n) => [n.id, n])), [g]);
  const m = g.metrics;
  const tiles: [string, string | number][] = [
    ["files", m.files], ["functions", m.functions], ["loc", m.loc], ["avgComplexity", m.avgComplexity],
    ["routes", m.routes], ["workers", m.workers], ["infra", m.infra], ["models", m.models],
  ];

  let list = byTab.get(tab) ?? [];
  if (tab === "dead" && !lowDead) list = list.filter((i) => i.confidence !== "low");
  if (q) list = list.filter((i) => (issueMessage(t, i) + i.file + i.rule).toLowerCase().includes(q));

  return (
    <div className="quality">
      <div className="tiles">
        {tiles.map(([k, v]) => (
          <div className="tile" key={k}>
            <b>{v}</b>
            <span>{t(`metric.${k}`)}</span>
          </div>
        ))}
      </div>
      <div className="q-tabs" role="tablist">
        {TABS.map((id) => {
          const all = byTab.get(id) ?? [];
          const n = id === "dead" ? all.filter((i) => i.confidence !== "low").length : all.length;
          return (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {t(`qtab.${id}`)}
              <span className={`badge ${n > 0 && (id === "security" || id === "error") ? "badge-danger" : ""}`}>{n}</span>
            </button>
          );
        })}
      </div>
      {tab === "dead" && (
        <label className="check q-opt">
          <input type="checkbox" checked={lowDead} onChange={(e) => setLowDead(e.target.checked)} />
          {t("quality.includeLow")}
        </label>
      )}
      <div className="q-list">
        {tab === "duplicate" ? (
          g.duplicates.length === 0 ? (
            <div className="empty">{t("quality.noDup")}</div>
          ) : (
            g.duplicates.map((d, gi) => (
              <div className="q-group" key={gi}>
                <div className="q-group-head">
                  <b>{d.kind === "exact" ? t("quality.dupExact") : t("quality.dupSimilar", { pct: Math.round(d.similarity * 100) })}</b>
                  <span className="dr-muted">{t("quality.nFunctions", { n: d.members.length })}</span>
                </div>
                {d.members.map((id) => {
                  const f = fnById.get(id);
                  if (!f) return null;
                  return (
                    <div className="q-row" key={id}>
                      <button className="q-main" onClick={() => onOpen(f.file, f.line)}>
                        <span className="q-msg">{f.label}</span>
                        <span className="q-loc">{f.file}:{f.line}</span>
                      </button>
                      <button className="btn btn-small" onClick={() => onShow(id)}>{t("quality.show")}</button>
                    </div>
                  );
                })}
              </div>
            ))
          )
        ) : list.length === 0 ? (
          <div className="empty">{tab === "security" ? t("quality.noSecurity") : t("quality.nothing")}</div>
        ) : (
          list.slice(0, 400).map((i) => (
            <div className="q-row" key={i.id}>
              <span className={`dot dot-${i.severity}`} title={i.severity} />
              <button className="q-main" onClick={() => onOpen(i.file, i.line)}>
                <span className="q-msg">{issueMessage(t, i)}</span>
                <span className="q-loc">
                  {i.file}:{i.line}
                  {i.rule ? `  ${i.rule}` : ""}
                  {i.source !== "cartograph" ? `  (${i.source})` : ""}
                </span>
              </button>
              {i.node && fnById.has(i.node) && <button className="btn btn-small" onClick={() => onShow(i.node!)}>{t("quality.show")}</button>}
            </div>
          ))
        )}
        {list.length > 400 && tab !== "duplicate" && <div className="dr-muted q-more">{t("quality.more", { n: list.length - 400 })}</div>}
      </div>
    </div>
  );
}
