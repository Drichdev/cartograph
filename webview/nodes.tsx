import type { CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { DbTable, FnNode, IssueCount, Model, ModuleInfo, SysNode } from "./types";
import { LAYER_COLORS, layerColor, shortModule } from "./theme";
import { useT } from "./i18n";

export type FnData = { fn: FnNode; counts: IssueCount; dim: boolean; match: boolean; diff?: "added" | "changed" };
export type ModData = { mod: ModuleInfo; counts: IssueCount; inCycle: boolean; dim: boolean };
export type InfraData = {
  label: string;
  sub: string;
  declared?: boolean;
  service?: string | null;
  libs?: string[];
  uses?: number;
  dim: boolean;
};
export type ModelData = { model: Model; dim: boolean };
export type SysData = { node: SysNode; dim: boolean };
export type TableData = { table: DbTable; db: string; dbType: string; model: string | null; dim: boolean };

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const color = (c: string) => ({ "--c": c } as CSSProperties);

function Pill({ tone, children, title }: { tone: "warn" | "danger" | "muted" | "info" | "ok"; children: React.ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function FnNodeView({ data, selected }: NodeProps<Node<FnData, "fn">>) {
  const { t } = useT();
  const { fn, counts, dim, match, diff } = data;
  const isModule = fn.kind === "module";
  const sub = fn.route
    ? `${fn.route.method} ${fn.route.path || "/"}`
    : fn.worker
    ? t("node.task", { lib: fn.worker.lib })
    : isModule
    ? t("node.moduleCode")
    : `${shortModule(fn.module)}:${fn.line}`;
  const c = fn.complexity;
  return (
    <div className={cx("nd nd-fn", selected && "is-selected", dim && "is-dim", fn.dead && "is-dead", match && "is-match", isModule && "is-module")} style={color(layerColor(fn.layer))}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-title" title={fn.label}>
        {fn.label}
      </div>
      <div className="nd-sub">{sub}</div>
      <div className="nd-badges">
        {diff && <Pill tone={diff === "added" ? "ok" : "warn"}>{t(diff === "added" ? "node.new" : "node.changed")}</Pill>}
        {fn.tag && <Pill tone="info">{t("tag." + fn.tag)}</Pill>}
        {c >= 8 && <Pill tone={c > 20 ? "danger" : c > 10 ? "warn" : "muted"} title={t("node.cxTitle")}>cx {c}</Pill>}
        {fn.dead && <Pill tone="muted" title={fn.dead.confidence === "low" ? t("node.deadLowTitle") : t("node.deadTitle")}>{fn.dead.confidence === "low" ? t("node.deadMaybe") : t("node.dead")}</Pill>}
        {fn.dup !== null && fn.dup !== undefined && <Pill tone="info" title={t("node.dupTitle")}>{t("node.dup")}</Pill>}
        {counts.security > 0 && <Pill tone="danger" title={t("node.securityTitle")}>{t("node.security")} {counts.security}</Pill>}
        {counts.error > 0 && counts.security === 0 && <Pill tone="danger">{t("node.error")} {counts.error}</Pill>}
        {fn.route && fn.route.auth === false && <Pill tone="warn" title={t("node.noAuthTitle")}>{t("node.noAuth")}</Pill>}
        {fn.route && fn.route.auth === true && <Pill tone="ok">{t("node.auth")}</Pill>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function ModNodeView({ data, selected }: NodeProps<Node<ModData, "mod">>) {
  const { t } = useT();
  const { mod, counts, inCycle, dim } = data;
  return (
    <div className={cx("nd nd-mod", selected && "is-selected", dim && "is-dim")} style={color(layerColor(mod.layer))}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-title" title={mod.file}>
        {shortModule(mod.name)}
      </div>
      <div className="nd-sub">
        <span>{t("node.nFunctions", { n: mod.functions })}</span>
        <span>{t("node.nLines", { n: mod.loc })}</span>
      </div>
      <div className="nd-badges">
        <Pill tone="muted">{t("layer." + mod.layer)}</Pill>
        {inCycle && <Pill tone="warn" title={t("node.cycleTitle")}>{t("node.cycle")}</Pill>}
        {mod.avgComplexity >= 6 && <Pill tone="warn" title={t("node.avgCxTitle")}>{t("node.avgCx")} {mod.avgComplexity}</Pill>}
        {counts.security > 0 && <Pill tone="danger">{t("node.security")} {counts.security}</Pill>}
        {counts.error > 0 && <Pill tone="danger">{t("node.error")} {counts.error}</Pill>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function InfraNodeView({ data, selected }: NodeProps<Node<InfraData, "infra">>) {
  const { t } = useT();
  return (
    <div className={cx("nd nd-infra", selected && "is-selected", data.dim && "is-dim", data.uses === 0 && "is-idle")} style={color(LAYER_COLORS.infra)}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-title">{data.label}</div>
      <div className="nd-sub">{t("infra.type." + data.sub)}</div>
      <div className="nd-badges">
        {data.declared && <Pill tone="info" title={t("node.dockerTitle", { name: data.service ?? "" })}>docker</Pill>}
        {data.uses === 0 && <Pill tone="muted" title={t("node.noCallTitle")}>{t("node.noCall")}</Pill>}
        {(data.libs ?? []).slice(0, 2).map((l) => (
          <Pill key={l} tone="muted">{l}</Pill>
        ))}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function ModelNodeView({ data, selected }: NodeProps<Node<ModelData, "model">>) {
  const { t } = useT();
  const m = data.model;
  const shown = m.fields.slice(0, 8);
  return (
    <div className={cx("nd nd-model", selected && "is-selected", data.dim && "is-dim")} style={color(LAYER_COLORS.model)}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-model-head">
        <span className="nd-title" title={m.file}>{m.name}</span>
        <Pill tone="muted">{t("model.kind." + m.kind)}</Pill>
      </div>
      <div className="nd-fields">
        {shown.map((f) => (
          <div key={f.name} className="nd-field">
            <span className="nd-field-name">{f.name}</span>
            <span className="nd-field-type">{f.type}</span>
          </div>
        ))}
        {m.nFields > shown.length && <div className="nd-field nd-field-more">{t("node.moreFields", { n: m.nFields - shown.length })}</div>}
        {m.nFields === 0 && <div className="nd-field nd-field-more">{t("node.noFields")}</div>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function SysNodeView({ data, selected }: NodeProps<Node<SysData, "sys">>) {
  const { t } = useT();
  const n = data.node;
  const tone = n.kind === "routes" ? LAYER_COLORS.route : n.kind === "worker" ? LAYER_COLORS.worker : n.kind === "entry" ? LAYER_COLORS.core : LAYER_COLORS.other;
  const members = n.members ?? [];
  return (
    <div className={cx("nd nd-sys", `nd-sys-${n.kind}`, selected && "is-selected", data.dim && "is-dim")} style={color(tone)}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-title" title={n.label}>{n.label}</div>
      <div className="nd-sub">{n.kind === "process" ? <span className="nd-cmd">{n.sub}</span> : n.kind === "routes" ? t(n.unit === "page" ? "node.nPages" : "node.nRoutes", { n: members.length }) : t("entry." + n.sub)}</div>
      {n.kind === "routes" && (
        <div className="nd-members">
          {members.slice(0, 3).map((m, i) => (
            <div key={i}>{m}</div>
          ))}
          {members.length > 3 && <div className="nd-field-more">{t("node.moreItems", { n: members.length - 3 })}</div>}
        </div>
      )}
      {n.kind === "process" && <div className="nd-badges"><Pill tone="muted">{t("role." + n.role)}</Pill></div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function TableNodeView({ data, selected }: NodeProps<Node<TableData, "table">>) {
  const { t: tr } = useT();
  const t = data.table;
  const shown = t.columns.slice(0, 8);
  return (
    <div className={cx("nd nd-model nd-table", selected && "is-selected", data.dim && "is-dim")} style={color(LAYER_COLORS.infra)}>
      <Handle type="target" position={Position.Left} />
      <div className="nd-model-head">
        <span className="nd-title">{t.name}</span>
        <Pill tone="muted">{data.dbType}</Pill>
      </div>
      <div className="nd-sub nd-table-sub">
        <span>{data.db}</span>
        {t.rows !== null && <span>{t.rows.toLocaleString()} {tr(data.dbType === "mongodb" ? "node.documents" : "node.rows")}</span>}
      </div>
      <div className="nd-fields">
        {shown.map((c) => (
          <div key={c.name} className="nd-field">
            <span className="nd-field-name">
              {c.pk && <span className="key" title={tr("node.pk")}>◆ </span>}
              {c.name}
            </span>
            <span className="nd-field-type">{c.fk ? `→ ${c.fk.split(".")[0]}` : c.type}</span>
          </div>
        ))}
        {t.columns.length > shown.length && <div className="nd-field nd-field-more">{tr("node.moreColumns", { n: t.columns.length - shown.length })}</div>}
      </div>
      <div className="nd-badges nd-badges-pad">
        {data.model ? <Pill tone="ok" title={tr("node.modelTitle")}>{tr("node.model")} {data.model}</Pill> : <Pill tone="warn" title={tr("node.noModelTitle")}>{tr("node.noModel")}</Pill>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const nodeTypes = {
  table: TableNodeView,
  fn: FnNodeView,
  mod: ModNodeView,
  infra: InfraNodeView,
  model: ModelNodeView,
  sys: SysNodeView,
};
