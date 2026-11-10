import { Call, Def, FileInfo, Node, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, stats, unquote, urlOfText } from "./common";

const DECISION = new Set(["if_statement", "else_if_clause", "for_statement", "foreach_statement", "while_statement", "do_statement", "case_statement", "catch_clause", "conditional_expression", "match_conditional_expression"]);
const ROUTE_VERBS: Record<string, string> = { get: "GET", post: "POST", put: "PUT", delete: "DELETE", patch: "PATCH", any: "ANY", match: "ANY", options: "OPTIONS" };
const RESOURCE: [string, string, string][] = [["index", "GET", ""], ["store", "POST", ""], ["show", "GET", "/{id}"], ["update", "PUT", "/{id}"], ["destroy", "DELETE", "/{id}"]];
const SQL_CALLS = new Set(["raw", "select", "statement", "unprepared", "query", "exec", "whereRaw", "selectRaw", "mysqli_query", "pg_query"]);
const SHELL_FN = new Set(["exec", "shell_exec", "system", "passthru", "popen", "proc_open"]);
const lastOf = (s: string) => s.split("\\").pop()!;

function nameOf(n: Node | null | undefined): string {
  if (!n) return "";
  if (n.type === "name") return n.text;
  if (n.type === "qualified_name" || n.type === "namespace_name") return n.text.replace(/^\\/, "");
  return n.text;
}

function typeRefOf(n: Node | null | undefined): TypeRef | null {
  if (!n) return null;
  if (n.type === "named_type") return { name: lastOf(n.text.replace(/^\?/, "")) };
  if (n.type === "optional_type") return typeRefOf(n.namedChild(0));
  if (n.type === "name" || n.type === "qualified_name") return { name: lastOf(n.text) };
  return null;
}

