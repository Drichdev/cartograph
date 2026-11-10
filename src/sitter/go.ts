import { Call, Def, FileInfo, Node, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, stats, unquote, urlOfText } from "./common";

const DECISION = new Set(["if_statement", "for_statement", "expression_case", "type_case", "communication_case"]);
const ROUTE_METHODS: Record<string, string> = {
  GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH", Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH",
  Handle: "ANY", HandleFunc: "ANY", Any: "ANY",
};
const SQL_CALLS = new Set(["Query", "QueryRow", "Exec", "QueryContext", "ExecContext", "QueryRowContext", "Raw", "Where", "Select"]);

const lastSeg = (path: string): string => {
  const parts = path.split("/").filter((p) => !/^v\d+$/.test(p));
  let a = parts[parts.length - 1] ?? path;
  a = a.replace(/^go-/, "").replace(/-go$/, "").replace(/\.go$/, "");
  return a.replace(/[^A-Za-z0-9_]/g, "");
};

export function typeRefOf(n: Node | null): TypeRef | null {
  if (!n) return null;
  switch (n.type) {
    case "pointer_type":
    case "parenthesized_type":
      return typeRefOf(n.namedChild(0));
    case "qualified_type":
      return { pkg: n.childForFieldName("package")?.text, name: n.childForFieldName("name")?.text ?? "?" };
    case "type_identifier":
      return { name: n.text };
    case "generic_type":
      return typeRefOf(n.childForFieldName("type"));
    case "slice_type":
    case "array_type":
      return typeRefOf(n.childForFieldName("element"));
    default:
      return null;
  }
}

