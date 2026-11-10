/* Cartograph — analyseur TypeScript / JavaScript (API du compilateur TypeScript).
 * Produit le même JSON que analyzer/analyze.py. Usage : node analyze_ts.js <racine> [--exclude d] [--out f] */
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import {
  AUTH_TEXT_RE, HOC_NAMES, HTTP_VERBS, IGNORE_DIRS, INFRA, MAX_FILE_BYTES, QUEUE_IDS, ROUTE_ROOT_RE, SECRET_NAME_EXCLUDE,
  SECRET_RE, SECRET_VALUE_RE, SRC_RE, STRICT_LAYERS, TOKEN_LAYER, VERSION, WRITE_METHODS, infraForPackage, pkgName,
} from "./config";
import { buildModels, type ModelOut } from "./models";
import { finalize } from "./output";
import type { Rec, Mod, State, Target, Issue } from "./types";

const norm = (p: string) => p.split(path.sep).join("/");

// ------------------------------------------------------------------ découverte
function discover(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || exclude.has(e.name) || e.name.startsWith(".") && e.name !== ".") continue;
        if (depth < 14) walk(path.join(dir, e.name), depth + 1);
      } else if (SRC_RE.test(e.name) && !e.name.endsWith(".d.ts") && !/\.min\.[cm]?js$/.test(e.name)) {
        const p = path.join(dir, e.name);
        try {
          if (fs.statSync(p).size <= MAX_FILE_BYTES) out.push(p);
        } catch {
          /* ignoré */
        }
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

function findConfigs(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || exclude.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < 4) walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === "tsconfig.json" || e.name === "jsconfig.json") out.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  return out;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true, checkJs: false, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true, types: [], resolveJsonModule: true,
};

interface Group {
  dir: string;
  options: ts.CompilerOptions;
  files: string[];
}

function makeGroups(root: string, files: string[], configs: string[]): Group[] {
  const cfgs = configs.map((c) => ({ dir: path.dirname(c), file: c })).sort((a, b) => b.dir.length - a.dir.length);
  const groups = new Map<string, Group>();
  for (const f of files) {
    const cfg = cfgs.find((c) => f.startsWith(c.dir + path.sep));
    const key = cfg ? cfg.file : "<default>";
    if (!groups.has(key)) {
      let options: ts.CompilerOptions = { ...DEFAULT_OPTIONS };
      if (cfg) {
        try {
          const raw = ts.readConfigFile(cfg.file, ts.sys.readFile);
          const parsed = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, cfg.dir, undefined, cfg.file);
          options = { ...DEFAULT_OPTIONS, ...parsed.options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, types: [], incremental: false, composite: false, declaration: false };
          delete (options as any).tsBuildInfoFile;
          if (options.jsx === undefined || options.jsx === ts.JsxEmit.None) options.jsx = ts.JsxEmit.ReactJSX;
        } catch {
          /* options par défaut */
        }
      }
      groups.set(key, { dir: cfg ? cfg.dir : root, options, files: [] });
    }
    groups.get(key)!.files.push(f);
  }
  return [...groups.values()];
}

// ------------------------------------------------------------------ utilitaires AST
const isFnLike = (n: ts.Node | undefined): n is ts.FunctionLikeDeclaration =>
  !!n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n));

function unwrap(e: ts.Node): ts.Node {
  let c = e;
  for (;;) {
    if (ts.isParenthesizedExpression(c) || ts.isAsExpression(c) || ts.isNonNullExpression(c) || ts.isAwaitExpression(c) || ts.isSatisfiesExpression(c) || ts.isTypeAssertionExpression(c)) c = (c as any).expression;
    else return c;
  }
}

const strOf = (n: ts.Node | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

function urlPattern(e: ts.Node | undefined): string | null {
  if (!e) return null;
  e = unwrap(e);
  let s: string | null = null;
  const part = (n: ts.Node): string => {
    n = unwrap(n);
    const lit = strOf(n);
    if (lit !== null) return lit;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp) => "{}" + sp.literal.text).join("");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return part(n.left) + part(n.right);
    return "{}";
  };
  s = part(e);
  s = s.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
  while (s.startsWith("{}") && s.length > 2 && s[2] === "/") s = s.slice(2);
  if (!s.startsWith("/")) return null;
  return s.length > 1 ? s.replace(/\/+$/, "") : null;
}

function cyclomatic(root: ts.Node): number {
  let c = 1;
  const v = (n: ts.Node) => {
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement: case ts.SyntaxKind.ForStatement: case ts.SyntaxKind.ForInStatement: case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement: case ts.SyntaxKind.DoStatement: case ts.SyntaxKind.CaseClause: case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        c++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const k = (n as ts.BinaryExpression).operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) c++;
      }
    }
    ts.forEachChild(n, v);
  };
  v(root);
  return c;
}

function classifyLayer(rel: string): string {
  const tokens = rel.replace(SRC_RE, "").toLowerCase().split(/[\/_.\-]/).filter(Boolean);
  if (tokens.some((t) => t === "test" || t === "spec" || t === "tests" || t === "e2e" || t === "__tests__")) return "test";
  const clientish = tokens.some((t) => ["lib", "client", "clients", "services", "service", "hooks", "utils", "sdk", "helpers"].includes(t));
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === "api" && clientish) continue;
    if (TOKEN_LAYER[tokens[i]]) return TOKEN_LAYER[tokens[i]];
  }
  return "other";
}

const dyn = (s: string) => s.replace(/^\[\[?\.\.\.(.+?)\]?\]$/, "{$1}").replace(/^\[(.+)\]$/, "{$1}");