export function extractPhp(root: Node, rel: string, src: string): FileInfo {
  const info: FileInfo = {
    rel, lang: "php", pkgKey: "", imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("#")).length, securityConfig: false,
    routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issue = (def: string | null, node: Node, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: node.startPosition.row + 1, severity, category, rule, message, level, params });
  const strVal = (n: Node | null | undefined): string | null => {
    if (!n) return null;
    const s = n.type === "argument" ? n.namedChild(0) : n;
    if (s?.type === "string") return s.text.replace(/^['"]|['"]$/g, "");
    return null;
  };
  const isLiteral = (n: Node | null | undefined) => {
    const s = n?.type === "argument" ? n.namedChild(0) : n;
    return s?.type === "string" || s?.type === "integer";
  };

  const visitTop = (nodes: Node[]) => {
    for (const st of nodes) {
      if (st.type === "namespace_definition") {
        info.pkgKey = nameOf(st.namedChildren.find((c) => c.type === "namespace_name"));
        const b = st.childForFieldName("body");
        if (b) visitTop(b.namedChildren);
      } else if (st.type === "namespace_use_declaration") {
        for (const cl of st.namedChildren.filter((c) => c.type === "namespace_use_clause")) {
          const q = cl.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
          const p = nameOf(q);
          if (!p) continue;
          const alias = cl.namedChildren.find((c) => c.type === "namespace_aliasing_clause")?.namedChildren[0]?.text;
          info.importPaths.push(p);
          info.imports.set(alias ?? lastOf(p), p);
        }
      } else if (st.type === "class_declaration" || st.type === "interface_declaration" || st.type === "trait_declaration") visitClass(st);
      else if (st.type === "function_definition") funcDef(st, null, new Map());
      else if (st.type === "expression_statement" || st.type === "return_statement") topLevelCode(st);
    }
  };

  const attrsOf = (n: Node): { name: string; text: string }[] => {
    const out: { name: string; text: string }[] = [];
    const walkA = (x: Node) => {
      if (x.type === "attribute") out.push({ name: lastOf(x.namedChildren[0]?.text ?? ""), text: x.text });
      else x.namedChildren.forEach(walkA);
    };
    for (const c of n.namedChildren) if (c.type === "attribute_list") walkA(c);
    return out;
  };

  const analyze = (def: Def, body: Node, cls: string | null, vars: Map<string, TypeRef>, prefix: string, authCtx: boolean) => {
    const defKey = def.qual;
    const varName = (v: Node | null | undefined) => (v?.type === "variable_name" ? v.text.replace(/^\$/, "") : null);
    const scan = (n: Node, pre: string, auth: boolean): void => {
      switch (n.type) {
        case "assignment_expression": {
          const l = n.childForFieldName("left");
          const r = n.childForFieldName("right");
          const nm = varName(l);
          if (nm && r) {
            if (r.type === "object_creation_expression") {
              const tn = r.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
              if (tn) vars.set(nm, { name: lastOf(tn.text) });
            }
            const sv = r.type === "string" ? r.text.replace(/^['"]|['"]$/g, "") : null;
            if (sv && sv.length >= 6 && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && !sv.includes("://"))
              issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
          }
          break;
        }
        case "array_element_initializer": {
          const kids = n.namedChildren;
          if (kids.length === 2 && kids[0].type === "string" && kids[1].type === "string") {
            const k = kids[0].text.replace(/^['"]|['"]$/g, "");
            const v = kids[1].text.replace(/^['"]|['"]$/g, "");
            if (SECRET_RE.test(k) && !SECRET_EXCLUDE.test(k) && v.length >= 6 && !v.includes("://") && !/^env\(/.test(v))
              issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${k} »`, "medium", { name: k });
          }
          break;
        }
        case "object_creation_expression": {
          const tn = n.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
          if (tn) {
            def.calls.push({ name: "<init>", line: n.startPosition.row + 1, plain: false, root: { name: lastOf(tn.text) }, chain: [], ctor: true });
            def.callees.push(lastOf(tn.text));
          }
          break;
        }
        case "function_call_expression": {
          handleFnCall(n);
          break;
        }
        case "scoped_call_expression":
        case "member_call_expression": {
          if (handleMethodCall(n, pre, auth)) return;
          break;
        }
      }
      for (const c of n.children) scan(c, pre, auth);
    };

    const handleFnCall = (n: Node) => {
      const fn = n.childForFieldName("function");
      const name = lastOf(fn?.text ?? "");
      const args = n.childForFieldName("arguments")?.namedChildren ?? [];
      const first = args[0];
      const line = n.startPosition.row + 1;
      def.calls.push({ name, line, plain: true });
      def.callees.push(name);
      for (const a of args) {
        const x = a.namedChild(0);
        if (x?.type === "string" && /^['"][A-Za-z_\\]+['"]$/.test(x.text)) def.refs.push(x.text.replace(/['"]/g, ""));
      }
      if (name === "eval") issue(defKey, n, "error", "security", "dangerous-eval", "Exécution dynamique de code (eval)", "high", { fn: "eval" });
      if (SHELL_FN.has(name) && first && !isLiteral(first)) issue(defKey, n, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: name });
      if (name === "unserialize") issue(defKey, n, "warning", "security", "unsafe-deserialization", "Désérialisation non sûre", "medium");
      if (name === "md5" || name === "sha1") issue(defKey, n, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: name });
      if ((name === "mysqli_query" || name === "pg_query") && args[1]) checkSql(args[1], n);
      if (name === "curl_setopt" && /SSL_VERIFYPEER/.test(n.text) && /false|0\s*\)/.test(args[2]?.text ?? "")) issue(defKey, n, "warning", "security", "tls-verify-off", "Vérification TLS désactivée", "medium");
      if (name === "header" && /Access-Control-Allow-Origin:\s*\*/i.test(first?.text ?? "")) issue(defKey, n, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");
      if ((name === "file_get_contents" || name === "curl_init") && first) {
        const url = urlOfText(first.text);
        if (url) def.http.push({ method: "GET", url, line });
      }
    };

    const checkSql = (arg: Node, at: Node) => {
      const x = arg.type === "argument" ? arg.namedChild(0) : arg;
      if (!x) return;
      const dyn = (x.type === "encapsed_string" && x.namedChildren.some((c) => c.type === "variable_name" || c.type === "member_access_expression")) || (x.type === "binary_expression" && x.childForFieldName("operator")?.text === ".");
      if (dyn && SQL_RE.test(x.text)) issue(defKey, at, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
    };

    const chainInfo = (obj: Node | null): { prefix: string; auth: boolean } => {
      let prefix = "";
      let auth = false;
      let cur: Node | null = obj;
      const prefixes: string[] = [];
      while (cur) {
        if (cur.type === "member_call_expression" || cur.type === "scoped_call_expression") {
          const nm = cur.childForFieldName("name")?.text;
          const args = cur.childForFieldName("arguments")?.namedChildren ?? [];
          if (nm === "prefix") prefixes.unshift(strVal(args[0]) ?? "");
          if (nm === "middleware" && /auth|sanctum|jwt|passport/i.test(cur.childForFieldName("arguments")?.text ?? "")) auth = true;
          cur = cur.type === "member_call_expression" ? cur.childForFieldName("object") : null;
        } else break;
      }
      prefix = prefixes.map((p) => "/" + p.replace(/^\/|\/$/g, "")).join("");
      return { prefix, auth };
    };

    const handleMethodCall = (n: Node, pre: string, auth: boolean): boolean => {
      const name = n.childForFieldName("name")?.text ?? "";
      const args = n.childForFieldName("arguments")?.namedChildren ?? [];
      const line = n.startPosition.row + 1;
      const call: Call = { name, line, plain: false };
      let scopeName = "";
      if (n.type === "scoped_call_expression") {
        scopeName = nameOf(n.childForFieldName("scope"));
        if (scopeName === "self" || scopeName === "static") scopeName = cls ?? "";
        if (scopeName === "parent") scopeName = "";
        if (scopeName) {
          call.root = { name: lastOf(scopeName) };
          call.chain = [];
        }
      } else {
        const chain: string[] = [];
        let cur: Node | null = n.childForFieldName("object");
        while (cur && cur.type === "member_access_expression") {
          chain.unshift(cur.childForFieldName("name")?.text ?? "");
          cur = cur.childForFieldName("object");
        }
        const v = varName(cur);
        call.chain = chain;
        if (v === "this" && cls) call.root = { name: cls };
        else if (v) call.root = vars.get(v) ?? null;
      }
      def.calls.push(call);
      def.callees.push(name);
      const first = args[0];
      // ---- routes Laravel
      if (n.type === "scoped_call_expression" && scopeName === "Route" || (n.type === "member_call_expression" && (name === "group" || ROUTE_VERBS[name]) && /Route::/.test(n.childForFieldName("object")?.text ?? ""))) {
        if (name === "group") {
          const ci = chainInfo(n.childForFieldName("object"));
          const closure = args.map((a) => a.namedChild(0)).find((x) => x && /function|arrow/.test(x.type));
          if (closure) scan(closure, pre + ci.prefix, auth || ci.auth);
          return true;
        }
        const verb = ROUTE_VERBS[name];
        const ci = n.type === "member_call_expression" ? chainInfo(n.childForFieldName("object")) : { prefix: "", auth: false };
        if (verb && first && strVal(first) !== null) {
          const path = ("/" + [pre, ci.prefix, strVal(first)!].join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
          const h = args[args.length > 1 ? args.length - 1 : 1]?.namedChild(0);
          const a = auth || ci.auth;
          if (h?.type === "array_creation_expression") {
            const els = h.namedChildren.map((e) => e.namedChild(0));
            const clsName = els[0]?.text.replace(/::class$/, "");
            const meth = strVal(els[1]);
            if (clsName && meth) info.routeRefs.push({ def: defKey, method: verb, path, handler: `${lastOf(clsName)}.${meth}`, auth: a, recvType: lastOf(clsName) });
          } else if (h?.type === "string" && h.text.includes("@")) {
            const [c, m] = h.text.replace(/^['"]|['"]$/g, "").split("@");
            info.routeRefs.push({ def: defKey, method: verb, path, handler: `${lastOf(c)}.${m}`, auth: a, recvType: lastOf(c) });
          } else if (h && /function|arrow/.test(h.type)) {
            const inline = mkDef({ qual: `${verb} ${path}`, name: `${verb} ${path}`, line: h.startPosition.row + 1, end: h.endPosition.row + 1, route: { method: verb, path, auth: a ? true : null }, entry: "route", exported: true });
            const st = stats(h, DECISION);
            inline.complexity = st.cx;
            inline.toks = st.toks;
            analyze(inline, h, cls, new Map(vars), pre, a);
            info.defs.push(inline);
          } else if (h?.type === "class_constant_access_expression") {
            const c = h.text.replace(/::class$/, "");
            info.routeRefs.push({ def: defKey, method: verb, path, handler: `${lastOf(c)}.__invoke`, auth: a, recvType: lastOf(c) });
          }
          return true;
        }
        if ((name === "resource" || name === "apiResource") && first) {
          const base = ("/" + [pre, ci.prefix, strVal(first) ?? ""].join("/")).replace(/\/+/g, "/");
          const c = args[1]?.namedChild(0)?.text.replace(/::class$/, "");
          if (c) for (const [m, verb2, suffix] of RESOURCE) info.routeRefs.push({ def: defKey, method: verb2, path: base + suffix, handler: `${lastOf(c)}.${m}`, auth: auth || ci.auth, recvType: lastOf(c) });
          return true;
        }
      }
      // ---- sécurité
      if (SQL_CALLS.has(name) && first) checkSql(first, n);
      if (n.type === "scoped_call_expression" && scopeName === "Http" && ROUTE_VERBS[name] && first) {
        const url = urlOfText(first.text.replace(/\{\$?\w+\}|\$\w+/g, "{}"));
        if (url) def.http.push({ method: name.toUpperCase(), url, line });
      }
      if (n.type === "member_call_expression" && name === "request" && args.length >= 2) {
        const url = urlOfText(args[1].text);
        if (url) def.http.push({ method: (strVal(args[0]) ?? "GET").toUpperCase(), url, line });
      }
      if (/^(get|post|put|delete)$/.test(name) && n.type === "member_call_expression" && /client|guzzle|http/i.test(n.childForFieldName("object")?.text ?? "") && first) {
        const url = urlOfText(first.text);
        if (url) def.http.push({ method: name.toUpperCase(), url, line });
      }
      return false;
    };
    scan(body, prefix, authCtx);
  };

  const topDef = mkDef({ qual: "<routes>", name: "<routes>", line: 1, end: 1 });
  const topLevelCode = (st: Node) => {
    if (!/Route::|->group\(|Route\b/.test(st.text)) return;
    if (!info.defs.includes(topDef)) info.defs.push(topDef);
    topDef.entry = "handler";
    topDef.end = Math.max(topDef.end, st.endPosition.row + 1);
    analyzeTop(st);
  };
  const analyzeTop = (st: Node) => {
    // le code de routage (routes/*.php) est analysé comme le corps d'une fonction virtuelle
    const before = info.defs.length;
    void before;
    const fake: Node = st;
    const run = (d: Def) => d;
    run(topDef);
    analyzeBodyWith(fake);
  };
  let analyzeBodyWith: (n: Node) => void = () => undefined;
  analyzeBodyWith = (n: Node) => {
    const varsTop = new Map<string, TypeRef>();
    // on réutilise la même logique que pour une fonction
    funcLike(topDef, n, null, varsTop);
  };
  const funcLike = (def: Def, body: Node, cls: string | null, vars: Map<string, TypeRef>) => analyzeShim(def, body, cls, vars);
  let analyzeShim: (def: Def, body: Node, cls: string | null, vars: Map<string, TypeRef>) => void = () => undefined;
  analyzeShim = (def, body, cls, vars) => analyze(def, body, cls, vars, "", false);

  const funcDef = (fn: Node, cname: string | null, vars0: Map<string, TypeRef>, classRoute?: { prefix: string; auth: boolean }) => {
    const name = fn.childForFieldName("name")?.text;
    if (!name) return;
    const attrs = attrsOf(fn);
    const vars = new Map(vars0);
    const params: string[] = [];
    for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
      const v = p.namedChildren.find((c) => c.type === "variable_name");
      const nm = v?.text.replace(/^\$/, "");
      const ty = typeRefOf(p.namedChildren.find((c) => c.type === "named_type" || c.type === "optional_type"));
      if (nm) {
        params.push(nm);
        if (ty) vars.set(nm, ty);
        if (p.type === "property_promotion_parameter" && cname) promoted.push({ name: nm, ty });
      }
    }
    const body = fn.childForFieldName("body");
    const mods = fn.namedChildren.map((c) => c.type);
    const def = mkDef({
      qual: cname ? `${cname}.${name}` : name, name: name === "__construct" ? "<init>" : name, recvType: cname ?? undefined, line: fn.startPosition.row + 1, end: fn.endPosition.row + 1,
      exported: !fn.namedChildren.some((c) => c.type === "visibility_modifier" && /private|protected/.test(c.text)), params, annotations: attrs.map((a) => a.name), iface: !body,
    });
    if (name === "__construct") def.qual = `${cname}.<init>`;
    if (body) {
      const st = stats(body, DECISION);
      def.complexity = st.cx;
      def.toks = st.toks;
      def.nstmts = body.namedChildCount;
      analyze(def, body, cname, vars, "", false);
    }
    // attributs Symfony : #[Route('/x', methods: ['GET'])]
    for (const a of attrs) {
      if (a.name === "Route") {
        const p = /['"]([^'"]*)['"]/.exec(a.text)?.[1] ?? "";
        const m = /methods:\s*\[\s*['"](\w+)['"]/.exec(a.text)?.[1] ?? "ANY";
        def.route = { method: m.toUpperCase(), path: ("/" + [classRoute?.prefix ?? "", p].join("/")).replace(/\/+/g, "/"), auth: /IsGranted/.test(fn.text) || classRoute?.auth ? true : null };
        def.entry = "route";
      } else if (a.name === "AsMessageHandler" || a.name === "AsEventListener" || a.name === "AsCommand") def.entry = def.entry ?? "handler";
      else if (a.name === "Test") def.entry = "test";
    }
    if (/^test/.test(name) && cname && /Test$/.test(cname)) def.entry = "test";
    if (!cname && body && /(^|\/)(index|public\/index)\.php$/.test(rel)) def.entry = def.entry ?? "main";
    if (cname && /^(handle|__invoke)$/.test(name) && /Jobs?|Listeners?|Commands?/.test(rel)) {
      def.worker = /Jobs?/.test(rel) ? { lib: "queue" } : null;
      def.entry = def.worker ? "worker" : "handler";
    }
    info.defs.push(def);
  };

  let promoted: { name: string; ty: TypeRef | null }[] = [];
  const visitClass = (cn: Node) => {
    const name = cn.childForFieldName("name")?.text;
    if (!name) return;
    const kind: TypeInfo["kind"] = cn.type === "interface_declaration" ? "interface" : "class";
    const bases: string[] = [];
    for (const c of cn.namedChildren) if (c.type === "base_clause" || c.type === "class_interface_clause") for (const x of c.namedChildren) if (x.type === "name" || x.type === "qualified_name") bases.push(lastOf(x.text));
    const attrs = attrsOf(cn);
    const t: TypeInfo = { name, kind, fields: new Map(), fieldList: [], bases, annotations: attrs.map((a) => a.name), tags: [], line: cn.startPosition.row + 1, end: cn.endPosition.row + 1, exported: true };
    const body = cn.childForFieldName("body");
    const fillable: string[] = [];
    for (const m of body?.namedChildren ?? []) {
      if (m.type === "property_declaration") {
        const ty = typeRefOf(m.namedChildren.find((c) => c.type === "named_type" || c.type === "optional_type"));
        for (const pe of m.namedChildren.filter((c) => c.type === "property_element")) {
          const nm = pe.namedChildren.find((c) => c.type === "variable_name")?.text.replace(/^\$/, "");
          if (!nm) continue;
          if (ty) t.fields.set(nm, ty);
          t.fieldList.push({ name: nm, type: m.namedChildren.find((c) => c.type === "named_type" || c.type === "optional_type")?.text ?? "", default: null });
          if (nm === "fillable") for (const s of pe.text.matchAll(/['"](\w+)['"]/g)) fillable.push(s[1]);
          const sv = pe.text.match(/=\s*['"]([^'"]{6,})['"]/)?.[1];
          if (sv && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && !sv.includes("://")) issue(null, pe, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
        }
      }
    }
    promoted = [];
    const classRouteAttr = attrs.find((a) => a.name === "Route");
    const classRoute = classRouteAttr ? { prefix: /['"]([^'"]*)['"]/.exec(classRouteAttr.text)?.[1] ?? "", auth: /IsGranted/.test(cn.text.slice(0, 200)) } : undefined;
    const before = info.defs.length;
    for (const m of body?.namedChildren ?? []) if (m.type === "method_declaration") funcDef(m, name, t.fields, classRoute);
    for (const p of promoted) {
      if (p.ty) t.fields.set(p.name, p.ty);
      t.fieldList.push({ name: p.name, type: p.ty?.name ?? "", default: null });
    }
    // les propriétés promues (constructeur) sont des champs : on relance l'analyse des méthodes si elles en dépendaient
    if (promoted.length) {
      for (const d of info.defs.slice(before)) for (const c of d.calls) if (!c.root && c.chain && c.chain.length > 0 && !c.plain) c.root = { name };
    }
    // modèles Eloquent / Doctrine
    if (bases.some((b) => /^(Model|Authenticatable|Pivot)$/.test(b)) || attrs.some((a) => /^(Entity|ORM\\Entity)$/.test(a.name) || a.text.includes("ORM\\Entity"))) {
      t.annotations.push("Entity");
      if (fillable.length) for (const f of fillable) if (!t.fieldList.some((x) => x.name === f)) t.fieldList.push({ name: f, type: "", default: null });
    }
    info.types.push(t);
  };

  visitTop(root.namedChildren);
  return info;
}
