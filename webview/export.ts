import { getNodesBounds, getViewportForBounds, type Edge, type Node } from "@xyflow/react";
import { toPng, toSvg } from "html-to-image";

export function nodeLabel(n: Node): string {
  const d: any = n.data;
  switch (n.type) {
    case "fn":
      return d.fn.label;
    case "mod":
      return d.mod.name;
    case "infra":
      return d.label;
    case "model":
      return d.model.name;
    case "table":
      return `${d.table.name} (${d.dbType})`;
    case "sys":
      return d.node.kind === "routes" ? `${d.node.label} — ${d.node.sub}` : d.node.label;
    default:
      return n.id;
  }
}

const esc = (s: string) => s.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"));

/** Texte Mermaid (flowchart) de la vue courante. */
export function toMermaid(nodes: Node[], edges: Edge[], title: string): string {
  const ids = new Map<string, string>();
  nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
  const lines: string[] = [`%% Cartograph — vue « ${title} »`, "flowchart LR"];
  for (const n of nodes) {
    const id = ids.get(n.id)!;
    const label = esc(nodeLabel(n));
    switch (n.type) {
      case "infra":
        lines.push(`  ${id}[("${label}")]`);
        break;
      case "table":
        lines.push(`  ${id}[("${label}")]`);
        break;
      case "model":
        lines.push(`  ${id}[["${label}"]]`);
        break;
      case "sys": {
        const k = (n.data as any).node.kind;
        lines.push(k === "routes" ? `  ${id}(["${label}"])` : k === "process" ? `  ${id}{{"${label}"}}` : `  ${id}["${label}"]`);
        break;
      }
      default:
        lines.push(`  ${id}["${label}"]`);
    }
  }
  for (const e of edges) {
    const s = ids.get(e.source);
    const t = ids.get(e.target);
    if (!s || !t) continue;
    const kind = (e.data as any)?.kind as string | undefined;
    const label = typeof e.label === "string" && e.label ? `|${esc(e.label)}|` : "";
    const arrow = kind === "broker" ? "==>" : kind === "async" || kind === "ref" || kind === "depends" || kind === "runs" ? "-.->" : "-->";
    lines.push(`  ${s} ${arrow}${label} ${t}`);
  }
  return lines.join("\n") + "\n";
}

/** Capture PNG ou SVG de tout le graphe (pas seulement la zone visible). */
export async function snapshot(kind: "png" | "svg", nodes: Node[]): Promise<string> {
  const el = document.querySelector<HTMLElement>(".react-flow__viewport");
  if (!el) throw new Error("graphe introuvable");
  const bounds = getNodesBounds(nodes);
  const width = Math.min(9000, Math.max(600, Math.ceil(bounds.width) + 120));
  const height = Math.min(9000, Math.max(400, Math.ceil(bounds.height) + 120));
  const vp = getViewportForBounds(bounds, width, height, 0.05, 2, "60px");
  const bg = getComputedStyle(document.body).backgroundColor || "#1e1e1e";
  const opts = {
    backgroundColor: bg,
    width,
    height,
    pixelRatio: kind === "png" ? (width * height > 25_000_000 ? 1 : 2) : 1,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
  };
  return kind === "png" ? toPng(el, opts) : toSvg(el, opts);
}