export function nextInfo(file: string): { kind: "page" | "api" | "layout"; path: string; scope: string; app: boolean } | null {
  const parts = file.split("/");
  const ai = parts.findIndex((p) => p === "app" || p === "pages");
  if (ai < 0) return null;
  const scope = parts.slice(0, ai).join("/");
  const base = parts[parts.length - 1].replace(SRC_RE, "");
  const dirs = parts.slice(ai + 1, -1);
  if (parts[ai] === "app") {
    const seg = dirs.filter((d) => !/^\(.*\)$/.test(d) && !d.startsWith("@")).map(dyn);
    const p = "/" + seg.join("/");
    if (base === "page") return { kind: "page", path: p, scope, app: true };
    if (base === "route") return { kind: "api", path: p, scope, app: true };
    if (["layout", "loading", "error", "not-found", "template", "default", "global-error"].includes(base)) return { kind: "layout", path: p, scope, app: true };
    return null;
  }
  if (base.startsWith("_")) return { kind: "layout", path: "/", scope, app: false };
  const p = "/" + [...dirs, base === "index" ? "" : base].filter(Boolean).map(dyn).join("/");
  return dirs[0] === "api" ? { kind: "api", path: p, scope, app: false } : { kind: "page", path: p, scope, app: false };
}

// ------------------------------------------------------------------ phase 1 : collecte
function newRec(S: State, sf: ts.SourceFile, node: ts.Node, qual: string, over: Partial<Rec> = {}): Rec {
  const file = norm(path.relative(S.root, sf.fileName));
  const mod = file.replace(SRC_RE, "");
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const fn = isFnLike(node) ? node : undefined;
  const rec: Rec = {
    id: `fn:${mod}:${qual}`, kind: qual.includes(".") ? "method" : "function", qual, name: qual.split(".").pop()!.split(" ").pop()!, module: mod, file,
    line: start, end, complexity: cyclomatic(node), loc: end - start + 1,
    args: fn ? fn.parameters.map((p) => p.name.getText(sf)) : [], async: !!fn && !!(ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async),
    decorators: [], doc: "", exported: false, tag: null, route: null, worker: null, entry: null,
    calls: [], ids: [], toks: [], callees: [], nstmts: 0, http: [], node, sf, auth: false, dead: null, dup: null, callers: 0, callees2: 0,
    defaultExport: false, ...over,
  };
  const jd = (node as any).jsDoc?.[0]?.comment;
  if (typeof jd === "string") rec.doc = jd.split("\n")[0].slice(0, 140);
  if (/\.(tsx|jsx)$/.test(sf.fileName) && /^[A-Z]/.test(rec.name) && !qual.includes(".")) rec.tag = "component";
  else if (/^use[A-Z]/.test(rec.name)) rec.tag = "hook";
  if (ts.canHaveDecorators(node)) rec.decorators = (ts.getDecorators(node) ?? []).map((d) => d.expression.getText(sf).split("(")[0]);
  if (AUTH_TEXT_RE.test(node.getText(sf).toLowerCase())) rec.auth = true;
  const body = (fn as any)?.body ?? node;
  if (body && ts.isBlock(body)) rec.nstmts = body.statements.length;
  S.recs.push(rec);
  S.byId.set(rec.id, rec);
  S.recByKey.set(keyOf(S, node), rec);
  return rec;
}

const keyOf = (S: State, n: ts.Node): string => `${norm(path.relative(S.root, n.getSourceFile().fileName))}#${n.getStart(n.getSourceFile())}`;

function addIssue(S: State, rec: Rec, node: ts.Node, severity: Issue["severity"], category: string, rule: string, message: string, level: Issue["level"] = null, params: Record<string, string | number> = {}) {
  const sf = rec.sf;
  S.issues.push({
    id: "", severity, category, rule, message, file: rec.file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    node: rec.id, source: "cartograph", level, params,
  });
}