export function extractGo(root: Node, rel: string, src: string): FileInfo {
  const info: FileInfo = {
    rel, lang: "go", pkgKey: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".", imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, securityConfig: false, routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issue = (def: string | null, node: Node, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: node.startPosition.row + 1, severity, category, rule, message, level, params });

  // ---- imports
  for (const st of root.children) {
    if (st.type !== "import_declaration") continue;
    const specs: Node[] = [];
    const collect = (n: Node) => (n.type === "import_spec" ? specs.push(n) : n.children.forEach(collect));
    collect(st);
    for (const sp of specs) {
      const path = unquote(sp.childForFieldName("path")?.text ?? "");
      if (!path) continue;
      const alias = sp.childForFieldName("name")?.text;
      info.importPaths.push(path);
      if (alias === "_" || alias === ".") continue;
      info.imports.set(alias ?? lastSeg(path), path);
    }
  }
  const hasImport = (frag: string) => info.importPaths.some((p) => p.includes(frag));

  // ---- types
  for (const st of root.children) {
    if (st.type !== "type_declaration") continue;
    for (const spec of st.namedChildren) {
      if (spec.type !== "type_spec") continue;
      const name = spec.childForFieldName("name")?.text;
      const ty = spec.childForFieldName("type");
      if (!name || !ty) continue;
      const t: TypeInfo = { name, kind: ty.type === "interface_type" ? "interface" : "struct", fields: new Map(), fieldList: [], bases: [], annotations: [], tags: [], line: spec.startPosition.row + 1, end: spec.endPosition.row + 1, exported: /^[A-Z]/.test(name) };
      if (ty.type === "struct_type") {
        const list = ty.namedChildren.find((c) => c.type === "field_declaration_list");
        for (const fd of list?.namedChildren ?? []) {
          if (fd.type !== "field_declaration") continue;
          const tn = fd.childForFieldName("type");
          const ref = typeRefOf(tn);
          const tag = fd.childForFieldName("tag")?.text ?? null;
          const names = fd.children.filter((c) => c.type === "field_identifier").map((c) => c.text);
          if (names.length === 0 && ref) names.push(ref.name);
          for (const fname of names) {
            if (ref) t.fields.set(fname, ref);
            t.fieldList.push({ name: fname, type: tn?.text ?? "", default: tag });
            if (tag) t.tags.push(tag);
          }
          if (fd.children.filter((c) => c.type === "field_identifier").length === 0 && ref) t.bases.push(ref.name);
        }
      } else if (ty.type === "interface_type") {
        for (const m of ty.namedChildren) {
          const mn = m.childForFieldName("name")?.text;
          if (mn) t.fieldList.push({ name: mn, type: "func", default: null });
        }
      }
      info.types.push(t);
    }
  }

  // ---- fonctions et méthodes
  const docOf = (n: Node) => {
    const p = n.previousNamedSibling;
    return p && p.type === "comment" ? p.text.replace(/^\/\/\s?|^\/\*+\s?|\s?\*+\/$/g, "").split("\n")[0].slice(0, 140) : "";
  };

  const analyze = (def: Def, body: Node, vars: Map<string, TypeRef>, prefixes: Map<string, string>) => {
    const defKey = def.qual;
    const scan = (n: Node): void => {
      switch (n.type) {
        case "short_var_declaration": {
          const left = n.childForFieldName("left")?.namedChildren ?? [];
          const right = n.childForFieldName("right")?.namedChildren ?? [];
          left.forEach((l, i) => {
            const r = right[i];
            if (!r || l.type !== "identifier") return;
            const t = inferType(r, vars);
            if (t) vars.set(l.text, t);
            if (r.type === "call_expression") {
              const f = r.childForFieldName("function");
              if (f?.type === "selector_expression" && /^(Group|Party|Route)$/.test(f.childForFieldName("field")?.text ?? "")) {
                const arg = r.childForFieldName("arguments")?.namedChildren[0];
                const base = f.childForFieldName("operand")?.text ?? "";
                if (arg && /string_literal/.test(arg.type)) prefixes.set(l.text, (prefixes.get(base) ?? "") + unquote(arg.text));
              }
            }
            checkSecret(l.text, r, n);
          });
          break;
        }
        case "var_spec":
        case "const_spec": {
          const nm = n.childForFieldName("name")?.text;
          const ty = typeRefOf(n.childForFieldName("type"));
          if (nm && ty) vars.set(nm, ty);
          const val = n.childForFieldName("value")?.namedChildren[0];
          if (nm && val) checkSecret(nm, val, n);
          break;
        }
        case "keyed_element": {
          const parts = n.namedChildren;
          const key = parts[0]?.text ?? "";
          const val = parts[1]?.text ?? "";
          if (key === "InsecureSkipVerify" && val === "true") issue(defKey, n, "warning", "security", "tls-verify-off", "Vérification TLS désactivée", "medium");
          if ((key === "AllowAllOrigins" && val === "true") || (key === "AllowOrigins" && val.includes('"*"'))) issue(defKey, n, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");
          if (SECRET_RE.test(key) && !SECRET_EXCLUDE.test(key) && /^"[^"]{6,}"$/.test(val) && !val.includes("://")) issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${key} »`, "medium", { name: key });
          break;
        }
        case "call_expression": {
          if (handleCall(n)) return;
          break;
        }
      }
      for (const c of n.children) scan(c);
    };

    const checkSecret = (name: string, val: Node, at: Node) => {
      if (/string_literal/.test(val.type) && SECRET_RE.test(name) && !SECRET_EXCLUDE.test(name)) {
        const v = unquote(val.text);
        if (v.length >= 6 && !v.includes("://") && !v.startsWith("/")) issue(defKey, at, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${name} »`, "medium", { name });
      }
    };

    const handleCall = (c: Node): boolean => {
      const fn = c.childForFieldName("function");
      const args = c.childForFieldName("arguments")?.namedChildren ?? [];
      if (!fn) return false;
      const line = c.startPosition.row + 1;
      let call: Call | null = null;
      let name = "";
      if (fn.type === "identifier") {
        name = fn.text;
        call = { name, line, plain: true };
      } else if (fn.type === "selector_expression") {
        name = fn.childForFieldName("field")?.text ?? "";
        const chain: string[] = [];
        let cur: Node | null = fn.childForFieldName("operand");
        while (cur && cur.type === "selector_expression") {
          chain.unshift(cur.childForFieldName("field")?.text ?? "");
          cur = cur.childForFieldName("operand");
        }
        const rootName = cur?.type === "identifier" ? cur.text : null;
        if (rootName && info.imports.has(rootName)) call = { name, line, plain: false, pkg: rootName, chain };
        else if (rootName) call = { name, line, plain: false, root: vars.get(rootName) ?? null, chain };
        else call = { name, line, plain: false };
        if (rootName) (call as any).rootName = rootName;
      }
      if (call) {
        def.calls.push(call);
        def.callees.push(name);
      }
      for (const a of args) if (a.type === "identifier" || a.type === "selector_expression") def.refs.push(a.text);

      const pkgPath = call?.pkg ? info.imports.get(call.pkg) ?? "" : "";
      const first = args[0];
      const firstLit = first && /string_literal/.test(first.type) ? unquote(first.text) : null;

      // ---- sécurité
      if (pkgPath === "os/exec" && name === "Command" && firstLit && /^(sh|bash|cmd|powershell)$/.test(firstLit) && args.slice(1).some((a) => !/string_literal/.test(a.type)))
        issue(defKey, c, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: "exec.Command" });
      if ((pkgPath === "crypto/md5" || pkgPath === "crypto/sha1") && /^(New|Sum)$/.test(name)) issue(defKey, c, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: pkgPath.split("/")[1] });
      if (SQL_CALLS.has(name)) {
        const q = /Context$/.test(name) ? args[1] : args[0];
        if (q && isDynamicSql(q)) issue(defKey, c, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
      }
      // ---- injection : google/wire
      if (pkgPath.includes("google/wire")) {
        if (name === "Bind" && args.length === 2) {
          const nm = (a: Node) => /new\(\s*\*?\s*([\w.]+)\s*\)/.exec(a.text)?.[1]?.split(".").pop();
          const iface = nm(args[0]);
          const impl = nm(args[1]);
          if (iface && impl) info.binds.push({ iface, impl });
        }
        if (name === "Build") def.entry = def.entry ?? "handler";
      }
      // ---- HTTP sortant
      if (pkgPath === "net/http" && /^(Get|Post|Head|PostForm)$/.test(name) && first) {
        const url = urlOfText(first.text.replace(/"\s*\+\s*[^"]+$/, '{}"'));
        if (url) def.http.push({ method: name === "PostForm" ? "POST" : name.toUpperCase(), url, line });
      }
      if (pkgPath === "net/http" && name === "NewRequest" && args.length >= 2) {
        const url = urlOfText(args[1].text);
        const m = /string_literal/.test(args[0].type) ? unquote(args[0].text) : "GET";
        if (url) def.http.push({ method: m.toUpperCase(), url, line });
      }
      // ---- routes
      const rm = ROUTE_METHODS[name];
      if (call && !call.plain && rm && firstLit && firstLit.startsWith("/") && args.length >= 2) {
        const base = prefixes.get((call as any).rootName ?? "") ?? "";
        const path = base + firstLit;
        const authArg = args.slice(1, -1).some((a) => /auth|jwt|protect|session|middleware/i.test(a.text));
        const handler = args[args.length - 1];
        if (handler.type === "func_literal") {
          const inline = mkDef({ qual: `${rm} ${path}`, name: `${rm} ${path}`, line: handler.startPosition.row + 1, end: handler.endPosition.row + 1, route: { method: rm, path, auth: authArg ? true : null }, entry: "route", exported: true });
          const hb = handler.childForFieldName("body");
          if (hb) {
            const st = stats(hb, DECISION);
            inline.complexity = st.cx;
            inline.toks = st.toks;
            inline.nstmts = hb.namedChildCount;
            analyze(inline, hb, new Map(vars), prefixes);
          }
          info.defs.push(inline);
        } else if (handler.type === "identifier" || handler.type === "selector_expression") {
          const hop = handler.type === "selector_expression" ? handler.childForFieldName("operand") : null;
          info.routeRefs.push({ def: defKey, method: rm, path, handler: handler.text, auth: authArg, recvType: hop?.type === "identifier" ? vars.get(hop.text)?.name : undefined });
        }
        for (const a of args.slice(0, -1)) scan(a);
        return true;
      }
      if (call && !call.plain && firstLit !== null && args.length >= 2) {
        const last = args[args.length - 1];
        if (name === "AddFunc" && hasImport("cron")) {
          if (last.type === "func_literal") {
            const inline = mkDef({ qual: `cron ${firstLit}`, name: `cron ${firstLit}`, line: last.startPosition.row + 1, end: last.endPosition.row + 1, worker: { lib: "scheduler" }, entry: "worker", exported: true });
            const hb = last.childForFieldName("body");
            if (hb) analyze(inline, hb, new Map(vars), prefixes);
            info.defs.push(inline);
            return true;
          }
          info.workerRefs.push({ def: defKey, lib: "scheduler", handler: last.text });
        } else if (/^Handle(Func)?$/.test(name) && !firstLit.startsWith("/") && hasImport("asynq")) {
          info.workerRefs.push({ def: defKey, lib: "asynq", handler: last.text });
        }
      }
      return false;
    };

    scan(body);
  };

  const isDynamicSql = (a: Node): boolean => {
    if (a.type === "call_expression") {
      const f = a.childForFieldName("function")?.text ?? "";
      if (f === "fmt.Sprintf") {
        const lit = a.childForFieldName("arguments")?.namedChildren[0];
        return !!lit && SQL_RE.test(lit.text) && (a.childForFieldName("arguments")?.namedChildCount ?? 0) > 1;
      }
    }
    if (a.type === "binary_expression" && a.childForFieldName("operator")?.text === "+") return SQL_RE.test(a.text) && /"/.test(a.text) && !/^"[^"]*"$/.test(a.text);
    return false;
  };

  const inferType = (r: Node, vars: Map<string, TypeRef>): TypeRef | null => {
    switch (r.type) {
      case "composite_literal":
        return typeRefOf(r.childForFieldName("type"));
      case "unary_expression":
        return r.namedChild(0) ? inferType(r.namedChild(0)!, vars) : null;
      case "identifier":
        return vars.get(r.text) ?? null;
      case "call_expression": {
        const f = r.childForFieldName("function");
        if (f?.type === "identifier" && /^New[A-Z]/.test(f.text)) return { name: f.text.slice(3) };
        if (f?.type === "selector_expression") {
          const op = f.childForFieldName("operand");
          if (op?.type === "identifier" && info.imports.has(op.text)) {
            const fname = f.childForFieldName("field")?.text ?? "";
            return { pkg: op.text, name: /^New/.test(fname) ? fname.slice(3) || "?" : "?" + fname };
          }
        }
        return null;
      }
      default:
        return null;
    }
  };

  for (const st of root.children) {
    if (st.type !== "function_declaration" && st.type !== "method_declaration") continue;
    const nameNode = st.childForFieldName("name");
    const body = st.childForFieldName("body");
    if (!nameNode) continue;
    const name = nameNode.text;
    const vars = new Map<string, TypeRef>();
    let recvType: string | undefined;
    if (st.type === "method_declaration") {
      const rp = st.childForFieldName("receiver")?.namedChildren[0];
      const rt = typeRefOf(rp?.childForFieldName("type") ?? null);
      recvType = rt?.name;
      const rn = rp?.childForFieldName("name")?.text;
      if (rn && rt) vars.set(rn, rt);
    }
    const params: string[] = [];
    for (const p of st.childForFieldName("parameters")?.namedChildren ?? []) {
      const ref = typeRefOf(p.childForFieldName("type"));
      for (const c of p.children) if (c.type === "identifier") {
        params.push(c.text);
        if (ref) vars.set(c.text, ref);
      }
    }
    const def = mkDef({
      qual: recvType ? `${recvType}.${name}` : name, name, recvType, line: st.startPosition.row + 1, end: st.endPosition.row + 1,
      exported: /^[A-Z]/.test(name), params, doc: docOf(st), iface: !body,
    });
    if (body) {
      const sts = stats(body, DECISION);
      def.complexity = sts.cx;
      def.toks = sts.toks;
      def.nstmts = body.namedChildCount;
      analyze(def, body, vars, new Map());
    }
    if (!recvType && (name === "main" || name === "init")) def.entry = "main";
    if (/^(Test|Benchmark|Example)[A-Z_0-9]/.test(name) && rel.endsWith("_test.go")) def.entry = "test";
    info.defs.push(def);
  }
  // secrets déclarés au niveau du paquet
  for (const st of root.children) {
    if (st.type !== "const_declaration" && st.type !== "var_declaration") continue;
    const visit = (n: Node) => {
      if (n.type === "const_spec" || n.type === "var_spec") {
        const nm = n.childForFieldName("name")?.text;
        const val = n.childForFieldName("value")?.namedChildren[0];
        if (nm && val && /string_literal/.test(val.type) && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm)) {
          const v = unquote(val.text);
          if (v.length >= 6 && !v.includes("://") && !v.startsWith("/")) issue(null, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
        }
      } else n.children.forEach(visit);
    };
    visit(st);
  }
  return info;
}
