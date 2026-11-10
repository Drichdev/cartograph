import { Call, Def, FileInfo, Node, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, stats, unquote, urlOfText } from "./common";

const DECISION = new Set(["if_statement", "for_statement", "enhanced_for_statement", "while_statement", "do_statement", "switch_label", "catch_clause", "ternary_expression"]);
const SQL_CALLS = new Set(["executeQuery", "executeUpdate", "execute", "prepareStatement", "createQuery", "createNativeQuery", "query", "queryForObject", "queryForList", "update"]);
const MAPPING: Record<string, string> = { GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH", GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE", PATCH: "PATCH" };
const AUTH_ANN = /^(PreAuthorize|PostAuthorize|Secured|RolesAllowed|Authenticated)$/;

interface Ann {
  name: string;
  text: string;
}

export function typeRefOf(n: Node | null): TypeRef | null {
  if (!n) return null;
  switch (n.type) {
    case "type_identifier":
      return { name: n.text };
    case "scoped_type_identifier":
      return { name: n.text.split(".").pop()! };
    case "generic_type":
      return typeRefOf(n.namedChild(0));
    case "array_type":
      return typeRefOf(n.childForFieldName("element"));
    default:
      return null;
  }
}

function annotations(mods: Node | null | undefined): { anns: Ann[]; words: Set<string> } {
  const anns: Ann[] = [];
  const words = new Set<string>();
  for (const c of mods?.children ?? []) {
    if (c.type === "marker_annotation" || c.type === "annotation") anns.push({ name: (c.childForFieldName("name")?.text ?? "").split(".").pop()!, text: c.text });
    else words.add(c.text);
  }
  return { anns, words };
}