function collectFile(S: State, sf: ts.SourceFile, opts: ts.CompilerOptions, cache: ts.ModuleResolutionCache, C: ts.TypeChecker) {
  const file = norm(path.relative(S.root, sf.fileName));
  const modName = file.replace(SRC_RE, "");
  const text = sf.text;
  const top: Rec = {
    id: `mod:${modName}`, kind: "module", qual: "<module>", name: modName, module: modName, file, line: 1, end: 1, complexity: 0, loc: 0, args: [], async: false,
    decorators: [], doc: "", exported: false, tag: null, route: null, worker: null, entry: null, calls: [], ids: [], toks: [], callees: [], nstmts: 0, http: [],
    node: sf, sf, auth: false, dead: null, dup: null, callers: 0, callees2: 0, defaultExport: false,
  };
  const mod: Mod = {
    name: modName, file, layer: classifyLayer(file), loc: text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length,
    top, imports: new Set(), pkgs: new Set(), checker: C, functions: 0,
  };
  S.modules.set(modName, mod);
  S.fileToMod.set(sf.fileName, mod);
  const next = nextInfo(file);

  // imports → arêtes de modules + paquets externes
  const addImport = (spec: string | undefined) => {
    if (!spec) return;
    const r = ts.resolveModuleName(spec, sf.fileName, opts, ts.sys, cache).resolvedModule;
    if (r && !r.isExternalLibraryImport && S.files.has(r.resolvedFileName)) mod.imports.add(r.resolvedFileName);
    else if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@/") && !spec.startsWith("~/") && !spec.startsWith("#")) mod.pkgs.add(pkgName(spec));
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) addImport(st.moduleSpecifier.text);
    else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) addImport(st.moduleSpecifier.text);
  }

  const exportedNames = new Set<string>();
  let defaultName: string | null = null;
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) st.exportClause.elements.forEach((e) => exportedNames.add((e.propertyName ?? e.name).text));
    if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) defaultName = st.expression.text;
  }
  const fileRecs: Rec[] = [];
  const mk = (node: ts.Node, qual: string, over: Partial<Rec> = {}) => {
    const r = newRec(S, sf, node, qual, over);
    r.exported = !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) || exportedNames.has(r.name);
    if (defaultName && r.name === defaultName) r.defaultExport = true;
    if (!!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default)) r.defaultExport = true;
    fileRecs.push(r);
    mod.functions++;
    return r;
  };

  const handlerRec = (fnNode: ts.Node, qual: string, over: Partial<Rec>, authFromArgs = false) => {
    const r = mk(fnNode, qual, over);
    if (authFromArgs) r.auth = true;
    S.recByKey.set(keyOf(S, fnNode), r);
    scan(fnNode, r, true);
    return r;
  };

  // ---- parcours sémantique d'un corps de fonction
  function scan(node: ts.Node, cur: Rec, isRoot = false): void {
    if (cur !== top) cur.toks.push(node.kind);
    switch (node.kind) {
      case ts.SyntaxKind.Identifier: {
        const p: any = node.parent;
        if (!(p && p.name === node) && !(p && p.propertyName === node)) cur.ids.push(node as ts.Identifier);
        break;
      }
      case ts.SyntaxKind.CatchClause: {
        const cc = node as ts.CatchClause;
        if (cc.block.statements.length === 0) addIssue(S, cur, node, "warning", "quality", "swallowed-exception", "Bloc catch vide : l'erreur est ignorée");
        break;
      }
      case ts.SyntaxKind.JsxAttribute: {
        if ((node as ts.JsxAttribute).name.getText(sf) === "dangerouslySetInnerHTML") addIssue(S, cur, node, "warning", "security", "dangerously-set-inner-html", "dangerouslySetInnerHTML (risque XSS)", "medium");
        break;
      }
      case ts.SyntaxKind.PropertyAssignment: {
        const pa = node as ts.PropertyAssignment;
        const name = pa.name.getText(sf).replace(/['"]/g, "");
        const v = strOf(pa.initializer);
        if (name === "rejectUnauthorized" && pa.initializer.kind === ts.SyntaxKind.FalseKeyword) addIssue(S, cur, node, "warning", "security", "tls-verify-off", "Vérification TLS désactivée (rejectUnauthorized: false)", "medium");
        if (name === "origin" && v === "*") addIssue(S, cur, node, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");
        if (v && v.length >= 6 && SECRET_RE.test(name) && !SECRET_NAME_EXCLUDE.test(name) && !v.includes("://") && !v.startsWith("/")) addIssue(S, cur, node, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${name} »`, "medium", { name });
        break;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        const vd = node as ts.VariableDeclaration;
        const v = strOf(vd.initializer);
        if (v && v.length >= 6 && ts.isIdentifier(vd.name) && SECRET_RE.test(vd.name.text) && !SECRET_NAME_EXCLUDE.test(vd.name.text) && !v.includes("://") && !v.startsWith("/"))
          addIssue(S, cur, node, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${vd.name.text} »`, "medium", { name: vd.name.text });
        break;
      }
      case ts.SyntaxKind.StringLiteral: {
        if (SECRET_VALUE_RE.test((node as ts.StringLiteral).text)) addIssue(S, cur, node, "error", "security", "secret-pattern", "Clé ou secret au format connu dans le code source", "high");
        break;
      }
      case ts.SyntaxKind.BinaryExpression: {
        const be = node as ts.BinaryExpression;
        if (be.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = be.left.getText(sf);
          if (/\.(innerHTML|outerHTML)$/.test(left) && strOf(be.right) === null) addIssue(S, cur, node, "warning", "security", "inner-html", "Affectation de innerHTML avec une valeur dynamique (XSS)", "medium");
          if (/NODE_TLS_REJECT_UNAUTHORIZED$/.test(left) && strOf(be.right) === "0") addIssue(S, cur, node, "warning", "security", "tls-verify-off", "Vérification TLS désactivée globalement", "medium");
          if (ts.isPropertyAccessExpression(be.left) && be.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const k = be.left.name.text;
            (S.thisAssigns.get(`${modName}:${k}`) ?? S.thisAssigns.set(`${modName}:${k}`, []).get(`${modName}:${k}`)!).push(be.right);
          }
        }
        break;
      }
      case ts.SyntaxKind.NewExpression:
      case ts.SyntaxKind.CallExpression: {
        const call = node as ts.CallExpression | ts.NewExpression;
        const callee = call.expression;
        const calleeText = callee.getText(sf);
        const last = ts.isPropertyAccessExpression(callee) ? callee.name.text : calleeText;
        cur.calls.push(call);
        cur.callees.push(last);
        const args = call.arguments ? [...call.arguments] : [];
        if (ts.isNewExpression(call) && calleeText === "Function") addIssue(S, cur, node, "error", "security", "dangerous-eval", "new Function() : exécution dynamique de code", "high", { fn: "new Function" });
        if (calleeText === "eval") addIssue(S, cur, node, "error", "security", "dangerous-eval", "Exécution dynamique de code (eval)", "high", { fn: "eval" });
        if (calleeText === "cors" && args.length === 0) addIssue(S, cur, node, "warning", "security", "cors-wildcard", "cors() sans option : toutes les origines sont autorisées", "medium");
        if (/^document\.write(ln)?$/.test(calleeText)) addIssue(S, cur, node, "warning", "security", "document-write", "document.write avec contenu dynamique", "medium");
        if (/^localStorage\.setItem$/.test(calleeText) && /token|jwt|secret/i.test(strOf(args[0]) ?? "")) addIssue(S, cur, node, "info", "security", "token-localstorage", "Jeton stocké dans localStorage (exposé en cas de XSS)", "low");
        if (/^(child_process\.)?(exec|execSync)$/.test(calleeText) && args[0]) {
          const a = unwrap(args[0]);
          if (ts.isTemplateExpression(a) || (ts.isBinaryExpression(a) && strOf(a.left) !== null && strOf(a.right) === null)) addIssue(S, cur, node, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: calleeText });
        }
        if (["query", "execute", "raw", "queryRawUnsafe", "$queryRawUnsafe", "executeRawUnsafe", "$executeRawUnsafe"].includes(last) && args[0]) {
          const a = unwrap(args[0]);
          const dynamic = ts.isTemplateExpression(a) || (ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.PlusToken && (strOf(a.left) !== null || strOf(a.right) !== null) && strOf(a) === null);
          if (dynamic && /\b(select|insert|update|delete|where|from)\b/i.test(a.getText(sf))) addIssue(S, cur, node, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
        }
        // requêtes HTTP sortantes (liens front → back)
        const isFetch = calleeText === "fetch" || calleeText === "$fetch";
        const axiosVerb = /^(axios|ky|api|http|client)\.(get|post|put|delete|patch)$/i.exec(calleeText);
        if ((isFetch || axiosVerb) && args[0]) {
          const url = urlPattern(args[0]);
          if (url) {
            let method = axiosVerb ? axiosVerb[2].toUpperCase() : "GET";
            if (isFetch && args[1] && ts.isObjectLiteralExpression(unwrap(args[1]))) {
              const m = (unwrap(args[1]) as ts.ObjectLiteralExpression).properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "method") as ts.PropertyAssignment | undefined;
              const mv = m && strOf(m.initializer);
              if (mv) method = mv.toUpperCase();
            }
            cur.http.push({ method, url, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
          }
        }
        // routes Express / Fastify / Hono
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(callee) && HTTP_VERBS.has(callee.name.text) && args.length >= 2) {
          const root = callee.expression.getText(sf).split(".").pop()!;
          const p = strOf(args[0]);
          if (p !== null && ROUTE_ROOT_RE.test(root)) {
            const method = callee.name.text.toUpperCase();
            const authArg = args.slice(1, -1).some((a) => /auth|guard|protect|session|jwt|passport/i.test(a.getText(sf)));
            scan(callee, cur);
            scan(args[0], cur);
            for (const a of args.slice(1)) {
              if (isFnLike(a)) {
                handlerRec(a, `${method} ${p}`, { route: { method, path: p, auth: null }, entry: "route", tag: null }, authArg);
              } else {
                scan(a, cur);
                if (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) S.pendingRoutes.push({ node: a, method, path: p, auth: authArg, C });
              }
            }
            return;
          }
        }
        // workers BullMQ / Bull / cron
        if (ts.isNewExpression(call) && /(^|\.)Worker$/.test(calleeText) && args.length >= 2 && strOf(args[0]) !== null) {
          scan(callee, cur);
          const qn = strOf(args[0])!;
          if (isFnLike(args[1])) {
            handlerRec(args[1], `Worker ${qn}`, { worker: { lib: "bullmq", queue: "bullmq" }, entry: "worker" });
          } else {
            scan(args[1], cur);
            S.pendingWorkers.push({ node: args[1], lib: "bullmq", C });
          }
          for (const a of args.slice(2)) scan(a, cur);
          return;
        }
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(callee) && callee.name.text === "process" && isFnLike(args[args.length - 1]) && /queue/i.test(callee.expression.getText(sf))) {
          scan(callee, cur);
          handlerRec(args[args.length - 1], `process ${callee.expression.getText(sf)}`, { worker: { lib: "bullmq", queue: "bullmq" }, entry: "worker" });
          return;
        }
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(callee) && callee.name.text === "schedule" && /cron|schedule/i.test(callee.expression.getText(sf)) && args.length >= 2 && isFnLike(args[1])) {
          scan(callee, cur);
          handlerRec(args[1], `cron ${strOf(args[0]) ?? ""}`.trim(), { worker: { lib: "scheduler", queue: "scheduler" }, entry: "worker" });
          return;
        }
        break;
      }
    }
    ts.forEachChild(node, (c) => scan(c, cur));
  }

  // ---- déclarations de premier niveau
  const declVar = (decl: ts.VariableDeclaration, stmt: ts.Node) => {
    if (!ts.isIdentifier(decl.name)) {
      if (decl.initializer) scan(decl.initializer, top);
      return;
    }
    const name = decl.name.text;
    const init = decl.initializer ? unwrap(decl.initializer) : undefined;
    if (init && isFnLike(init)) {
      const r = mk(decl, name);
      r.exported = r.exported || !!(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export);
      S.recByKey.set(keyOf(S, init), r);
      scan(init, r, true);
      return;
    }
    if (init && ts.isCallExpression(init) && init.arguments.length > 0 && isFnLike(unwrap(init.arguments[0])) && (/^[A-Z]/.test(name) || /^use[A-Z]/.test(name) || HOC_NAMES.has(init.expression.getText(sf).split(".").pop()!))) {
      const fnNode = unwrap(init.arguments[0]);
      const r = mk(decl, name);
      S.recByKey.set(keyOf(S, fnNode), r);
      scan(fnNode, r, true);
      scan(init.expression, top);
      init.arguments.slice(1).forEach((a) => scan(a, top));
      return;
    }
    if (init && ts.isObjectLiteralExpression(init)) {
      let any = false;
      for (const p of init.properties) {
        if (ts.isMethodDeclaration(p) && p.body) {
          const r = mk(p, `${name}.${p.name.getText(sf)}`);
          scan(p, r, true);
          any = true;
        } else if (ts.isPropertyAssignment(p) && isFnLike(unwrap(p.initializer))) {
          const r = mk(p, `${name}.${p.name.getText(sf)}`);
          S.recByKey.set(keyOf(S, unwrap(p.initializer)), r);
          scan(unwrap(p.initializer), r, true);
          any = true;
        } else scan(p, top);
      }
      if (any) return;
      return;
    }
    // modèles (zod, mongoose) : repérés ici, la suite est traitée dans models.ts
    S.varDecls.push({ decl, mod: modName, sf });
    if (decl.initializer) scan(decl.initializer, top);
    void stmt;
  };

  const declClass = (node: ts.ClassDeclaration | ts.ClassExpression) => {
    const cname = node.name?.text ?? "default";
    S.classDecls.push({ node, mod: modName, sf, C });
    const decos = ts.getDecorators(node) ?? [];
    let base = "";
    let ctrlAuth = false;
    for (const d of decos) {
      const t = d.expression.getText(sf);
      if (/^Module\(/.test(t) && ts.isCallExpression(d.expression) && d.expression.arguments[0] && ts.isObjectLiteralExpression(d.expression.arguments[0])) {
        for (const p of d.expression.arguments[0].properties) {
          if (!ts.isPropertyAssignment(p) || p.name.getText(sf) !== "providers" || !ts.isArrayLiteralExpression(p.initializer)) continue;
          for (const el of p.initializer.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const prov = el.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === "provide") as ts.PropertyAssignment | undefined;
            const use = el.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf) === "useClass") as ts.PropertyAssignment | undefined;
            if (prov && use) S.providers.push({ provide: prov.initializer, useClass: use.initializer, C });
          }
        }
      }
      if (/^Controller\(/.test(t) && ts.isCallExpression(d.expression)) base = strOf(d.expression.arguments[0]) ?? "";
      if (/^UseGuards/.test(t)) ctrlAuth = true;
    }
    const exportedCls = !!(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
    for (const m of node.members) {
      const isFnMember = (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.body;
      const isArrowField = ts.isPropertyDeclaration(m) && m.initializer && isFnLike(unwrap(m.initializer));
      if (isFnMember || isArrowField) {
        const mname = ts.isConstructorDeclaration(m) ? "constructor" : (m as any).name.getText(sf);
        const r = mk(m, `${cname}.${mname}`);
        r.exported = exportedCls;
        if (isArrowField) S.recByKey.set(keyOf(S, unwrap((m as ts.PropertyDeclaration).initializer!)), r);
        for (const d of ts.getDecorators(m as any) ?? []) {
          const dn = d.expression.getText(sf).split("(")[0];
          const dArgs = ts.isCallExpression(d.expression) ? d.expression.arguments : undefined;
          if (["Get", "Post", "Put", "Delete", "Patch", "All", "Options", "Head"].includes(dn)) {
            const sub = (dArgs && strOf(dArgs[0])) || "";
            r.route = { method: dn.toUpperCase(), path: "/" + [base, sub].filter(Boolean).join("/").replace(/^\/+/, ""), auth: null };
            r.entry = "route";
            if (ctrlAuth) r.auth = true;
          } else if (dn === "UseGuards") r.auth = true;
          else if (["Cron", "Interval", "Timeout"].includes(dn)) {
            r.worker = { lib: "scheduler", queue: "scheduler" };
            r.entry = "worker";
          } else if (["Process", "OnQueueCompleted", "OnWorkerEvent"].includes(dn)) {
            r.worker = { lib: "bullmq", queue: "bullmq" };
            r.entry = "worker";
          } else if (["OnEvent", "MessagePattern", "EventPattern", "SubscribeMessage"].includes(dn)) r.entry = r.entry ?? "handler";
        }
        scan(m, r, true);
      } else {
        scan(m, top);
      }
    }
    for (const h of node.heritageClauses ?? []) scan(h, top);
  };

  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.body) {
      const r = mk(st, st.name?.text ?? "default");
      scan(st, r, true);
    } else if (ts.isClassDeclaration(st)) declClass(st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) declVar(d, st);
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && isFnLike(unwrap(st.expression))) {
      const r = mk(st, "default");
      r.defaultExport = true;
      r.exported = true;
      S.recByKey.set(keyOf(S, unwrap(st.expression)), r);
      scan(unwrap(st.expression), r, true);
    } else if (ts.isImportDeclaration(st)) {
      /* géré plus haut */
    } else scan(st, top);
  }
  top.toks = [];

  // conventions Next.js
  if (next) {
    for (const r of fileRecs) {
      if (r.route) continue;
      if (next.kind === "api" && next.app && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(r.name) && r.exported) {
        r.route = { method: r.name, path: next.path, auth: null };
        r.entry = "route";
        r.nextApi = next.scope;
      } else if (next.kind === "api" && !next.app && r.defaultExport) {
        r.route = { method: "ANY", path: next.path, auth: null };
        r.entry = "route";
        r.nextApi = next.scope;
      } else if (next.kind === "page" && r.defaultExport) {
        r.route = { method: "PAGE", path: next.path, auth: null };
        r.entry = "route";
        r.nextPage = next.scope;
      } else if (next.kind === "layout" && r.defaultExport) r.entry = "handler";
    }
  }
  if (/(^|\/)middleware\.[tj]s$/.test(file)) fileRecs.filter((r) => r.defaultExport || r.name === "middleware").forEach((r) => (r.entry = "handler"));
  if (/\.config\.[cm]?[jt]s$/.test(file) || /(^|\/)(next|tailwind|postcss|vite|jest|vitest|eslint|playwright)\.config/.test(file)) fileRecs.forEach((r) => (r.entry = r.entry ?? "handler"));
}

