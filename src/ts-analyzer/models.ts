import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { IGNORE_DIRS } from "./config";
import type { State } from "./types";

export interface ModelOut {
  id: string;
  name: string;
  module: string;
  file: string;
  line: number;
  kind: string;
  store: string | null;
  fields: { name: string; type: string; default: string | null }[];
  nFields: number;
  tablename: string | null;
  usedBy: string[];
  used: Set<string>;
}

export interface ModelsResult {
  list: ModelOut[];
  edges: { source: string; target: string; label: string; kind: string }[];
  prismaStore: string | null;
}

const PROVIDER_STORE: Record<string, string> = { postgresql: "postgres", postgres: "postgres", mysql: "mysql", sqlite: "sqlite", mongodb: "mongodb", cockroachdb: "postgres" };
const norm = (p: string) => p.split(path.sep).join("/");
const key = (S: State, n: ts.Node) => `${norm(path.relative(S.root, n.getSourceFile().fileName))}#${n.getStart(n.getSourceFile())}`;
const strOf = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function findPrisma(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let es: fs.Dirent[];
    try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith(".") && depth < 5) walk(path.join(dir, e.name), depth + 1); }
      else if (e.name.endsWith(".prisma")) out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out.slice(0, 5);
}

function objectFields(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, deep = false) {
  const fields: ModelOut["fields"] = [];
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
    const name = p.name.getText(sf).replace(/['"]/g, "");
    let type = ts.isPropertyAssignment(p) ? p.initializer.getText(sf) : name;
    if (deep && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
      const t = p.initializer.properties.find((q) => ts.isPropertyAssignment(q) && q.name.getText(sf) === "type") as ts.PropertyAssignment | undefined;
      if (t) type = t.initializer.getText(sf);
    }
    fields.push({ name, type: type.replace(/\s+/g, " ").slice(0, 60), default: null });
  }
  return fields;
}

export function buildModels(S: State, root: string): ModelsResult {
  const list: ModelOut[] = [];
  const edges: ModelsResult["edges"] = [];
  let prismaStore: string | null = null;
  const mk = (m: Omit<ModelOut, "usedBy" | "used" | "nFields">): ModelOut => {
    const o: ModelOut = { ...m, usedBy: [], used: new Set(), nFields: m.fields.length };
    list.push(o);
    return o;
  };

  // ---- Prisma
  for (const f of findPrisma(root)) {
    const src = fs.readFileSync(f, "utf8");
    const rel = norm(path.relative(root, f));
    const prov = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(src);
    const store = prov ? PROVIDER_STORE[prov[1]] ?? "sql" : "sql";
    prismaStore = prismaStore ?? store;
    const names = [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
    for (const m of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const name = m[1];
      const line = src.slice(0, m.index).split("\n").length;
      const fields: ModelOut["fields"] = [];
      let table: string | null = null;
      for (const raw of m[2].split("\n")) {
        const l = raw.trim();
        if (!l || l.startsWith("//")) continue;
        const mapm = /^@@map\("([^"]+)"\)/.exec(l);
        if (mapm) { table = mapm[1]; continue; }
        if (l.startsWith("@@")) continue;
        const fm = /^(\w+)\s+([\w]+(?:\[\])?\??)\s*(.*)$/.exec(l);
        if (!fm) continue;
        const dm = /@default\(([^)]*\)?)\)?/.exec(fm[3]);
        fields.push({ name: fm[1], type: fm[2], default: dm ? dm[1] : null });
        const base = fm[2].replace(/\[\]|\?/g, "");
        if (names.includes(base) && base !== name) edges.push({ source: `cls:prisma:${name}`, target: `cls:prisma:${base}`, label: fm[1], kind: "relation" });
      }
      const o = mk({ id: `cls:prisma:${name}`, name, module: rel.replace(/\.prisma$/, ""), file: rel, line, kind: "orm", store, fields, tablename: table });
      S.prismaUse.set(lcfirst(name), o.used);
    }
  }

  // ---- zod, mongoose (variables de premier niveau)
  const schemaObjs = new Map<string, { obj: ts.ObjectLiteralExpression; sf: ts.SourceFile }>();
  for (const v of S.varDecls) {
    const init = v.decl.initializer;
    if (!init || !ts.isIdentifier(v.decl.name)) continue;
    const e = ts.isNewExpression(init) ? init : undefined;
    if (e && /(^|\.)Schema$/.test(e.expression.getText(v.sf)) && e.arguments?.[0] && ts.isObjectLiteralExpression(e.arguments[0])) {
      schemaObjs.set(`${v.mod}:${v.decl.name.text}`, { obj: e.arguments[0], sf: v.sf });
    }
  }
  const seen = new Set<string>();
  for (const v of S.varDecls) {
    const init = v.decl.initializer;
    if (!init || !ts.isIdentifier(v.decl.name)) continue;
    const text = init.getText(v.sf);
    const file = norm(path.relative(root, v.sf.fileName));
    const line = v.sf.getLineAndCharacterOfPosition(v.decl.getStart(v.sf)).line + 1;
    if (/^z\.(strict)?[oO]bject\(/.test(text) && ts.isCallExpression(init) && init.arguments[0] && ts.isObjectLiteralExpression(init.arguments[0])) {
      const o = mk({ id: `cls:${v.mod}:${v.decl.name.text}`, name: v.decl.name.text, module: v.mod, file, line, kind: "zod", store: null, fields: objectFields(init.arguments[0], v.sf), tablename: null });
      S.modelByKey.set(key(S, v.decl), o.used);
      continue;
    }
    if (ts.isCallExpression(init) && /(^|\.)model$/.test(init.expression.getText(v.sf)) && strOf(init.arguments[0])) {
      const mname = strOf(init.arguments[0])!;
      let schema: { obj: ts.ObjectLiteralExpression; sf: ts.SourceFile } | undefined;
      const a1 = init.arguments[1];
      if (a1 && ts.isIdentifier(a1)) schema = schemaObjs.get(`${v.mod}:${a1.text}`);
      else if (a1 && ts.isNewExpression(a1) && a1.arguments?.[0] && ts.isObjectLiteralExpression(a1.arguments[0])) schema = { obj: a1.arguments[0], sf: v.sf };
      if (seen.has(mname)) continue;
      seen.add(mname);
      const o = mk({ id: `cls:${v.mod}:${mname}`, name: mname, module: v.mod, file, line, kind: "odm", store: "mongodb", fields: schema ? objectFields(schema.obj, schema.sf, true) : [], tablename: null });
      S.modelByKey.set(key(S, v.decl), o.used);
    }
  }

  // ---- TypeORM
  const entities: { name: string; o: ModelOut; node: ts.ClassDeclaration | ts.ClassExpression; sf: ts.SourceFile }[] = [];
  for (const c of S.classDecls) {
    const decos = ts.getDecorators(c.node) ?? [];
    if (!decos.some((d) => /^Entity\b/.test(d.expression.getText(c.sf)))) continue;
    const name = c.node.name?.text ?? "default";
    const fields: ModelOut["fields"] = [];
    for (const m of c.node.members) {
      if (!ts.isPropertyDeclaration(m)) continue;
      const ds = (ts.getDecorators(m) ?? []).map((d) => d.expression.getText(c.sf).split("(")[0]);
      if (!ds.some((d) => /Column|ManyToOne|OneToMany|OneToOne|ManyToMany/.test(d))) continue;
      fields.push({ name: m.name.getText(c.sf), type: (m.type ? m.type.getText(c.sf) : ds[0]).slice(0, 60), default: null });
    }
    const file = norm(path.relative(root, c.sf.fileName));
    const o = mk({ id: `cls:${c.mod}:${name}`, name, module: c.mod, file, line: c.sf.getLineAndCharacterOfPosition(c.node.getStart(c.sf)).line + 1, kind: "orm", store: "sql", fields, tablename: null });
    S.modelByKey.set(key(S, c.node), o.used);
    entities.push({ name, o, node: c.node, sf: c.sf });
  }
  for (const e of entities) {
    for (const f of e.o.fields) {
      for (const tok of new Set(f.type.match(/[A-Za-z_]\w*/g) ?? [])) {
        const t = entities.find((x) => x.name === tok);
        if (t && t.name !== e.name) edges.push({ source: e.o.id, target: t.o.id, label: f.name, kind: "relation" });
      }
    }
  }
  const uniq = new Map(edges.map((e) => [`${e.source}>${e.target}>${e.label}`, e]));
  return { list, edges: [...uniq.values()], prismaStore };
}
