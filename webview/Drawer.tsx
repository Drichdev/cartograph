import type { ReactNode } from "react";
import type { Graph, Issue } from "./types";
import { issueMessage, useT } from "./i18n";
import { modelForTable, tableId } from "./views";

interface Props {
  g: Graph;
  id: string;
  issues: Issue[];
  onSelect: (id: string) => void;
  onOpen: (file: string, line: number, end?: number) => void;
  onShowCalls: (id: string) => void;
  onClose: () => void;
}

function Row({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button className="dr-row" onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function Section({ title, children, count }: { title: string; children: ReactNode; count?: number }) {
  return (
    <section className="dr-section">
      <h4>
        {title}
        {count !== undefined && <span className="dr-count">{count}</span>}
      </h4>
      {children}
    </section>
  );
}

function Header({ title, sub, onClose, link }: { title: string; sub?: ReactNode; onClose: () => void; link?: ReactNode }) {
  const { t } = useT();
  return (
    <header>
      <div>
        <h3>{title}</h3>
        {link}
        {sub && <div className="dr-muted">{sub}</div>}
      </div>
      <button className="icon-btn" onClick={onClose} aria-label={t("drawer.close")}>×</button>
    </header>
  );
}

export default function Drawer({ g, id, issues, onSelect, onOpen, onShowCalls, onClose }: Props) {
  const { t } = useT();
  const fnById = new Map(g.nodes.map((n) => [n.id, n]));
  const label = (nid: string) =>
    fnById.get(nid)?.label ?? g.infra.find((i) => i.id === nid)?.label ?? g.system.nodes.find((n) => n.id === nid)?.label ?? nid.replace(/^(fn|mod|cls|infra):/, "");
  const myIssues = issues.filter((i) => i.node === id);
  const edgeMeta = (e: { kind: string; certain: boolean; label: string | null }) =>
    e.kind === "async" ? t("drawer.async") : e.label === "DI" ? t("edge.DI") : e.label === "HTTP" ? "HTTP" : e.kind === "ref" ? t("drawer.ref") : e.certain ? "" : t("drawer.uncertain");

  const issueList = myIssues.length > 0 && (
    <Section title={t("drawer.issues")} count={myIssues.length}>
      {myIssues.slice(0, 12).map((i) => (
        <Row key={i.id} onClick={() => onOpen(i.file, i.line)} title={`${i.file}:${i.line}`}>
          <span className={`dot dot-${i.severity}`} />
          <span className="dr-text">{issueMessage(t, i)}</span>
          <span className="dr-meta">l.{i.line}</span>
        </Row>
      ))}
    </Section>
  );

  // ---- fonction / code de module
  const fn = fnById.get(id);
  if (fn) {
    const callers = g.edges.filter((e) => e.target === id && e.kind !== "uses");
    const callees = g.edges.filter((e) => e.source === id && e.kind !== "uses");
    const infraEdges = g.edges.filter((e) => e.source === id && e.kind === "uses");
    const peers = fn.dup !== null && fn.dup !== undefined ? g.duplicates[fn.dup]?.members.filter((m) => m !== id) ?? [] : [];
    return (
      <aside className="drawer">
        <Header title={fn.label} onClose={onClose} link={<button className="link" onClick={() => onOpen(fn.file, fn.line, fn.end)}>{fn.file}:{fn.line}</button>} />
        {fn.doc && <p className="dr-doc">{fn.doc}</p>}
        <div className="dr-facts">
          <span>{t("layer." + fn.layer)}</span>
          <span>{t("drawer.complexity", { n: fn.complexity })}</span>
          <span>{t("node.nLines", { n: fn.loc })}</span>
          {fn.async && <span>async</span>}
          {fn.args.length > 0 && <span>{t("drawer.nArgs", { n: fn.args.length })}</span>}
        </div>
        {fn.route && (
          <Section title={t("drawer.route")}>
            <div className="dr-route"><b>{fn.route.method}</b> {fn.route.path || "/"}</div>
            <div className="dr-muted">{fn.route.auth === true ? t("drawer.authYes") : fn.route.auth === false ? t("drawer.authNo") : t("drawer.authUnknown")}</div>
          </Section>
        )}
        {fn.worker && (
          <Section title={t("drawer.worker")}>
            <div className="dr-muted">{t("drawer.workerText", { lib: fn.worker.lib })}</div>
          </Section>
        )}
        {fn.dead && <div className="dr-note">{fn.dead.confidence === "low" ? t("drawer.deadLow") : t("drawer.dead")}</div>}
        {issueList}
        {infraEdges.length > 0 && (
          <Section title={t("drawer.infra")} count={infraEdges.length}>
            {infraEdges.map((e) => (
              <Row key={e.target} onClick={() => onSelect(e.target)}>
                <span className="dr-text">{label(e.target)}</span>
                <span className="dr-meta">{e.label}</span>
              </Row>
            ))}
          </Section>
        )}
        <Section title={t("drawer.callers")} count={callers.length}>
          {callers.length === 0 && <div className="dr-muted">{t("drawer.nobody")}</div>}
          {callers.slice(0, 25).map((e) => (
            <Row key={e.source + e.kind} onClick={() => onSelect(e.source)}>
              <span className="dr-text">{label(e.source)}</span>
              <span className="dr-meta">{edgeMeta(e)}</span>
            </Row>
          ))}
        </Section>
        <Section title={t("drawer.callees")} count={callees.length}>
          {callees.length === 0 && <div className="dr-muted">{t("drawer.nothing")}</div>}
          {callees.slice(0, 25).map((e) => (
            <Row key={e.target + e.kind} onClick={() => onSelect(e.target)}>
              <span className="dr-text">{label(e.target)}</span>
              <span className="dr-meta">{edgeMeta(e)}</span>
            </Row>
          ))}
        </Section>
        {peers.length > 0 && (
          <Section title={t("drawer.duplicates")} count={peers.length}>
            {peers.map((p) => (
              <Row key={p} onClick={() => onSelect(p)}>
                <span className="dr-text">{label(p)}</span>
                <span className="dr-meta">{fnById.get(p)?.file}</span>
              </Row>
            ))}
          </Section>
        )}
        <button className="btn btn-block" onClick={() => onShowCalls(id)}>{t("drawer.showInCalls")}</button>
      </aside>
    );
  }

  // ---- module
  const mod = g.modules.find((m) => m.id === id);
  if (mod) {
    const fns = g.nodes.filter((n) => n.module === mod.name && n.kind !== "module");
    const imports = g.moduleEdges.filter((e) => e.source === id);
    const importedBy = g.moduleEdges.filter((e) => e.target === id);
    return (
      <aside className="drawer">
        <Header title={mod.name} onClose={onClose} link={<button className="link" onClick={() => onOpen(mod.file, 1)}>{mod.file}</button>} />
        <div className="dr-facts">
          <span>{t("layer." + mod.layer)}</span>
          <span>{t("node.nLines", { n: mod.loc })}</span>
          <span>{t("node.nFunctions", { n: mod.functions })}</span>
          <span>{t("drawer.nClasses", { n: mod.classes })}</span>
        </div>
        {issueList}
        <Section title={t("drawer.imports")} count={imports.length}>
          {imports.map((e) => (
            <Row key={e.target} onClick={() => onSelect(e.target)}>
              <span className="dr-text">{label(e.target)}</span>
              <span className="dr-meta">{e.violation ? t("drawer.upward") : e.calls ? t("drawer.nCalls", { n: e.calls }) : ""}</span>
            </Row>
          ))}
        </Section>
        <Section title={t("drawer.importedBy")} count={importedBy.length}>
          {importedBy.map((e) => (
            <Row key={e.source} onClick={() => onSelect(e.source)}>
              <span className="dr-text">{label(e.source)}</span>
            </Row>
          ))}
        </Section>
        <Section title={t("drawer.functions")} count={fns.length}>
          {fns.slice(0, 40).map((f) => (
            <Row key={f.id} onClick={() => onSelect(f.id)}>
              <span className="dr-text">{f.label}</span>
              <span className="dr-meta">cx {f.complexity}</span>
            </Row>
          ))}
        </Section>
      </aside>
    );
  }

  // ---- table / collection réelle
  if (id.startsWith("tbl:")) {
    const db = (g.dbSchemas ?? []).find((d) => id.startsWith(`tbl:${d.id}:`));
    const table = db?.tables.find((x) => tableId(db.id, x.name) === id);
    if (db && table) {
      const m = modelForTable(g, table.name);
      const incoming = db.tables.filter((x) => x.columns.some((c) => c.fk && c.fk.split(".")[0] === table.name));
      const mongo = db.type === "mongodb";
      return (
        <aside className="drawer">
          <Header title={table.name} onClose={onClose} sub={`${db.type} · ${db.name}`} />
          <div className="dr-facts">
            {table.rows !== null && <span>{table.rows.toLocaleString()} {t(mongo ? "node.documents" : "node.rows")}</span>}
            {table.sampled !== undefined && <span>{t("drawer.sampled", { n: table.sampled })}</span>}
            <span>{table.columns.length} {t(mongo ? "drawer.fields" : "drawer.columns")}</span>
          </div>
          {m ? (
            <Section title={t("drawer.codeModel")}>
              <Row onClick={() => onSelect(m.id)}><span className="dr-text">{m.name}</span><span className="dr-meta">{m.file}</span></Row>
            </Section>
          ) : (
            <div className="dr-note">{t("drawer.noModel")}</div>
          )}
          <Section title={t(mongo ? "drawer.fields" : "drawer.columns")} count={table.columns.length}>
            {table.columns.map((c) => (
              <div key={c.name} className="dr-field">
                <b>{c.pk ? "◆ " : ""}{c.name}</b>
                <span>{c.fk ? `→ ${c.fk}` : c.type}{c.nullable ? "" : ` · ${t("drawer.required")}`}</span>
              </div>
            ))}
          </Section>
          {incoming.length > 0 && (
            <Section title={t("drawer.referencedBy")} count={incoming.length}>
              {incoming.map((x) => (
                <Row key={x.name} onClick={() => onSelect(tableId(db.id, x.name))}><span className="dr-text">{x.name}</span></Row>
              ))}
            </Section>
          )}
          {table.indexes.length > 0 && (
            <Section title={t("drawer.indexes")} count={table.indexes.length}>
              {table.indexes.map((x) => (
                <div key={x.name} className="dr-field"><b>{x.name}</b><span>{x.unique ? t("drawer.unique") : ""}</span></div>
              ))}
            </Section>
          )}
        </aside>
      );
    }
  }

  // ---- modèle
  const model = g.models.find((m) => m.id === id);
  if (model) {
    const rel = g.modelEdges.filter((e) => e.source === id || e.target === id);
    return (
      <aside className="drawer">
        <Header title={model.name} onClose={onClose} link={<button className="link" onClick={() => onOpen(model.file, model.line)}>{model.file}:{model.line}</button>} />
        <div className="dr-facts">
          <span>{t("model.kind." + model.kind)}</span>
          {model.store && <span>{t("drawer.storedIn", { name: label(`infra:${model.store}`) })}</span>}
          {model.tablename && <span>{t("drawer.table", { name: model.tablename })}</span>}
        </div>
        <Section title={t("drawer.fields")} count={model.nFields}>
          {model.fields.map((f) => (
            <div key={f.name} className="dr-field">
              <b>{f.name}</b>
              <span>{f.type}</span>
            </div>
          ))}
        </Section>
        {rel.length > 0 && (
          <Section title={t("drawer.relations")} count={rel.length}>
            {rel.map((e, i) => {
              const other = e.source === id ? e.target : e.source;
              return (
                <Row key={i} onClick={() => onSelect(other)}>
                  <span className="dr-text">{e.source === id ? "→" : "←"} {g.models.find((m) => m.id === other)?.name}</span>
                  <span className="dr-meta">{e.label}</span>
                </Row>
              );
            })}
          </Section>
        )}
        <Section title={t("drawer.usedBy")} count={model.usedBy.length}>
          {model.usedBy.slice(0, 25).map((u) => (
            <Row key={u} onClick={() => onSelect(u)}>
              <span className="dr-text">{label(u)}</span>
            </Row>
          ))}
        </Section>
      </aside>
    );
  }

  // ---- infrastructure
  const infra = g.infra.find((i) => i.id === id);
  if (infra) {
    const users = g.edges.filter((e) => e.target === id && e.kind === "uses");
    const sysIn = g.system.edges.filter((e) => e.target === id);
    const stored = g.models.filter((m) => m.store && `infra:${m.store}` === id);
    return (
      <aside className="drawer">
        <Header title={infra.label} onClose={onClose} sub={t("infra.type." + infra.type)} />
        <div className="dr-facts">
          {infra.libs.map((l) => (
            <span key={l}>{l}</span>
          ))}
          {infra.declared && <span>docker-compose : {infra.service}</span>}
        </div>
        {infra.uses === 0 && <div className="dr-note">{t("drawer.infraIdle")}</div>}
        <Section title={t("drawer.infraUsers")} count={users.length}>
          {users.slice(0, 40).map((e) => (
            <Row key={e.source} onClick={() => onSelect(e.source)}>
              <span className="dr-text">{label(e.source)}</span>
              <span className="dr-meta">{e.label}</span>
            </Row>
          ))}
        </Section>
        {sysIn.length > 0 && (
          <Section title={t("drawer.flowsIn")} count={sysIn.length}>
            {sysIn.map((e, i) => (
              <Row key={i} onClick={() => onSelect(e.source)}>
                <span className="dr-text">{label(e.source)}</span>
                <span className="dr-meta">{e.label ?? e.kind}</span>
              </Row>
            ))}
          </Section>
        )}
        {stored.length > 0 && (
          <Section title={t("drawer.storedModels")} count={stored.length}>
            {stored.map((m) => (
              <Row key={m.id} onClick={() => onSelect(m.id)}>
                <span className="dr-text">{m.name}</span>
              </Row>
            ))}
          </Section>
        )}
      </aside>
    );
  }

  // ---- nœud du système (routes, workers, processus)
  const sn = g.system.nodes.find((n) => n.id === id);
  if (sn) {
    const flows = g.system.edges.filter((e) => e.source === id || e.target === id);
    return (
      <aside className="drawer">
        <Header title={sn.label} onClose={onClose} sub={sn.kind === "routes" ? t(sn.unit === "page" ? "node.nPages" : "node.nRoutes", { n: sn.members?.length ?? 0 }) : sn.kind === "process" ? sn.sub : t("entry." + sn.sub)} />
        {sn.file && <button className="link" onClick={() => onOpen(sn.file!, sn.line ?? 1)}>{sn.file}</button>}
        {sn.kind === "routes" && (
          <Section title={t(sn.unit === "page" ? "drawer.pages" : "drawer.routes")} count={sn.ids?.length}>
            {(sn.ids ?? []).map((rid) => {
              const f = fnById.get(rid);
              return (
                <Row key={rid} onClick={() => onSelect(rid)}>
                  <span className="dr-text">{f?.route?.method} {f?.route?.path || "/"}</span>
                  <span className="dr-meta">{f?.route?.auth === false ? t("node.noAuth") : f?.route?.auth ? t("node.auth") : ""}</span>
                </Row>
              );
            })}
          </Section>
        )}
        {sn.ids && sn.kind !== "routes" && sn.ids[0] && (
          <button className="btn btn-block" onClick={() => onSelect(sn.ids![0])}>{t("drawer.fnDetails")}</button>
        )}
        <Section title={t("drawer.flows")} count={flows.length}>
          {flows.map((e, i) => {
            const other = e.source === id ? e.target : e.source;
            return (
              <Row key={i} onClick={() => onSelect(other)}>
                <span className="dr-text">{e.source === id ? "→" : "←"} {label(other)}</span>
                <span className="dr-meta">{e.label ?? e.kind}</span>
              </Row>
            );
          })}
        </Section>
      </aside>
    );
  }
  return null;
}