// ------------------------------------------------------------------ phase 2 : résolution
function pkgFromPath(f: string): string | null {
  const i = f.lastIndexOf("node_modules");
  if (i < 0) return null;
  const p = f.slice(i + "node_modules/".length).split(/[\\/]/);
  if (p[0] === "@types") return p[1] ?? null;
  return p[0].startsWith("@") ? p.slice(0, 2).join("/") : p[0];
}

function importSpec(d: ts.Node): string | null {
  let n: ts.Node | undefined = d;
  while (n && !ts.isImportDeclaration(n) && !ts.isImportEqualsDeclaration(n) && !ts.isExportDeclaration(n)) n = n.parent;
  if (!n) return null;
  if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
  const r = n.moduleReference;
  return ts.isExternalModuleReference(r) && ts.isStringLiteral(r.expression) ? r.expression.text : null;
}

function resolve(S: State, C: ts.TypeChecker, sym: ts.Symbol | undefined): Target | null {
  if (!sym) return null;
  let s = sym;
  let spec: string | null = null;
  if (s.flags & ts.SymbolFlags.Alias) {
    const d0 = s.declarations?.[0];
    spec = d0 ? importSpec(d0) : null;
    let al: ts.Symbol | undefined;
    try {
      al = C.getAliasedSymbol(s);
    } catch {
      /* ignoré */
    }
    if (al && al.declarations && al.declarations.length) s = al;
    else return spec ? { ext: pkgName(spec) } : null;
  }
  for (const d of s.declarations ?? []) {
    const sfd = d.getSourceFile();
    if (/[\\/]node_modules[\\/]/.test(sfd.fileName)) return { ext: spec ? pkgName(spec) : pkgFromPath(sfd.fileName) ?? undefined };
    if (sfd.isDeclarationFile) return { lib: true };
    const r = S.recByKey.get(keyOf(S, d));
    if (r) return { rec: r };
    if (ts.isMethodSignature(d) || (ts.isMethodDeclaration(d) && !d.body)) {
      const mname = d.name.getText();
      const impls = (S.implsByIface.get(keyOf(S, d.parent)) ?? []).map((c) => S.byId.get(`fn:${c.mod}:${c.name}.${mname}`)).filter((x): x is Rec => !!x);
      if (impls.length) return { decl: d, impls };
    }
    if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
      const ctor = S.recByKey.get(S.ctorKey.get(keyOf(S, d)) ?? "");
      return { cls: keyOf(S, d), decl: d, rec: ctor };
    }
  }
  return { decl: s.declarations?.[0] };
}

