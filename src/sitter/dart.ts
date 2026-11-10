/* Extracteur Dart / Flutter. Aucune grammaire tree-sitter Dart précompilée n'existe pour WebAssembly :
 * on utilise un analyseur lexical léger (commentaires, chaînes, accolades) puis des motifs sur le code nettoyé. */
import { Def, FileInfo, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, urlOfText } from "./common";

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "assert", "throw", "super", "this", "await", "yield", "in", "else", "do", "try", "new", "const", "final", "var", "late", "void", "case", "default", "is", "as", "print"]);
const WIDGET_BASES = /^(StatelessWidget|StatefulWidget|State|ConsumerWidget|ConsumerStatefulWidget|ConsumerState|HookWidget|HookConsumerWidget|GetView|GetWidget|InheritedWidget|Widget)$/;
const LIFECYCLE = new Set(["build", "initState", "dispose", "didChangeDependencies", "didUpdateWidget", "createState", "deactivate", "reassemble", "didChangeAppLifecycleState"]);
// classe -> [id d'infra, fragment de paquet attendu dans les imports]
const CLASS_INFRA: Record<string, [string, string]> = {
  Dio: ["http", "dio"], FirebaseFirestore: ["firebase", "firebase"], FirebaseAuth: ["firebase", "firebase"], FirebaseStorage: ["firebase", "firebase"],
  FirebaseMessaging: ["firebase", "firebase"], FirebaseDatabase: ["firebase", "firebase"], FirebaseFunctions: ["firebase", "firebase"], Database: ["sqlite", "sqflite"],
  SupabaseClient: ["supabase", "supabase"], Supabase: ["supabase", "supabase"], Hive: ["kv", "hive"], Box: ["kv", "hive"], SharedPreferences: ["kv", "shared_preferences"],
  Isar: ["kv", "isar"], GetStorage: ["kv", "get_storage"], FlutterSecureStorage: ["kv", "flutter_secure_storage"], WebSocketChannel: ["websocket", "web_socket"],
};

