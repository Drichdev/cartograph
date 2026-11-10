import type { ReactNode } from "react";
import type { Baseline, Graph } from "./types";
import type { Diff } from "./diff";
import { issueMessage, useT } from "./i18n";

interface Props {
  g: Graph;
  baseline: Baseline | null;
  diff: Diff | null;
  onOpen: (file: string, line: number) => void;
  onShow: (id: string) => void;
  onSave: () => void;
  onClear: () => void;
  onGit: () => void;
}

const shortId = (id: string) => id.replace(/^(fn|mod|cls|infra):/, "");

function Section({ title, count, children, tone }: { title: string; count: number; children: ReactNode; tone?: "add" | "del" | "mod" }) {
  if (count === 0) return null;
  return (
    <details className={`df-section ${tone ?? ""}`} open={count <= 12}>
      <summary>
        <span className="df-title">{title}</span>
        <span className="badge">{count}</span>
      </summary>
      <div className="df-list">{children}</div>
    </details>
  );
}

export default function DiffView({ g, baseline, diff, onOpen, onShow, onSave, onClear, onGit }: Props) {
  const { t, lang } = useT();
  if (!baseline || !diff) {
    return (
      <div className="quality">
        <div className="card df-empty">
          <h3>{t("diff.empty.title")}</h3>
          <p>{t("diff.empty.text")}</p>
          <div className="df-actions">
            <button className="btn" onClick={onSave}>{t("diff.save")}</button>
            <button className="btn" onClick={onGit}>{t("diff.git")}</button>
          </div>
        </div>
      </div>
    );
  }
  const fmt = (d: number) => (d > 0 ? `+${d}` : `${d}`);
  const date = baseline.savedAt ? new Date(baseline.savedAt * 1000).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB") : "";
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const lbl = (id: string) => byId.get(id)?.label ?? shortId(id);
  const cap = <T,>(a: T[]) => a.slice(0, 60);
  const none = diff.total === 0;
  return (
    <div className="quality">
      <div className="df-head">
        <div>
          <h3>{t("diff.title")}</h3>
          <div className="dr-muted">{t("diff.against", { label: baseline.label || t("diff.snapshot"), date })}</div>
        </div>
        <div className="df-actions">
          <button className="btn" onClick={onSave}>{t("diff.save")}</button>
          <button className="btn" onClick={onGit}>{t("diff.git")}</button>
          <button className="btn" onClick={onClear}>{t("diff.clear")}</button>
        </div>
      </div>
      <div className="tiles">
        {diff.metrics.map((m) => {
          const d = Math.round((m.cur - m.base) * 10) / 10;
          const worseWhenUp = ["dead", "duplicates", "cycles", "securityHigh", "avgComplexity"].includes(m.key);
          const tone = d === 0 ? "" : (d > 0) === worseWhenUp ? "bad" : "good";
          return (
            <div className="tile" key={m.key}>
              <b>{m.cur}</b>
              <span>{t(`metric.${m.key}`)}</span>
              <em className={`delta ${tone}`}>{d === 0 ? "=" : fmt(d)}</em>
            </div>
          );
        })}
      </div>
      {none && <div className="empty">{t("diff.none")}</div>}

      <Section title={t("diff.fnAdded")} count={diff.fnAdded.length} tone="add">
        {cap(diff.fnAdded).map((n) => (
          <div className="q-row" key={n.id}>
            <button className="q-main" onClick={() => onOpen(n.file, n.line)}><span className="q-msg">{n.label}</span><span className="q-loc">{n.file}:{n.line}</span></button>
            <button className="btn btn-small" onClick={() => onShow(n.id)}>{t("quality.show")}</button>
          </div>
        ))}
      </Section>
      <Section title={t("diff.fnRemoved")} count={diff.fnRemoved.length} tone="del">
        {cap(diff.fnRemoved).map((n) => (
          <div className="q-row" key={n.id}><div className="q-main"><span className="q-msg">{n.label}</span><span className="q-loc">{n.file}</span></div></div>
        ))}
      </Section>
      <Section title={t("diff.fnMoved")} count={diff.fnMoved.length} tone="mod">
        {cap(diff.fnMoved).map((m) => (
          <div className="q-row" key={m.to.id}>
            <button className="q-main" onClick={() => onOpen(m.to.file, m.to.line)}><span className="q-msg">{m.to.label}</span><span className="q-loc">{m.from.file} → {m.to.file}</span></button>
          </div>
        ))}
      </Section>
      <Section title={t("diff.fnChanged")} count={diff.fnChanged.length} tone="mod">
        {cap(diff.fnChanged).map((c) => (
          <div className="q-row" key={c.cur.id}>
            <button className="q-main" onClick={() => onOpen(c.cur.file, c.cur.line)}>
              <span className="q-msg">{c.cur.label}</span>
              <span className="q-loc">
                {t("diff.cx")} {c.base.complexity} → {c.cur.complexity} ({fmt(c.dCx)}) · {t("diff.lines")} {fmt(c.dLoc)}{c.argsChanged ? ` · ${t("diff.args")}` : ""}
              </span>
            </button>
            <button className="btn btn-small" onClick={() => onShow(c.cur.id)}>{t("quality.show")}</button>
          </div>
        ))}
      </Section>
      <Section title={t("diff.routesAdded")} count={diff.routesAdded.length} tone="add">
        {diff.routesAdded.map((r) => <div className="q-row" key={r}><span className="q-msg mono">{r}</span></div>)}
      </Section>
      <Section title={t("diff.routesRemoved")} count={diff.routesRemoved.length} tone="del">
        {diff.routesRemoved.map((r) => <div className="q-row" key={r}><span className="q-msg mono">{r}</span></div>)}
      </Section>
      <Section title={t("diff.infraAdded")} count={diff.infraAdded.length} tone="add">
        {diff.infraAdded.map((i) => <div className="q-row" key={i.id}><span className="q-msg">{i.label}</span></div>)}
      </Section>
      <Section title={t("diff.infraRemoved")} count={diff.infraRemoved.length} tone="del">
        {diff.infraRemoved.map((i) => <div className="q-row" key={i.id}><span className="q-msg">{i.label}</span></div>)}
      </Section>
      <Section title={t("diff.depsAdded")} count={diff.depsAdded.length} tone="add">
        {cap(diff.depsAdded).map((d) => <div className="q-row" key={d.source + d.target}><span className="q-msg mono">{shortId(d.source)} → {shortId(d.target)}</span></div>)}
      </Section>
      <Section title={t("diff.depsRemoved")} count={diff.depsRemoved.length} tone="del">
        {cap(diff.depsRemoved).map((d) => <div className="q-row" key={d.source + d.target}><span className="q-msg mono">{shortId(d.source)} → {shortId(d.target)}</span></div>)}
      </Section>
      <Section title={t("diff.callsAdded")} count={diff.callsAdded.length} tone="add">
        {cap(diff.callsAdded).map((e) => <div className="q-row" key={e.source + e.target}><span className="q-msg mono">{lbl(e.source)} → {lbl(e.target)}</span></div>)}
      </Section>
      <Section title={t("diff.callsRemoved")} count={diff.callsRemoved.length} tone="del">
        {cap(diff.callsRemoved).map((e) => <div className="q-row" key={e.source + e.target}><span className="q-msg mono">{shortId(e.source)} → {shortId(e.target)}</span></div>)}
      </Section>
      <Section title={t("diff.modelsAdded")} count={diff.modelsAdded.length} tone="add">
        {diff.modelsAdded.map((m) => <div className="q-row" key={m.id}><span className="q-msg">{m.name}</span></div>)}
      </Section>
      <Section title={t("diff.modelsRemoved")} count={diff.modelsRemoved.length} tone="del">
        {diff.modelsRemoved.map((m) => <div className="q-row" key={m.id}><span className="q-msg">{m.name}</span></div>)}
      </Section>
      <Section title={t("diff.modelsChanged")} count={diff.modelsChanged.length} tone="mod">
        {diff.modelsChanged.map((m) => (
          <div className="q-row" key={m.cur.id}>
            <button className="q-main" onClick={() => onOpen(m.cur.file, m.cur.line)}>
              <span className="q-msg">{m.name}</span>
              <span className="q-loc">{m.added.map((f) => "+" + f).join(" ")} {m.removed.map((f) => "−" + f).join(" ")}</span>
            </button>
          </div>
        ))}
      </Section>
      <Section title={t("diff.issuesNew")} count={diff.issuesNew.length} tone="del">
        {cap(diff.issuesNew).map((i) => (
          <div className="q-row" key={i.id}>
            <span className={`dot dot-${i.severity}`} />
            <button className="q-main" onClick={() => onOpen(i.file, i.line)}><span className="q-msg">{issueMessage(t, i)}</span><span className="q-loc">{i.file}:{i.line}</span></button>
          </div>
        ))}
      </Section>
      <Section title={t("diff.issuesResolved")} count={diff.issuesResolved.length} tone="add">
        {cap(diff.issuesResolved).map((i) => (
          <div className="q-row" key={i.id}><span className={`dot dot-${i.severity}`} /><div className="q-main"><span className="q-msg">{issueMessage(t, i)}</span><span className="q-loc">{i.file}</span></div></div>
        ))}
      </Section>
    </div>
  );
}