class Resolver {
  memo = new Map<string, string | null>();
  constructor(private S: State, private C: ts.TypeChecker) {}

  sym(n: ts.Node): ts.Symbol | undefined {
    try {
      return this.C.getSymbolAtLocation(n);
    } catch {
      return undefined;
    }
  }

  declInfra(d: ts.Node | undefined): string | null {
    if (!d) return null;
    const k = keyOf(this.S, d);
    if (this.memo.has(k)) return this.memo.get(k) ?? null;
    this.memo.set(k, null);
    let r: string | null = null;
    const any = d as any;
    if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isParameter(d) || ts.isPropertyAssignment(d)) {
      if (any.initializer) r = this.exprInfra(any.initializer);
      if (!r && any.type) r = this.typeInfra(any.type);
      if (!r && ts.isPropertyDeclaration(d)) {
        const cls = d.parent;
        const mod = this.S.fileToMod.get(d.getSourceFile().fileName);
        void cls;
        const as = mod ? this.S.thisAssigns.get(`${mod.name}:${d.name.getText()}`) : undefined;
        for (const e of as ?? []) {
          r = this.exprInfra(e);
          if (r) break;
        }
      }
    } else if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) { r = this.exprInfra(t.expression); if (r) break; }
    }
    this.memo.set(k, r);
    return r;
  }

  typeInfra(t: ts.TypeNode): string | null {
    if (!ts.isTypeReferenceNode(t)) return null;
    let n: ts.EntityName = t.typeName;
    while (ts.isQualifiedName(n)) n = n.left;
    const tg = resolve(this.S, this.C, this.sym(n));
    if (!tg) return null;
    if (tg.ext) return infraForPackage(tg.ext);
    return tg.decl ? this.declInfra(tg.decl) : null;
  }

  exprInfra(e: ts.Node): string | null {
    e = unwrap(e);
    if (ts.isNewExpression(e) || ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c) && c.text === "require" && e.arguments?.[0]) return infraForPackage(pkgName(strOf(e.arguments[0]) ?? ""));
      return this.chainInfra(c);
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return this.chainInfra(e);
    return null;
  }

  chainInfra(e: ts.Node): string | null {
    const props: ts.PropertyAccessExpression[] = [];
    let cur: ts.Node = e;
    for (;;) {
      cur = unwrap(cur);
      if (ts.isPropertyAccessExpression(cur)) { props.push(cur); cur = cur.expression; }
      else if (ts.isElementAccessExpression(cur) || ts.isCallExpression(cur)) cur = cur.expression;
      else break;
    }
    for (const p of props.reverse()) {
      const t = resolve(this.S, this.C, this.sym(p.name));
      if (!t) continue;
      if (t.ext) return infraForPackage(t.ext);
      const r = t.decl ? this.declInfra(t.decl) : null;
      if (r) return r;
    }
    if (ts.isIdentifier(cur)) {
      const t = resolve(this.S, this.C, this.sym(cur));
      if (t?.ext) return infraForPackage(t.ext);
      if (t?.decl) return this.declInfra(t.decl);
      if (cur.text === "fetch" && !t?.rec) return "http";
    }
    return null;
  }
}