function scan(src: string): { code: string; clean: string; depth: Int32Array; close: Map<number, number> } {
  const n = src.length;
  const code = src.split("");
  const clean = src.split("");
  const depth = new Int32Array(n + 1);
  const close = new Map<number, number>();
  const stack: number[] = [];
  let d = 0;
  const blank = (arr: string[], a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (arr[k] !== "\n") arr[k] = " ";
  };
  const skipInterp = (j: number): number => {
    let dd = 1;
    while (j < n && dd > 0) {
      const c = src[j];
      if (c === "'" || c === '"') {
        j = skipString(j);
        continue;
      }
      if (c === "{") dd++;
      else if (c === "}") dd--;
      j++;
    }
    return j;
  };
  const skipString = (i: number): number => {
    const q = src[i];
    const raw = i > 0 && src[i - 1] === "r";
    const triple = src.startsWith(q.repeat(3), i);
    let j = i + (triple ? 3 : 1);
    while (j < n) {
      const c = src[j];
      if (!raw && c === "\\") {
        j += 2;
        continue;
      }
      if (!raw && c === "$" && src[j + 1] === "{") {
        j = skipInterp(j + 2);
        continue;
      }
      if (triple ? src.startsWith(q.repeat(3), j) : c === q) return j + (triple ? 3 : 1);
      if (!triple && c === "\n") return j;
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    depth[i] = d;
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      blank(code, i, j);
      blank(clean, i, j);
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      let nest = 1;
      while (j < n && nest > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { nest++; j += 2; }
        else if (src[j] === "*" && src[j + 1] === "/") { nest--; j += 2; }
        else j++;
      }
      blank(code, i, j);
      blank(clean, i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const j = skipString(i);
      blank(code, i + 1, j - 1);
      for (let k = i; k < j && k <= n; k++) depth[k] = d;
      i = j;
      continue;
    }
    if (c === "{") {
      stack.push(i);
      d++;
    } else if (c === "}") {
      d = Math.max(0, d - 1);
      const o = stack.pop();
      if (o !== undefined) close.set(o, i);
      depth[i] = d;
    }
    i++;
  }
  depth[n] = d;
  return { code: code.join(""), clean: clean.join(""), depth, close };
}

interface Stmt {
  start: number;
  end: number;
  head: string; // texte jusqu'au premier « { » ou « => »
  bodyStart: number; // -1 si pas de corps
  bodyEnd: number;
}

function statements(code: string, from: number, to: number): Stmt[] {
  const out: Stmt[] = [];
  let i = from;
  while (i < to) {
    while (i < to && /\s/.test(code[i])) i++;
    if (i >= to) break;
    const start = i;
    let paren = 0;
    let bodyStart = -1;
    let bodyEnd = -1;
    let end = to;
    let head = "";
    while (i < to) {
      const c = code[i];
      if (c === "(" || c === "[") paren++;
      else if (c === ")" || c === "]") paren--;
      else if (paren <= 0 && c === "=" && code[i + 1] === ">" && bodyStart < 0) {
        head = code.slice(start, i);
        bodyStart = i + 2;
        let j = i + 2;
        let p = 0;
        while (j < to) {
          if ("([{".includes(code[j])) p++;
          else if (")]}".includes(code[j])) p--;
          else if (code[j] === ";" && p <= 0) break;
          j++;
        }
        bodyEnd = j;
        end = Math.min(to, j + 1);
        i = end;
        break;
      } else if (paren <= 0 && c === "{") {
        // fin de bloc : on cherche l'accolade fermante correspondante
        let depth = 0;
        let j = i;
        for (; j < to; j++) {
          if (code[j] === "{") depth++;
          else if (code[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (bodyStart < 0) {
          head = code.slice(start, i);
          bodyStart = i + 1;
          bodyEnd = j;
        }
        let k = j + 1;
        while (k < to && /\s/.test(code[k])) k++;
        if (k < to && /[;),.]/.test(code[k]) && code[k] === ";") {
          end = k + 1;
          i = end;
          break;
        }
        end = j + 1;
        i = end;
        break;
      } else if (paren <= 0 && c === ";") {
        end = i + 1;
        if (bodyStart < 0) head = code.slice(start, i);
        i = end;
        break;
      }
      i++;
    }
    if (bodyStart < 0 && !head) head = code.slice(start, Math.min(end, to));
    out.push({ start, end, head, bodyStart, bodyEnd });
  }
  return out;
}

const simpleType = (t: string | undefined): TypeRef | null => {
  if (!t) return null;
  const m = /^\s*([A-Za-z_]\w*)/.exec(t.replace(/^(final|const|late|static)\s+/g, ""));
  if (!m || /^(void|var|dynamic|int|double|num|bool|String|List|Map|Set|Future|Stream|Object)$/.test(m[1])) return null;
  return { name: m[1] };
};

export function extractDart(src: string, rel: string): FileInfo {
  const { code, clean, depth, close } = scan(src);
  const lineOf = (pos: number) => src.slice(0, pos).split("\n").length;
  const info: FileInfo = {
    rel, lang: "dart", pkgKey: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".", imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, securityConfig: false, routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issueAt = (def: string | null, pos: number, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: lineOf(pos), severity, category, rule, message, level, params });

  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"](?:\s+as\s+(\w+))?/gm)) {
    const p = m[1];
    info.importPaths.push(p);
    info.imports.set(m[2] ?? p.split("/").pop()!.replace(/\.dart$/, ""), p);
  }
  const hasPkg = (frag: string) => info.importPaths.some((p) => p.includes(frag));

  const analyzeBody = (def: Def, a: number, b: number, vars: Map<string, TypeRef>, cname: string | null) => {
    const body = code.slice(a, b);
    const bodyClean = clean.slice(a, b);
    // variables locales typées
    for (const m of body.matchAll(/\b(?:final|var|const|late)?\s*([A-Z]\w*)\??\s+(\w+)\s*(?:=|;)/g)) vars.set(m[2], { name: m[1] });
    for (const m of body.matchAll(/\b(?:final|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:const\s+)?([A-Z]\w*)\s*(?:\.\w+)?\s*\(/g)) if (!vars.has(m[1])) vars.set(m[1], { name: m[2] });
    for (const m of body.matchAll(/(?<![\w$.])((?:[A-Za-z_]\w*)(?:\s*[?!]?\.\s*[A-Za-z_]\w*)*)\s*(?:<[^<>()]*>)?\(/g)) {
      const parts = m[1].split(/\s*[?!]?\.\s*/);
      const name = parts.pop()!;
      if (parts.length === 0 && KEYWORDS.has(name)) continue;
      const line = lineOf(a + m.index!);
      if (parts.length === 0) {
        if (/^[A-Z]/.test(name)) def.calls.push({ name: "<init>", line, plain: false, root: { name }, chain: [], ctor: true });
        else def.calls.push({ name, line, plain: true });
        def.callees.push(name);
        continue;
      }
      const rootName = parts[0];
      const chain = parts.slice(1);
      const call: Def["calls"][number] = { name, line, plain: false, chain };
      if (info.imports.has(rootName) && !vars.has(rootName)) {
        call.pkg = rootName;
      } else if (rootName === "this") {
        if (cname) call.root = { name: cname };
      } else if (vars.has(rootName)) call.root = vars.get(rootName)!;
      else if (/^[A-Z]/.test(rootName)) {
        call.root = { name: rootName };
        if (chain.length === 0 && /^[a-z]/.test(name) === false) call.ctor = false;
      }
      def.calls.push(call);
      def.callees.push(name);
      // infrastructure connue par le nom de classe / de variable
      const tname = call.root?.name ?? rootName;
      const known = CLASS_INFRA[tname] ?? CLASS_INFRA[(vars.get(rootName)?.name ?? "")];
      if (known && hasPkg(known[1])) (def.infra ??= []).push({ id: known[0], lib: info.importPaths.find((p) => p.includes(known[1])) ?? known[1], op: name });
      else if (/^_?(dio|client|http)$/i.test(rootName) && (hasPkg("package:dio") || hasPkg("package:http"))) (def.infra ??= []).push({ id: "http", lib: info.importPaths.find((p) => p.includes("dio") || p.includes("package:http")) ?? "http", op: name });
      else if (info.imports.get(rootName)?.includes("package:http")) (def.infra ??= []).push({ id: "http", lib: "package:http", op: name });
    }
    // références de fonctions passées en argument
    for (const m of body.matchAll(/(?:onPressed|onTap|onChanged|onSubmitted|builder|create|onGenerateRoute)\s*:\s*(_?\w+)\s*[,)]/g)) def.refs.push(m[1]);
    // appels HTTP sortants
    for (const m of bodyClean.matchAll(/\b_?(?:http|dio|client|_dio|_client|api)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(?:Uri\.parse\(\s*)?(['"])([^'"]+)\2/gi)) {
      const url = urlOfText(m[3].replace(/\$\{[^}]*\}|\$\w+/g, "{}"));
      if (url) def.http.push({ method: m[1].toUpperCase(), url, line: lineOf(a + m.index!) });
    }
    // sécurité
    for (const m of bodyClean.matchAll(/\b(\w*(?:password|secret|token|apiKey|api_key|privateKey)\w*)\s*=\s*(['"])([^'"$]{6,})\2/gi)) {
      if (SECRET_RE.test(m[1]) && !SECRET_EXCLUDE.test(m[1]) && !m[3].includes("://")) issueAt(def.qual, a + m.index!, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${m[1]} »`, "medium", { name: m[1] });
    }
    for (const m of body.matchAll(/badCertificateCallback\s*=\s*\([^)]*\)\s*=>\s*true/g)) issueAt(def.qual, a + m.index!, "warning", "security", "tls-verify-off", "Vérification TLS désactivée", "medium");
    for (const m of body.matchAll(/\b(md5|sha1)\s*\.\s*convert\b/g)) issueAt(def.qual, a + m.index!, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: m[1] });
    for (const m of bodyClean.matchAll(/\.(rawQuery|rawInsert|rawUpdate|rawDelete|execute)\s*\(\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const lit = m[2] ?? m[3] ?? "";
      if (/\$\w|\$\{/.test(lit) && SQL_RE.test(lit)) issueAt(def.qual, a + m.index!, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
    }
    const sts = (body.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?\s[^?:]+:|\?\?/g) ?? []).length;
    def.complexity = 1 + sts;
    def.nstmts = (body.match(/;/g) ?? []).length;
    def.toks = (body.match(/[A-Za-z_]\w*|[{}()=;.+\-*/<>!?:]/g) ?? []).map((t) => hashTok(t));
  };

  const hashTok = (t: string): number => {
    let h = 7;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return /^[A-Za-z_]/.test(t) && !KEYWORDS.has(t) && !/^[A-Z]/.test(t) ? 1 : h % 997;
  };

  const FN = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:static|external|abstract|factory|override)\s+)*(?:([A-Za-z_][\w<>?,.\[\] ]*?)\s+)?(?:(get|set)\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:<[^()]*>)?\s*\(([\s\S]*)\)\s*(?:async\*?|sync\*|async)?\s*(?::[\s\S]*)?$/;
  const GETTER = /^(?:@\w+\s*)*(?:(?:static|override)\s+)*(?:[\w<>?,.\[\] ]+?\s+)?get\s+(\w+)\s*(?:async\*?)?\s*$/;
  const FIELD = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:static|final|const|late|var)\s+)*([A-Za-z_][\w<>?,.\[\] ]*?)\s+(\w+)\s*(?:=[\s\S]*)?$/;

  const handleMember = (st: Stmt, cname: string | null, fields: Map<string, TypeRef>, t: TypeInfo | null, isWidget: boolean) => {
    const head = st.head.replace(/\s+/g, " ").trim();
    if (!head) return;
    const g = GETTER.exec(head);
    const f = g ? null : FN.exec(head);
    if (!g && !f) {
      if (t) {
        const fm = FIELD.exec(head);
        if (fm && !/\(/.test(head.split("=")[0])) {
          const ty = simpleType(fm[1]);
          if (ty && !/^(return|import|export|part|library)$/.test(fm[1])) t.fields.set(fm[2], ty);
          t.fieldList.push({ name: fm[2], type: fm[1].trim(), default: null });
          const sv = /=\s*(['"])([^'"$]{6,})\1/.exec(clean.slice(st.start, st.end));
          if (sv && SECRET_RE.test(fm[2]) && !SECRET_EXCLUDE.test(fm[2]) && !sv[2].includes("://")) issueAt(null, st.start, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${fm[2]} »`, "medium", { name: fm[2] });
        }
      }
      return;
    }
    const name = g ? g[1] : f![3];
    if (!g && cname === null && KEYWORDS.has(name)) return;
    if (!g && /^(if|for|while|switch|catch)$/.test(name)) return;
    const isCtor = !!cname && (name === cname || name.startsWith(cname + "."));
    const params: string[] = [];
    const vars = new Map<string, TypeRef>(fields);
    if (f && f[4]) {
      for (const p of f[4].split(",")) {
        const pm = /(?:this\.)?(\w+)\s*(?:=.*)?$/.exec(p.replace(/[{}\[\]]/g, "").trim());
        const tm = /^(?:required\s+)?(?:final\s+)?([A-Z]\w*)\??\s+(\w+)/.exec(p.replace(/[{}\[\]]/g, "").trim());
        if (pm) params.push(pm[1]);
        if (tm) vars.set(tm[2], { name: tm[1] });
      }
    }
    if (isWidget && cname) vars.set("widget", { name: t?.bases.find((b) => !WIDGET_BASES.test(b)) ?? cname });
    const def = mkDef({
      qual: cname ? `${cname}.${isCtor ? "<init>" : name}` : name, name: isCtor ? "<init>" : name, recvType: cname ?? undefined, line: lineOf(st.start), end: lineOf(st.end),
      exported: !name.startsWith("_"), params, iface: st.bodyStart < 0 && !isCtor,
    });
    if (st.bodyStart >= 0) analyzeBody(def, st.bodyStart, st.bodyEnd, vars, cname);
    else if (isCtor) def.complexity = 1;
    if (!cname && name === "main") def.entry = "main";
    if (isWidget && LIFECYCLE.has(name)) {
      def.entry = "handler";
      if (name === "build") def.tag = "component";
    }
    if (/@override/.test(src.slice(Math.max(0, st.start - 40), st.start))) def.annotations.push("override");
    info.defs.push(def);
  };

  const CLASS = /^(?:(?:abstract|final|base|sealed|interface)\s+)*(class|mixin|enum|extension)\s+(\w+)\s*(?:<[\s\S]*?>)?\s*([\s\S]*)$/;
  const topStmts = statements(code, 0, code.length);
  for (const st of topStmts) {
    const head = st.head.replace(/\s+/g, " ").trim();
    const cm = CLASS.exec(head.replace(/^@\w+(?:\([^)]*\))?\s*/g, ""));
    if (cm && st.bodyStart >= 0 && /^(class|mixin|enum)$/.test(cm[1])) {
      const name = cm[2];
      const tail = cm[3] ?? "";
      const bases: string[] = [];
      for (const m of tail.matchAll(/\b(?:extends|with|implements|on)\s+([^{]+?)(?=\s+(?:extends|with|implements|on)\b|$)/g)) for (const b of m[1].split(",")) {
        const nm = /([A-Za-z_]\w*)/.exec(b.trim())?.[1];
        if (nm) bases.push(nm);
      }
      const anns = [...(code.slice(Math.max(0, st.start - 200), st.start).match(/@(\w+)/g) ?? [])].map((a) => a.slice(1));
      const isWidget = bases.some((b) => WIDGET_BASES.test(b));
      const t: TypeInfo = { name, kind: cm[1] === "enum" ? "enum" : "class", fields: new Map(), fieldList: [], bases, annotations: anns, tags: [], line: lineOf(st.start), end: lineOf(st.end), exported: !name.startsWith("_") };
      if (isWidget) t.annotations.push("Widget");
      if (bases.includes("Table")) t.annotations.push("Table");
      info.types.push(t);
      const members = statements(code, st.bodyStart, st.bodyEnd);
      for (const m of members) handleMember(m, name, t.fields, t, isWidget);
      if (info.defs.some((d) => d.recvType === name && /^fromJson$|^toJson$/.test(d.name))) t.annotations.push("FromJson");
      // les constructeurs « this.x » complètent les types des champs déjà déclarés
    } else if (/^(import|export|part|library)\b/.test(head)) {
      continue;
    } else if (st.bodyStart >= 0 || /\(/.test(head)) {
      handleMember(st, null, new Map(), null, false);
    }
  }

  // ---- routes (GoRouter, routes: { '/x': (ctx) => Page() })
  const route = (path: string, at: number, widget: string | undefined, method = "PAGE") => {
    const def = mkDef({ qual: `${method} ${path}`, name: `${method} ${path}`, line: lineOf(at), end: lineOf(at), route: { method, path, auth: null }, entry: "route", exported: true });
    if (widget) {
      def.calls.push({ name: "<init>", line: lineOf(at), plain: false, root: { name: widget }, chain: [], ctor: true });
      def.callees.push(widget);
    }
    info.defs.push(def);
  };
  for (const m of src.matchAll(/GoRoute\s*\(([\s\S]*?)\n\s*\)\s*,?/g)) {
    const path = /path:\s*['"]([^'"]+)['"]/.exec(m[1])?.[1];
    const w = /(?:builder|pageBuilder)\s*:[\s\S]*?=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/.exec(m[1])?.[1];
    if (path) route(path.startsWith("/") ? path : "/" + path, m.index!, w);
  }
  for (const m of clean.matchAll(/(['"])(\/[\w/:\-{}]*)\1\s*:\s*\(\s*\w*\s*\)\s*=>\s*(?:const\s+)?([A-Z]\w*)\s*\(/g)) route(m[2], m.index!, m[3]);
  for (const m of clean.matchAll(/case\s+(['"])(\/[\w/:\-{}]*)\1\s*:[\s\S]{0,120}?(?:builder\s*:[\s\S]{0,60}?=>|return)\s*(?:const\s+)?([A-Z]\w*)\s*\(/g)) route(m[2], m.index!, m[3]);
  // secrets déclarés au niveau du fichier
  for (const m of clean.matchAll(/(?:const|final|var|String)\s+(\w+)\s*=\s*(['"])([^'"$\n]{6,})\2/g)) {
    if (depth[m.index!] === 0 && SECRET_RE.test(m[1]) && !SECRET_EXCLUDE.test(m[1]) && !m[3].includes("://")) issueAt(null, m.index!, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${m[1]} »`, "medium", { name: m[1] });
  }
  void close;
  return info;
}
