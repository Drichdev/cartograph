import { Call, Def, FileInfo, Node, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, stats, unquote, urlOfText } from "./common";

const DECISION = new Set(["if_expression", "for_statement", "while_statement", "do_while_statement", "when_entry", "catch_block", "elvis_expression"]);
const SQL_CALLS = new Set(["executeQuery", "executeUpdate", "execute", "prepareStatement", "createQuery", "createNativeQuery", "query", "queryForObject", "queryForList", "update", "rawQuery"]);
const MAPPING: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH", GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH" };
const KTOR = new Set(["get", "post", "put", "delete", "patch"]);
const AUTH_ANN = /^(PreAuthorize|PostAuthorize|Secured|RolesAllowed|Authenticated)$/;

function typeRefOf(n: Node | null): TypeRef | null {
  if (!n) return null;
  if (n.type === "user_type" || n.type === "nullable_type" || n.type === "type_identifier") {
    const t = n.type === "nullable_type" ? n.namedChild(0) : n;
    const id = t?.type === "type_identifier" ? t : t?.namedChildren.find((c) => c.type === "type_identifier");
    return id ? { name: id.text } : null;
  }
  return null;
}

/** Annotations d'une déclaration : celles du nœud `modifiers` + les lignes « @… » juste au-dessus (la grammaire les sépare parfois). */
function annotationsOf(node: Node, lines: string[]): { names: string[]; texts: string[]; words: Set<string> } {
  const names: string[] = [];
  const texts: string[] = [];
  const words = new Set<string>();
  const mods = node.children.find((c) => c.type === "modifiers");
  for (const c of mods?.children ?? []) {
    if (c.type === "annotation") {
      const t = c.text.replace(/^@/, "");
      texts.push(t);
      names.push(t.replace(/^\w+:/, "").split(/[(\s]/)[0].split(".").pop()!);
    } else words.add(c.text);
  }
  let r = node.startPosition.row - 1;
  while (r >= 0 && /^\s*@/.test(lines[r])) {
    const t = lines[r].trim().replace(/^@/, "");
    if (!texts.includes(t)) {
      texts.push(t);
      names.push(t.split(/[(\s]/)[0].split(".").pop()!);
    }
    r--;
  }
  return { names, texts, words };
}

export function extractKotlin(root: Node, rel: string, src: string): FileInfo {
  const lines = src.split("\n");
  const info: FileInfo = {
    rel, lang: "kotlin", pkgKey: "", imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: lines.filter((l) => l.trim() && !l.trim().startsWith("//")).length, securityConfig: /EnableWebSecurity|SecurityFilterChain/.test(src),
    routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issue = (def: string | null, node: Node, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: node.startPosition.row + 1, severity, category, rule, message, level, params });
  const idText = (n: Node | null | undefined) => n?.namedChildren.filter((c) => c.type === "simple_identifier").map((c) => c.text).join(".") ?? "";
  const strVal = (n: Node | null | undefined): string | null => (n && n.type === "string_literal" ? unquote(n.text) : null);

  for (const c of root.namedChildren) {
    if (c.type === "package_header") info.pkgKey = idText(c.namedChildren.find((x) => x.type === "identifier"));
    if (c.type === "import_list") {
      for (const h of c.namedChildren) {
        const p = idText(h.namedChildren.find((x) => x.type === "identifier"));
        if (!p) continue;
        info.importPaths.push(p);
        const alias = h.namedChildren.find((x) => x.type === "import_alias")?.namedChildren.find((x) => x.type === "type_identifier")?.text;
        if (!h.children.some((x) => x.type === "wildcard_import")) info.imports.set(alias ?? p.split(".").pop()!, p);
      }
    }
  }

  const firstString = (text: string) => /"([^"]*)"/.exec(text)?.[1] ?? null;

  const analyze = (def: Def, body: Node, cls: string | null, vars: Map<string, TypeRef>) => {
    const defKey = def.qual;
    const scan = (n: Node): void => {
      if (n.type === "property_declaration") {
        const vd = n.namedChildren.find((c) => c.type === "variable_declaration");
        const nm = vd?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        const ty = typeRefOf(vd?.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type") ?? null);
        const val = n.namedChildren.find((c) => c.type !== "variable_declaration" && c.type !== "binding_pattern_kind" && c.type !== "modifiers");
        if (nm) {
          let t = ty;
          if (!t && val?.type === "call_expression") {
            const f = val.namedChild(0);
            if (f?.type === "simple_identifier" && /^[A-Z]/.test(f.text)) t = { name: f.text };
          }
          if (t) vars.set(nm, t);
          const sv = strVal(val);
          if (sv && sv.length >= 6 && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && !sv.includes("://") && !sv.includes("$"))
            issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
        }
      }
      if (n.type === "call_expression") {
        if (handleCall(n)) return;
      }
      for (const c of n.children) scan(c);
    };

    const handleCall = (c: Node): boolean => {
      const callee = c.namedChild(0);
      const suffix = c.namedChildren.find((x) => x.type === "call_suffix");
      const args = suffix?.namedChildren.find((x) => x.type === "value_arguments")?.namedChildren ?? [];
      const argVal = (a: Node) => a.namedChildren.find((x) => x.type !== "simple_identifier" || a.namedChildCount === 1) ?? a;
      const first = args[0] ? argVal(args[0]) : undefined;
      const lambda = suffix?.namedChildren.find((x) => x.type === "annotated_lambda");
      if (!callee) return false;
      const line = c.startPosition.row + 1;
      let name = "";
      let call: Call | null = null;
      if (callee.type === "simple_identifier") {
        name = callee.text;
        call = /^[A-Z]/.test(name) ? { name: "<init>", line, plain: false, root: { name }, chain: [], ctor: true } : { name, line, plain: true };
      } else if (callee.type === "navigation_expression") {
        const chain: string[] = [];
        let cur: Node | null = callee;
        while (cur && cur.type === "navigation_expression") {
          chain.unshift(cur.namedChildren.find((x) => x.type === "navigation_suffix")?.namedChildren.find((x) => x.type === "simple_identifier")?.text ?? "");
          cur = cur.namedChild(0);
        }
        name = chain.pop() ?? "";
        const rootName = cur?.type === "simple_identifier" ? cur.text : cur?.type === "this_expression" ? "this" : null;
        call = { name, line, plain: false, chain };
        if (rootName === "this" && cls) call.root = { name: cls };
        else if (rootName) {
          const t = vars.get(rootName);
          if (t) call.root = t;
          else if (/^[A-Z]/.test(rootName) && chain.length === 0) call.root = { name: rootName };
        }
      }
      if (call) {
        def.calls.push(call);
        def.callees.push(name);
      }
      const objText = callee.text;
      // ---- Ktor : get("/x") { ... }
      if (callee.type === "simple_identifier" && KTOR.has(name) && lambda) {
        const p = first && strVal(first);
        if (p && p.startsWith("/")) {
          const m = name.toUpperCase();
          const inline = mkDef({ qual: `${m} ${p}`, name: `${m} ${p}`, line: c.startPosition.row + 1, end: c.endPosition.row + 1, route: { method: m, path: p, auth: null }, entry: "route", exported: true });
          const st = stats(lambda, DECISION);
          inline.complexity = st.cx;
          inline.toks = st.toks;
          analyze(inline, lambda, cls, new Map(vars));
          info.defs.push(inline);
          return true;
        }
      }
      // ---- sécurité
      if (name === "exec" && /getRuntime/.test(objText) && first && !strVal(first)) issue(defKey, c, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: "Runtime.exec" });
      if (name === "getInstance" && /MessageDigest/.test(objText) && /^"(MD5|SHA-?1)"$/i.test(first?.text ?? "")) issue(defKey, c, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: unquote(first!.text) });
      if (SQL_CALLS.has(name) && first && first.type === "string_literal" && /\$\w|\$\{/.test(first.text) && SQL_RE.test(first.text)) issue(defKey, c, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
      if (SQL_CALLS.has(name) && first && /"\s*\+/.test(first.text) && SQL_RE.test(first.text)) issue(defKey, c, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
      if (/^(setAllowedOrigins|allowedOrigins|addAllowedOrigin|anyHost)$/.test(name) && (args.length === 0 || /"\*"/.test(c.text))) issue(defKey, c, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");
      // ---- HTTP sortant
      const verb = /^(getFor(Object|Entity)|get)$/.test(name) ? "GET" : /^postFor(Object|Entity)$|^post$/.test(name) ? "POST" : name === "put" ? "PUT" : name === "delete" ? "DELETE" : null;
      if (verb && first && /rest|template|client/i.test(objText) && first.type === "string_literal") {
        const url = urlOfText(first.text.replace(/\$\{[^}]*\}|\$\w+/g, "{}"));
        if (url) def.http.push({ method: verb, url, line });
      }
      return false;
    };
    scan(body);
  };

  const funcDef = (fn: Node, cname: string | null, vars0: Map<string, TypeRef>, base: string, classAuth: boolean) => {
    const name = fn.namedChildren.find((c) => c.type === "simple_identifier")?.text;
    if (!name) return;
    const an = annotationsOf(fn, lines);
    const vars = new Map(vars0);
    const params: string[] = [];
    for (const p of fn.namedChildren.find((c) => c.type === "function_value_parameters")?.namedChildren ?? []) {
      const nm = p.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const ty = typeRefOf(p.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type") ?? null);
      if (nm) {
        params.push(nm);
        if (ty) vars.set(nm, ty);
      }
    }
    const body = fn.namedChildren.find((c) => c.type === "function_body");
    const def = mkDef({
      qual: cname ? `${cname}.${name}` : name, name, recvType: cname ?? undefined, line: fn.startPosition.row + 1, end: fn.endPosition.row + 1,
      exported: !an.words.has("private") && !an.words.has("internal") && !an.words.has("protected"), params, annotations: an.names, iface: !body,
    });
    if (body) {
      const st = stats(body, DECISION);
      def.complexity = st.cx;
      def.toks = st.toks;
      def.nstmts = body.namedChildCount;
      analyze(def, body, cname, vars);
    }
    let route: Def["route"] = null;
    an.names.forEach((a, i) => {
      const text = an.texts[i];
      if (a in MAPPING) route = { method: MAPPING[a], path: ("/" + [base, firstString(text) ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/"), auth: null };
      else if (a === "RequestMapping") route = { method: /RequestMethod\.(\w+)/.exec(text)?.[1] ?? "ANY", path: ("/" + [base, firstString(text) ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/"), auth: null };
      else if (a === "Scheduled") def.worker = { lib: "scheduler" };
      else if (a === "KafkaListener") def.worker = { lib: "kafka" };
      else if (a === "RabbitListener") def.worker = { lib: "rabbitmq" };
      else if (/^(EventListener|PostConstruct|PreDestroy|Bean|ExceptionHandler)$/.test(a)) def.entry = def.entry ?? "handler";
      else if (/^(Test|ParameterizedTest|BeforeEach|AfterEach)$/.test(a)) def.entry = "test";
    });
    if (route) {
      (route as NonNullable<Def["route"]>).auth = classAuth || an.names.some((a) => AUTH_ANN.test(a)) ? true : info.securityConfig ? null : false;
      def.route = route;
      def.entry = "route";
    } else if (def.worker) def.entry = "worker";
    if (!cname && name === "main") def.entry = "main";
    // @Bean : le type de retour déclaré est fourni par l'objet construit dans le corps
    if (an.names.includes("Bean") && body) {
      const rt = typeRefOf(fn.namedChildren.find((c, i) => i > 0 && (c.type === "user_type" || c.type === "nullable_type") && c.startIndex > (fn.namedChildren.find((x) => x.type === "function_value_parameters")?.startIndex ?? 0)) ?? null);
      const made = /\b([A-Z]\w+)\s*\(/.exec(body.text)?.[1];
      if (rt && made && made !== rt.name) info.binds.push({ iface: rt.name, impl: made });
    }
    info.defs.push(def);
  };

  const visitClass = (cn: Node) => {
    const name = cn.namedChildren.find((c) => c.type === "type_identifier")?.text;
    if (!name) return;
    const an = annotationsOf(cn, lines);
    const isIface = /(^|\s)interface\s+\w+/.test(cn.text.split("{")[0].slice(0, 400));
    const t: TypeInfo = {
      name, kind: isIface ? "interface" : "class", fields: new Map(), fieldList: [], bases: [], annotations: an.names, tags: [],
      line: cn.startPosition.row + 1, end: cn.endPosition.row + 1, exported: !an.words.has("private"),
    };
    const specs = [...cn.namedChildren.filter((c) => c.type === "delegation_specifier"), ...(cn.namedChildren.find((c) => c.type === "delegation_specifiers")?.namedChildren ?? [])];
    for (const d of specs) {
      const ut = d.namedChildren.find((c) => c.type === "user_type") ?? (d.type === "user_type" ? d : d.namedChildren.find((c) => c.type === "constructor_invocation")?.namedChildren.find((c) => c.type === "user_type"));
      const r = typeRefOf(ut ?? null);
      if (r) t.bases.push(r.name);
    }
    for (const p of cn.namedChildren.find((c) => c.type === "primary_constructor")?.namedChildren ?? []) {
      if (p.type !== "class_parameter") continue;
      const nm = p.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const ty = typeRefOf(p.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type") ?? null);
      if (nm) {
        if (ty) t.fields.set(nm, ty);
        t.fieldList.push({ name: nm, type: p.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text ?? "", default: null });
      }
    }
    const body = cn.namedChildren.find((c) => c.type === "class_body");
    for (const m of body?.namedChildren ?? []) {
      if (m.type !== "property_declaration") continue;
      const vd = m.namedChildren.find((c) => c.type === "variable_declaration");
      const nm = vd?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
      const tn = vd?.namedChildren.find((c) => c.type === "user_type" || c.type === "nullable_type");
      if (nm) {
        const ty = typeRefOf(tn ?? null);
        if (ty) t.fields.set(nm, ty);
        t.fieldList.push({ name: nm, type: tn?.text ?? "", default: null });
        const sv = strVal(m.namedChildren.find((c) => c.type === "string_literal"));
        if (sv && sv.length >= 6 && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && !sv.includes("://") && !sv.includes("$"))
          issue(null, m, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
      }
    }
    info.types.push(t);
    const mapTxt = an.texts[an.names.findIndex((a) => a === "RequestMapping")];
    const base = mapTxt ? firstString(mapTxt) ?? "" : "";
    const classAuth = an.names.some((a) => AUTH_ANN.test(a));
    for (const m of body?.namedChildren ?? []) {
      if (m.type === "function_declaration") funcDef(m, name, t.fields, base, classAuth);
      else if (m.type === "class_declaration" || m.type === "object_declaration") visitClass(m);
    }
  };

  for (const st of root.namedChildren) {
    if (st.type === "class_declaration" || st.type === "object_declaration") visitClass(st);
    else if (st.type === "function_declaration") funcDef(st, null, new Map(), "", false);
  }
  return info;
}