function addEdge(S: State, src: string, tgt: string, kind: "call" | "ref" | "async" | "uses", certain: boolean, label: string | null = null) {
  if (src === tgt) return;
  const key = `${src}>${tgt}>${kind === "async" ? "a" : kind === "uses" ? "u" : "c"}`;
  const e = S.edges.get(key);
  if (!e) S.edges.set(key, { source: src, target: tgt, kind, certain, count: 1, label });
  else {
    e.count++;
    if (kind === "call") e.kind = "call";
  }
}

function resolveGroup(S: State, C: ts.TypeChecker, mods: Mod[]) {
  const R = new Resolver(S, C);
  const fset = new Set(mods.map((m) => m.file));
  const recs = S.recs.filter((r) => fset.has(r.file)).concat(mods.map((m) => m.top));
  for (const r of recs) {
    for (const call of r.calls) {
      const callee = call.expression;
      let sym: ts.Symbol | undefined;
      const c = unwrap(callee);
      if (ts.isPropertyAccessExpression(c)) sym = R.sym(c.name);
      else if (ts.isIdentifier(c)) sym = R.sym(c);
      const tg = resolve(S, C, sym);
      if (tg?.rec) addEdge(S, r.id, tg.rec.id, "call", true);
      else if (tg?.impls) for (const im of tg.impls) addEdge(S, r.id, im.id, "call", false, "DI");
      let infra: string | null = null;
      if (!tg?.rec) infra = R.exprInfra(call);
      if (infra === "http") {
        // on ne compte que fetch() et les appels directs au client (axios.get), pas res.json()
        let root: ts.Node = c;
        while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root) || ts.isNonNullExpression(root)) root = (root as any).expression;
        const rt = ts.isIdentifier(root) ? resolve(S, C, R.sym(root)) : null;
        if (!(ts.isIdentifier(c) && (c.text === "fetch" || c.text === "$fetch")) && !rt?.ext) infra = null;
      }
      if (infra) {
        const op = ts.isPropertyAccessExpression(c) ? c.name.text : ts.isNewExpression(call) ? "new" : c.getText(r.sf).slice(0, 20);
        const key = `${r.id}|${infra}`;
        const m = S.infraOps.get(key) ?? new Map<string, number>();
        m.set(op, (m.get(op) ?? 0) + 1);
        S.infraOps.set(key, m);
      }
      // usage d'un modèle Prisma : prisma.user.findMany()
      const chain = c.getText(r.sf).split(/[.\[\]?!]+/);
      for (const seg of chain) S.prismaUse.get(seg) && S.prismaUse.get(seg)!.add(r.id);
    }
    for (const id of r.ids) {
      if (!S.knownNames.has(id.text)) continue;
      const tg = resolve(S, C, R.sym(id));
      if (tg?.rec) addEdge(S, r.id, tg.rec.id, "ref", true);
      if (tg?.decl || tg?.cls) {
        const k = tg.cls ?? keyOf(S, tg.decl!);
        const mu = S.modelByKey.get(k);
        if (mu) mu.add(r.id);
      }
    }
  }
}

