import type Parser from "web-tree-sitter";

export type Node = Parser.SyntaxNode;

export interface TypeRef {
  pkg?: string;
  name: string;
}

export interface Call {
  name: string;
  line: number;
  pkg?: string; // alias de paquet / nom de crate qui qualifie l'appel (http.Get, redis::Client::open)
  root?: TypeRef | null; // type de la variable racine (s.repo.Find -> type de s)
  chain?: string[]; // champs traversés (repo)
  plain: boolean; // appel sans qualification : foo()
  ctor?: boolean; // new X() / X::new()
}

export interface Def {
  qual: string;
  name: string;
  recvType?: string;
  exported: boolean;
  async: boolean;
  params: string[];
  annotations: string[];
  calls: Call[];
  refs: string[];
  route: { method: string; path: string; auth: boolean | null } | null;
  worker: { lib: string } | null;
  entry: string | null;
  toks: number[];
  callees: string[];
  nstmts: number;
  complexity: number;
  http: { method: string; url: string; line: number }[];
  doc: string;
  line: number;
  end: number;
  iface?: boolean; // signature sans corps (interface / trait)
  tag?: string | null;
  infra?: { id: string; lib: string; op: string }[]; // infrastructure détectée directement par l'extracteur
}

export interface TypeInfo {
  name: string;
  kind: "struct" | "class" | "interface" | "trait" | "enum";
  fields: Map<string, TypeRef>;
  fieldList: { name: string; type: string; default: string | null }[];
  bases: string[];
  annotations: string[];
  tags: string[];
  line: number;
  end: number;
  exported: boolean;
}

export interface RawIssue {
  def: string | null;
  line: number;
  severity: "error" | "warning" | "info";
  category: string;
  rule: string;
  message: string;
  level: "high" | "medium" | "low" | null;
  params: Record<string, string | number>;
}

export interface FileInfo {
  rel: string;
  lang: "go" | "java" | "rust" | "kotlin" | "php" | "dart";
  pkgKey: string; // dossier (Go), paquet (Java), chemin de module (Rust)
  imports: Map<string, string>; // alias -> chemin
  importPaths: string[];
  defs: Def[];
  types: TypeInfo[];
  issues: RawIssue[];
  loc: number;
  securityConfig: boolean;
  routeRefs: { def: string | null; method: string; path: string; handler: string; auth: boolean; recvType?: string }[];
  workerRefs: { def: string | null; lib: string; handler: string }[];
  traitImpls: { type: string; trait: string }[];
  binds: { iface: string; impl: string }[];
}

const TYPE_IDS = new Map<string, number>();
export const tid = (t: string): number => {
  let v = TYPE_IDS.get(t);
  if (v === undefined) {
    v = TYPE_IDS.size + 1;
    TYPE_IDS.set(t, v);
  }
  return v;
};

export function stats(node: Node, decision: Set<string>): { cx: number; toks: number[] } {
  let cx = 1;
  const toks: number[] = [];
  const visit = (n: Node) => {
    toks.push(tid(n.type));
    if (decision.has(n.type)) cx++;
    else if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator")?.text;
      if (op === "&&" || op === "||") cx++;
    }
    for (const c of n.children) visit(c);
  };
  visit(node);
  return { cx, toks };
}

export function walk(n: Node, f: (n: Node) => boolean | void): void {
  if (f(n) === false) return;
  for (const c of n.children) walk(c, f);
}

export const SECRET_RE = /(password|passwd|pwd|secret|token|api_?key|private_?key|access_?key|auth_?key)/i;
export const SECRET_EXCLUDE = /(url|uri|path|header|type|name|field|expire|expires|minutes|days|hours|prefix|endpoint|route|label|env|scheme|algorithm)$/i;
export const SQL_RE = /\b(select|insert|update|delete|drop|where|from|values)\b/i;

export const unquote = (s: string): string => s.replace(/^[`"']|[`"']$/g, "").replace(/^r#*"|"#*$/g, "");

/** « /users/%s » ou « /users/{} » ou « /users/" + id » -> « /users/{} » */
export function urlOfText(text: string): string | null {
  let s = text.replace(/^["'`]|["'`]$/g, "");
  s = s.replace(/%[sdvq]|\$\{[^}]*\}|\{[^}]*\}/g, "{}");
  s = s.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
  while (s.startsWith("{}/")) s = s.slice(2);
  if (!s.startsWith("/")) return null;
  return s.length > 1 ? s.replace(/\/+$/, "") : null;
}

export const mkDef = (over: Partial<Def> & Pick<Def, "qual" | "name" | "line" | "end">): Def => ({
  exported: false, async: false, params: [], annotations: [], calls: [], refs: [], route: null, worker: null, entry: null, toks: [], callees: [], nstmts: 0,
  complexity: 1, http: [], doc: "", ...over,
});