export function extractJava(root: Node, rel: string, src: string): FileInfo {
  const info: FileInfo = {
    rel, lang: "java", pkgKey: "", imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, securityConfig: /EnableWebSecurity|SecurityFilterChain|WebSecurityConfigurerAdapter/.test(src), routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issue = (def: string | null, node: Node, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: node.startPosition.row + 1, severity, category, rule, message, level, params });

  for (const st of root.children) {
    if (st.type === "package_declaration") info.pkgKey = st.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text ?? "";
    if (st.type === "import_declaration") {
      const p = st.namedChildren.find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
      if (!p) continue;
      info.importPaths.push(p);
      if (!st.children.some((c) => c.type === "asterisk")) info.imports.set(p.split(".").pop()!, p);
    }
  }

  const docOf = (n: Node) => {
    const p = n.previousNamedSibling;
    return p && (p.type === "block_comment" || p.type === "line_comment") ? p.text.replace(/^\/\*+\s*|\s*\*+\/$|^\/\/\s?/g, "").split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).find((l) => l.trim() && !l.startsWith("@"))?.slice(0, 140) ?? "" : "";
  };

  const strLit = (n: Node | undefined | null): string | null => (n && n.type === "string_literal" ? unquote(n.text) : null);
  const firstString = (text: string): string | null => /"([^"]*)"/.exec(text)?.[1] ?? null;

  const analyze = (def: Def, body: Node, cls: string, vars: Map<string, TypeRef>, fields: Map<string, TypeRef>) => {
    const defKey = def.qual;
    const typeOfVar = (name: string): TypeRef | null => vars.get(name) ?? null;
    const scan = (n: Node): void => {
      switch (n.type) {
        case "local_variable_declaration": {
          const ty = typeRefOf(n.childForFieldName("type"));
          for (const d of n.namedChildren.filter((c) => c.type === "variable_declarator")) {
            const nm = d.childForFieldName("name")?.text;
            const val = d.childForFieldName("value");
            if (!nm) continue;
            let t = ty;
            if ((!t || n.childForFieldName("type")?.text === "var") && val?.type === "object_creation_expression") t = typeRefOf(val.childForFieldName("type"));
            if (t) vars.set(nm, t);
            if (val && strLit(val) && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && strLit(val)!.length >= 6 && !strLit(val)!.includes("://"))
              issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
          }
          break;
        }
        case "object_creation_expression": {
          const tn = typeRefOf(n.childForFieldName("type"));
          if (tn) {
            def.calls.push({ name: "<init>", line: n.startPosition.row + 1, plain: false, root: tn, chain: [], ctor: true });
            if (tn.name === "ObjectInputStream") issue(defKey, n, "warning", "security", "unsafe-deserialization", "Désérialisation non sûre", "medium");
            if (tn.name === "ProcessBuilder" && (n.childForFieldName("arguments")?.namedChildren ?? []).some((a) => a.type !== "string_literal"))
              issue(defKey, n, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: "ProcessBuilder" });
          }
          break;
        }
        case "method_reference": {
          const parts = n.text.split("::");
          if (parts[1]) def.refs.push(parts[0] === "this" ? parts[1] : `${parts[0]}.${parts[1]}`);
          break;
        }
        case "method_invocation": {
          handleCall(n);
          break;
        }
      }
      for (const c of n.children) scan(c);
    };

    const handleCall = (m: Node) => {
      const name = m.childForFieldName("name")?.text ?? "";
      const obj = m.childForFieldName("object");
      const args = m.childForFieldName("arguments")?.namedChildren ?? [];
      const line = m.startPosition.row + 1;
      const call: Call = { name, line, plain: !obj };
      if (obj) {
        const chain: string[] = [];
        let cur: Node | null = obj;
        while (cur && cur.type === "field_access") {
          chain.unshift(cur.childForFieldName("field")?.text ?? "");
          cur = cur.childForFieldName("object");
        }
        if (cur?.type === "object_creation_expression") {
          call.root = typeRefOf(cur.childForFieldName("type"));
          call.chain = chain;
        } else if (cur?.type === "this") {
          call.root = { name: cls };
          call.chain = chain;
        } else if (cur?.type === "identifier") {
          const id = cur.text;
          const t = typeOfVar(id);
          if (t) {
            call.root = t;
            call.chain = chain;
          } else if (/^[A-Z]/.test(id) && chain.length === 0) {
            call.root = { name: id };
            call.chain = [];
          }
        }
      }
      def.calls.push(call);
      def.callees.push(name);
      const objText = obj?.text ?? "";
      const first = args[0];

      // ---- sécurité
      if (name === "exec" && /getRuntime/.test(objText) && first && first.type !== "string_literal") issue(defKey, m, "error", "security", "shell-exec", "Commande shell construite dynamiquement", "high", { fn: "Runtime.exec" });
      if (name === "getInstance" && objText === "MessageDigest" && /^"(MD5|SHA-?1)"$/i.test(first?.text ?? "")) issue(defKey, m, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: unquote(first.text) });
      if (SQL_CALLS.has(name) && first && first.type === "binary_expression" && first.childForFieldName("operator")?.text === "+" && SQL_RE.test(first.text))
        issue(defKey, m, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
      if (/^(setAllowedOrigins|allowedOrigins|addAllowedOrigin)$/.test(name) && args.some((a) => a.text === '"*"')) issue(defKey, m, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");

      // ---- HTTP sortant
      const verb = /^(getFor(Object|Entity)|get)$/.test(name) ? "GET" : /^postFor(Object|Entity|Location)$|^post$/.test(name) ? "POST" : name === "put" ? "PUT" : name === "delete" ? "DELETE" : null;
      if (first && (/rest|template|client/i.test(objText) || name === "exchange") && (verb || name === "exchange") && first.type !== "this") {
        const url = urlOfText(first.type === "binary_expression" ? first.text.replace(/"\s*\+\s*[^"]+$/, '{}"').replace(/^[^"]*"/, '"') : first.text);
        const m2 = name === "exchange" ? /HttpMethod\.(\w+)/.exec(args[1]?.text ?? "")?.[1] ?? "GET" : verb!;
        if (url) def.http.push({ method: m2.toUpperCase(), url, line });
      }
      if (name === "uri" && first && /webClient|WebClient|\.(get|post|put|delete)\(\)/.test(objText)) {
        const url = urlOfText(first.text);
        const mm = /\.(get|post|put|delete)\(\)/.exec(objText)?.[1] ?? "get";
        if (url) def.http.push({ method: mm.toUpperCase(), url, line });
      }
    };
    scan(body);
  };

  const visitClass = (cn: Node) => {
    const nameNode = cn.childForFieldName("name");
    if (!nameNode) return;
    const cname = nameNode.text;
    const { anns, words } = annotations(cn.children.find((c) => c.type === "modifiers"));
    const kind: TypeInfo["kind"] = cn.type === "interface_declaration" ? "interface" : cn.type === "enum_declaration" ? "enum" : "class";
    const bases: string[] = [];
    const sup = cn.childForFieldName("superclass");
    if (sup) for (const t of sup.namedChildren) bases.push(typeRefOf(t)?.name ?? t.text);
    const ifs = cn.childForFieldName("interfaces");
    const collectTypes = (n: Node) => {
      for (const t of n.namedChildren) {
        if (t.type === "type_list") collectTypes(t);
        else bases.push(typeRefOf(t)?.name ?? t.text);
      }
    };
    if (ifs) collectTypes(ifs);
    if (kind === "interface") for (const e of cn.namedChildren.filter((c) => c.type === "extends_interfaces")) collectTypes(e.namedChildren[0] ?? e);
    const t: TypeInfo = { name: cname, kind, fields: new Map(), fieldList: [], bases, annotations: anns.map((a) => a.name), tags: [], line: cn.startPosition.row + 1, end: cn.endPosition.row + 1, exported: words.has("public") };
    const body = cn.childForFieldName("body");
    // composants de record
    for (const p of cn.childForFieldName("parameters")?.namedChildren ?? []) {
      const nm = p.childForFieldName("name")?.text;
      const ty = typeRefOf(p.childForFieldName("type"));
      if (nm) {
        if (ty) t.fields.set(nm, ty);
        t.fieldList.push({ name: nm, type: p.childForFieldName("type")?.text ?? "", default: null });
      }
    }
    for (const m of body?.namedChildren ?? []) {
      if (m.type !== "field_declaration") continue;
      const tn = m.childForFieldName("type");
      const ty = typeRefOf(tn);
      const fa = annotations(m.children.find((c) => c.type === "modifiers"));
      for (const d of m.namedChildren.filter((c) => c.type === "variable_declarator")) {
        const nm = d.childForFieldName("name")?.text;
        if (!nm) continue;
        if (ty) t.fields.set(nm, ty);
        t.fieldList.push({ name: nm, type: tn?.text ?? "", default: fa.anns.map((a) => a.name).join(",") || null });
        const val = d.childForFieldName("value");
        if (val && strLit(val) && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm) && strLit(val)!.length >= 6 && !strLit(val)!.includes("://"))
          issue(null, d, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
      }
    }
    info.types.push(t);

    // routes de classe
    const classMap = anns.find((a) => a.name === "RequestMapping" || a.name === "Path");
    const base = classMap ? firstString(classMap.text) ?? "" : "";
    const classAuth = anns.some((a) => AUTH_ANN.test(a.name));
    const classCors = anns.find((a) => a.name === "CrossOrigin");
    if (classCors && /"\*"/.test(classCors.text)) issue(cname, cn, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");

    for (const m of body?.namedChildren ?? []) {
      if (m.type === "class_declaration" || m.type === "interface_declaration" || m.type === "enum_declaration" || m.type === "record_declaration") {
        visitClass(m);
        continue;
      }
      if (m.type !== "method_declaration" && m.type !== "constructor_declaration") continue;
      const mname = m.type === "constructor_declaration" ? "<init>" : m.childForFieldName("name")?.text;
      if (!mname) continue;
      const ma = annotations(m.children.find((c) => c.type === "modifiers"));
      const vars = new Map<string, TypeRef>(t.fields);
      const params: string[] = [];
      for (const p of m.childForFieldName("parameters")?.namedChildren ?? []) {
        const nm = p.childForFieldName("name")?.text;
        const ty = typeRefOf(p.childForFieldName("type"));
        if (nm) {
          params.push(nm);
          if (ty) vars.set(nm, ty);
        }
      }
      const mbody = m.childForFieldName("body");
      const def = mkDef({
        qual: `${cname}.${mname}`, name: mname, recvType: cname, line: m.startPosition.row + 1, end: m.endPosition.row + 1,
        exported: ma.words.has("public") || kind === "interface", params, annotations: ma.anns.map((a) => a.name), doc: docOf(m), iface: !mbody,
      });
      if (mbody) {
        const sts = stats(mbody, DECISION);
        def.complexity = sts.cx;
        def.toks = sts.toks;
        def.nstmts = mbody.namedChildCount;
        analyze(def, mbody, cname, vars, t.fields);
      }
      // entrées
      let route: Def["route"] = null;
      for (const a of ma.anns) {
        if (a.name in MAPPING) {
          const method = MAPPING[a.name];
          const p = firstString(a.text) ?? "";
          route = { method, path: ("/" + [base, p].filter(Boolean).join("/")).replace(/\/+/g, "/"), auth: null };
        } else if (a.name === "RequestMapping") {
          const mm = /RequestMethod\.(\w+)/.exec(a.text)?.[1] ?? "ANY";
          const p = firstString(a.text) ?? "";
          route = { method: mm, path: ("/" + [base, p].filter(Boolean).join("/")).replace(/\/+/g, "/"), auth: null };
        } else if (a.name === "Path" && route) route.path = ("/" + [base, firstString(a.text) ?? ""].filter(Boolean).join("/")).replace(/\/+/g, "/");
        else if (a.name === "Scheduled") def.worker = { lib: "scheduler" };
        else if (a.name === "KafkaListener") def.worker = { lib: "kafka" };
        else if (a.name === "RabbitListener") def.worker = { lib: "rabbitmq" };
        else if (/^(JmsListener|SqsListener|StreamListener)$/.test(a.name)) def.worker = { lib: "rabbitmq" };
        else if (/^(EventListener|PostConstruct|PreDestroy|Bean|ExceptionHandler|ControllerAdvice)$/.test(a.name)) def.entry = def.entry ?? "handler";
        else if (/^(Test|ParameterizedTest|BeforeEach|AfterEach|BeforeAll|AfterAll)$/.test(a.name)) def.entry = "test";
        else if (a.name === "CrossOrigin" && /"\*"/.test(a.text)) issue(def.qual, m, "warning", "security", "cors-wildcard", "CORS ouvert à toutes les origines (*)", "medium");
      }
      if (ma.anns.some((a) => a.name === "Bean") && mbody) {
        const rt = typeRefOf(m.childForFieldName("type"));
        const made = /\bnew\s+([A-Z]\w*)\s*[(<]/.exec(mbody.text)?.[1];
        if (rt && made && made !== rt.name) info.binds.push({ iface: rt.name, impl: made });
      }
      if (route) {
        route.auth = classAuth || ma.anns.some((a) => AUTH_ANN.test(a.name)) ? true : info.securityConfig ? null : false;
        def.route = route;
        def.entry = "route";
      } else if (def.worker) def.entry = "worker";
      if (mname === "main" && ma.words.has("static")) def.entry = "main";
      info.defs.push(def);
    }
  };

  for (const st of root.children) if (/^(class|interface|enum|record)_declaration$/.test(st.type)) visitClass(st);
  return info;
}