// ------------------------------------------------------------------ session (analyse incrémentale)
export interface Session {
  sf: Map<string, { mtime: number; sf: ts.SourceFile }>;
  programs: Map<string, ts.Program>;
  hits: number;
  misses: number;
  projectFiles: Set<string>;
}

export const newSession = (): Session => ({ sf: new Map(), programs: new Map(), hits: 0, misses: 0, projectFiles: new Set() });

/** Hôte du compilateur qui réutilise les SourceFile inchangés (bibliothèques lib.d.ts comprises). */
function makeHost(options: ts.CompilerOptions, session: Session): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, langOrOpts, onError, shouldCreate) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(fileName).mtimeMs;
    } catch {
      /* fichier virtuel */
    }
    const lang = typeof langOrOpts === "object" ? langOrOpts.languageVersion : langOrOpts;
    const key = `${fileName}|${lang}`;
    const c = session.sf.get(key);
    const mine = session.projectFiles.has(fileName);
    if (c && c.mtime === mtime) {
      if (mine) session.hits++;
      return c.sf;
    }
    const sf = orig(fileName, langOrOpts, onError, shouldCreate);
    if (sf) session.sf.set(key, { mtime, sf });
    if (mine) session.misses++;
    return sf;
  };
  return host;
}

// ------------------------------------------------------------------ main
export function analyze(rootArg: string, extraExclude: string[] = [], session: Session = newSession()) {
  const t0 = Date.now();
  const root = path.resolve(rootArg);
  const exclude = new Set(extraExclude);
  const files = discover(root, exclude);
  const S: State = {
    root, files: new Set(files), recs: [], byId: new Map(), recByKey: new Map(), ctorKey: new Map(), modules: new Map(), fileToMod: new Map(),
    issues: [], edges: new Map(), infraOps: new Map(), infraLibs: new Map(), thisAssigns: new Map(), pendingRoutes: [], pendingWorkers: [],
    varDecls: [], classDecls: [], implsByIface: new Map(), providers: [], knownNames: new Set(), modelByKey: new Map(), prismaUse: new Map(), programs: [],
  };
  session.hits = 0;
  session.misses = 0;
  session.projectFiles = S.files;
  if (files.length === 0) return finalize(S, [], t0);
  const groups = makeGroups(root, files, findConfigs(root, exclude));
  // phase 1
  for (const g of groups) {
    const gkey = `${root}|${g.dir}`;
    const program = ts.createProgram({ rootNames: g.files, options: g.options, host: makeHost(g.options, session), oldProgram: session.programs.get(gkey) });
    session.programs.set(gkey, program);
    const C = program.getTypeChecker();
    const cache = ts.createModuleResolutionCache(g.dir, (s) => s, g.options);
    S.programs.push({ program, C, files: g.files });
    for (const f of g.files) {
      const sf = program.getSourceFile(f);
      if (sf && !S.fileToMod.has(sf.fileName)) collectFile(S, sf, g.options, cache, C);
    }
  }
  // constructeurs de classes
  for (const r of S.recs) if (r.qual.endsWith(".constructor") && r.node) S.ctorKey.set(keyOf(S, (r.node as ts.Node).parent), keyOf(S, r.node as ts.Node));
  for (const r of S.recs) {
    S.knownNames.add(r.name);
    S.knownNames.add(r.qual.split(".")[0]);
  }
  const models = buildModels(S, root);
  for (const m of models.list) S.knownNames.add(m.name);
  // implémentations d'interfaces / classes de base (injection de dépendances)
  const declKeyOf = (C: ts.TypeChecker, n: ts.Node): string | null => {
    let sym: ts.Symbol | undefined;
    try {
      sym = C.getSymbolAtLocation(n);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = C.getAliasedSymbol(sym);
    } catch {
      return null;
    }
    const d = sym?.declarations?.[0];
    return d && !d.getSourceFile().isDeclarationFile ? keyOf(S, d) : null;
  };
  const addImpl = (ifaceKey: string | null, mod: string, name: string | undefined) => {
    if (!ifaceKey || !name) return;
    const list = S.implsByIface.get(ifaceKey) ?? S.implsByIface.set(ifaceKey, []).get(ifaceKey)!;
    if (!list.some((x) => x.mod === mod && x.name === name)) list.push({ mod, name });
  };
  for (const c of S.classDecls) {
    for (const hc of c.node.heritageClauses ?? []) for (const ty of hc.types) addImpl(declKeyOf(c.C, ty.expression), c.mod, c.node.name?.text);
  }
  for (const pv of S.providers) {
    const target = (S.classDecls.find((c) => declKeyOf(c.C, pv.useClass) === keyOf(S, c.node)));
    if (target) addImpl(declKeyOf(pv.C, pv.provide), target.mod, target.node.name?.text);
  }
  // phase 2
  for (const p of S.programs) {
    const mods = [...S.modules.values()].filter((m) => p.files.some((f) => norm(path.relative(root, f)) === m.file));
    resolveGroup(S, p.C, mods);
  }
  // routes / workers déclarés par référence (app.get("/x", handler))
  for (const pr of S.pendingRoutes) {
    const R = new Resolver(S, pr.C);
    const n = pr.node as ts.Identifier | ts.PropertyAccessExpression;
    const tg = resolve(S, pr.C, R.sym(ts.isPropertyAccessExpression(n) ? n.name : n));
    if (tg?.rec && !tg.rec.route) {
      tg.rec.route = { method: pr.method, path: pr.path, auth: null };
      tg.rec.entry = "route";
      if (pr.auth) tg.rec.auth = true;
    }
  }
  for (const pw of S.pendingWorkers) {
    const R = new Resolver(S, pw.C);
    const n = pw.node;
    const tg = resolve(S, pw.C, R.sym(ts.isPropertyAccessExpression(n) ? n.name : n));
    if (tg?.rec && !tg.rec.worker) {
      tg.rec.worker = { lib: pw.lib, queue: pw.lib };
      tg.rec.entry = "worker";
    }
  }
  const out: any = finalize(S, models.list, t0, models);
  out.metrics.parsed = session.misses;
  out.metrics.cached = session.hits;
  return out;
}

function serve() {
  const session = newSession();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const result = analyze(req.root, req.exclude ?? [], session);
      process.stdout.write(JSON.stringify({ id: req.id, result }) + "\n");
    } catch (e: any) {
      process.stdout.write(JSON.stringify({ id: req.id, error: String(e?.stack ?? e) }) + "\n");
    }
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--server")) return serve();
  const root = argv[0];
  const exclude: string[] = [];
  let out: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--exclude") exclude.push(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
  }
  if (!root) {
    console.error("Usage : analyze_ts <racine> [--exclude dossier] [--out fichier]");
    process.exit(2);
  }
  const result = analyze(root, exclude);
  const json = JSON.stringify(result);
  if (out) fs.writeFileSync(out, json, "utf8");
  else process.stdout.write(json);
}

if (require.main === module) main();
void QUEUE_IDS; void STRICT_LAYERS; void WRITE_METHODS; void VERSION; void INFRA;
export type { ModelOut };
