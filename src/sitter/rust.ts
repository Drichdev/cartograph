import { Call, Def, FileInfo, Node, RawIssue, SECRET_EXCLUDE, SECRET_RE, SQL_RE, TypeInfo, TypeRef, mkDef, stats, unquote, urlOfText } from "./common";

const DECISION = new Set(["if_expression", "match_arm", "for_expression", "while_expression", "loop_expression"]);
const WRAPPERS = new Set(["Arc", "Rc", "Box", "Option", "Mutex", "RwLock", "Result", "Vec", "RefCell", "Pin"]);
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch"]);
const SQL_CALLS = new Set(["query", "query_as", "query_scalar", "execute", "prepare", "raw"]);

export function typeRefOf(n: Node | null): TypeRef | null {
  if (!n) return null;
  switch (n.type) {
    case "type_identifier":
      return { name: n.text };
    case "scoped_type_identifier": {
      const parts = n.text.split("::");
      return { pkg: parts.length > 1 ? parts[0] : undefined, name: parts[parts.length - 1] };
    }
    case "reference_type":
    case "pointer_type":
      return typeRefOf(n.childForFieldName("type"));
    case "generic_type": {
      const base = typeRefOf(n.childForFieldName("type"));
      if (base && WRAPPERS.has(base.name)) {
        const arg = n.childForFieldName("type_arguments")?.namedChildren[0];
        return typeRefOf(arg ?? null) ?? base;
      }
      return base;
    }
    case "array_type":
      return typeRefOf(n.childForFieldName("element"));
    case "dynamic_type":
    case "abstract_type":
    case "bounded_type":
      return typeRefOf(n.childForFieldName("trait") ?? n.namedChild(0));
    default:
      return null;
  }
}

function flattenUse(n: Node | null, prefix: string, out: [string, string][]) {
  if (!n) return;
  switch (n.type) {
    case "identifier":
    case "scoped_identifier": {
      const path = prefix ? `${prefix}::${n.text}` : n.text;
      out.push([n.text.split("::").pop()!, path]);
      break;
    }
    case "use_as_clause": {
      const p = n.childForFieldName("path")?.text ?? "";
      const alias = n.childForFieldName("alias")?.text ?? p.split("::").pop()!;
      out.push([alias, prefix ? `${prefix}::${p}` : p]);
      break;
    }
    case "use_list":
      for (const c of n.namedChildren) flattenUse(c, prefix, out);
      break;
    case "scoped_use_list": {
      const p = n.childForFieldName("path")?.text ?? "";
      flattenUse(n.childForFieldName("list"), prefix ? `${prefix}::${p}` : p, out);
      break;
    }
    default:
      break;
  }
}

function attributesBefore(n: Node): string[] {
  const out: string[] = [];
  let p = n.previousNamedSibling;
  while (p && (p.type === "attribute_item" || p.type === "line_comment" || p.type === "block_comment")) {
    if (p.type === "attribute_item") out.unshift(p.text.replace(/^#!?\[|\]$/g, ""));
    p = p.previousNamedSibling;
  }
  return out;
}

export function extractRust(root: Node, rel: string, src: string): FileInfo {
  const info: FileInfo = {
    rel, lang: "rust", pkgKey: rel.replace(/\.rs$/, "").replace(/\/(mod|lib|main)$/, ""), imports: new Map(), importPaths: [], defs: [], types: [], issues: [],
    loc: src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length, securityConfig: false, routeRefs: [], workerRefs: [], traitImpls: [], binds: [],
  };
  const issue = (def: string | null, node: Node, severity: RawIssue["severity"], category: string, rule: string, message: string, level: RawIssue["level"], params: RawIssue["params"] = {}) =>
    info.issues.push({ def, line: node.startPosition.row + 1, severity, category, rule, message, level, params });

  const uses: [string, string][] = [];
  const collectUses = (n: Node) => {
    if (n.type === "use_declaration") flattenUse(n.childForFieldName("argument"), "", uses);
    else if (n.type === "mod_item") n.childForFieldName("body")?.namedChildren.forEach(collectUses);
  };
  root.namedChildren.forEach(collectUses);
  for (const [alias, path] of uses) {
    info.imports.set(alias, path);
    info.importPaths.push(path);
  }
  const hasImport = (frag: string) => info.importPaths.some((p) => p.includes(frag)) || src.includes(frag + "::");

  const docOf = (n: Node) => {
    let p = n.previousNamedSibling;
    while (p && p.type === "attribute_item") p = p.previousNamedSibling;
    return p && p.type === "line_comment" && p.text.startsWith("///") ? p.text.replace(/^\/\/\/\s?/, "").slice(0, 140) : "";
  };

  const analyze = (def: Def, body: Node, selfType: string | null, vars: Map<string, TypeRef>, fields: Map<string, TypeRef>) => {
    const defKey = def.qual;
    const scan = (n: Node): void => {
      switch (n.type) {
        case "let_declaration": {
          const pat = n.childForFieldName("pattern");
          const nm = pat?.type === "identifier" ? pat.text : pat?.type === "mut_pattern" ? pat.namedChild(0)?.text : undefined;
          const ty = typeRefOf(n.childForFieldName("type"));
          const val = n.childForFieldName("value");
          if (nm) {
            let t = ty;
            if (!t && val) t = inferType(val, vars);
            if (t) vars.set(nm, t);
            if (val && /string_literal/.test(val.type) && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm)) {
              const v = unquote(val.text);
              if (v.length >= 6 && !v.includes("://")) issue(defKey, n, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
            }
          }
          break;
        }
        case "call_expression":
          handleCall(n);
          break;
      }
      for (const c of n.children) scan(c);
    };

    const inferType = (val: Node, v: Map<string, TypeRef>): TypeRef | null => {
      let c: Node | null = val;
      while (c && (c.type === "await_expression" || c.type === "try_expression" || c.type === "reference_expression")) c = c.namedChild(0);
      if (!c) return null;
      if (c.type === "struct_expression") return typeRefOf(c.childForFieldName("name"));
      if (c.type === "call_expression") {
        const f = c.childForFieldName("function");
        if (f?.type === "scoped_identifier") {
          const parts = f.text.split("::");
          const last = parts[parts.length - 1];
          const owner = parts[parts.length - 2];
          if (owner && /^[A-Z]/.test(owner) && /^(new|default|from|open|connect|with_\w+)$/.test(last)) return { pkg: parts.length > 2 ? parts[0] : undefined, name: owner };
          if (parts.length >= 2 && /^[a-z]/.test(parts[0])) return { pkg: parts[0], name: "?" + last };
        }
      }
      if (c.type === "identifier") return v.get(c.text) ?? null;
      return null;
    };

    const handleCall = (c: Node) => {
      let fn = c.childForFieldName("function");
      const args = c.childForFieldName("arguments")?.namedChildren ?? [];
      if (!fn) return;
      if (fn.type === "generic_function") fn = fn.childForFieldName("function") ?? fn;
      const line = c.startPosition.row + 1;
      let name = "";
      let call: Call | null = null;
      if (fn.type === "identifier") {
        name = fn.text;
        call = { name, line, plain: true };
        if (info.imports.has(name)) call = { name, line, plain: true };
      } else if (fn.type === "scoped_identifier") {
        const parts = fn.text.split("::");
        name = parts[parts.length - 1];
        const owner = parts[parts.length - 2];
        call = { name, line, plain: false };
        if (parts[0] === "Self" || (owner && /^[A-Z]/.test(owner))) {
          call.root = { name: parts[0] === "Self" && selfType ? selfType : owner, pkg: parts.length > 2 && /^[a-z]/.test(parts[0]) && parts[0] !== "crate" && parts[0] !== "self" && parts[0] !== "super" ? parts[0] : undefined };
          call.chain = [];
          call.ctor = /^(new|default|from)$/.test(name);
          if (parts.length > 2 && /^[a-z]/.test(parts[0]) && parts[0] !== "crate" && parts[0] !== "self" && parts[0] !== "super") call.pkg = parts[0];
        } else call.pkg = parts[0];
        if (parts.length >= 3 && (parts[0] === "crate" || parts[0] === "self" || parts[0] === "super")) (call as any).modPath = parts.slice(1, -1);
      } else if (fn.type === "field_expression") {
        name = fn.childForFieldName("field")?.text ?? "";
        const chain: string[] = [];
        let cur: Node | null = fn.childForFieldName("value");
        while (cur && cur.type === "field_expression") {
          chain.unshift(cur.childForFieldName("field")?.text ?? "");
          cur = cur.childForFieldName("value");
        }
        call = { name, line, plain: false, chain };
        if (cur?.type === "self") call.root = selfType ? { name: selfType } : null;
        else if (cur?.type === "identifier") call.root = vars.get(cur.text) ?? null;
      }
      if (call) {
        def.calls.push(call);
        def.callees.push(name);
      }
      for (const a of args) if (a.type === "identifier" || a.type === "scoped_identifier") def.refs.push(a.text);

      const first = args[0];
      const full = fn.text;
      // ---- sécurité
      if (/^Command::new$/.test(full) && first && /^"(sh|bash|cmd|powershell)"$/.test(first.text)) issue(defKey, c, "error", "security", "shell-exec", "Commande shell", "high", { fn: "Command::new" });
      if (name === "danger_accept_invalid_certs" && first?.text === "true") issue(defKey, c, "warning", "security", "tls-verify-off", "Vérification TLS désactivée", "medium");
      if (/^(md5::compute|Md5::new|Sha1::new|sha1::Sha1::new)$/.test(full)) issue(defKey, c, "info", "security", "weak-hash", "Algorithme de hachage faible", "low", { algo: /md5/i.test(full) ? "md5" : "sha1" });
      if (SQL_CALLS.has(name) && first && /format!\s*\(/.test(first.text) && SQL_RE.test(first.text)) issue(defKey, c, "error", "security", "sql-injection", "Requête SQL construite dynamiquement (injection possible)", "high");
      // ---- HTTP sortant
      if (hasImport("reqwest") || hasImport("ureq")) {
        if (/^(reqwest|ureq)::(get)$/.test(full) && first) {
          const url = urlOfText(first.text);
          if (url) def.http.push({ method: "GET", url, line });
        } else if (fn.type === "field_expression" && HTTP_VERBS.has(name) && first && /string_literal/.test(first.type)) {
          const url = urlOfText(first.text);
          if (url) def.http.push({ method: name.toUpperCase(), url, line });
        }
      }
      // ---- routes axum : .route("/x", get(h).post(h2))
      if (fn.type === "field_expression" && name === "route" && first && /string_literal/.test(first.type) && args[1]) {
        const path = unquote(first.text);
        const visit = (n: Node) => {
          if (n.type === "call_expression") {
            const f = n.childForFieldName("function");
            const fname = f?.type === "field_expression" ? f.childForFieldName("field")?.text : f?.text?.split("::").pop();
            const a0 = n.childForFieldName("arguments")?.namedChildren[0];
            if (fname && HTTP_VERBS.has(fname) && a0 && (a0.type === "identifier" || a0.type === "scoped_identifier")) info.routeRefs.push({ def: defKey, method: fname.toUpperCase(), path, handler: a0.text, auth: false });
          }
          n.children.forEach(visit);
        };
        visit(args[1]);
      }
    };
    scan(body);
  };

  const fnItem = (fn: Node, implType: string | null, fields: Map<string, TypeRef>) => {
    const name = fn.childForFieldName("name")?.text;
    if (!name) return;
    const attrs = attributesBefore(fn);
    const vars = new Map<string, TypeRef>();
    const params: string[] = [];
    for (const p of fn.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type === "self_parameter") continue;
      const pat = p.childForFieldName("pattern");
      const nm = pat?.type === "identifier" ? pat.text : pat?.type === "mut_pattern" ? pat.namedChild(0)?.text : undefined;
      const ty = typeRefOf(p.childForFieldName("type"));
      if (nm) {
        params.push(nm);
        if (ty) vars.set(nm, ty);
      }
    }
    const body = fn.childForFieldName("body");
    const def = mkDef({
      qual: implType ? `${implType}.${name}` : name, name, recvType: implType ?? undefined, line: fn.startPosition.row + 1, end: fn.endPosition.row + 1,
      exported: fn.children.some((c) => c.type === "visibility_modifier"), async: fn.children.some((c) => c.type === "function_modifiers" && /async/.test(c.text)),
      params, annotations: attrs, doc: docOf(fn), iface: !body,
    });
    if (body) {
      const sts = stats(body, DECISION);
      def.complexity = sts.cx;
      def.toks = sts.toks;
      def.nstmts = body.namedChildCount;
      analyze(def, body, implType, vars, fields);
    }
    for (const a of attrs) {
      const m = /^(get|post|put|delete|patch|head)\s*\(\s*"([^"]*)"/.exec(a);
      if (m) {
        def.route = { method: m[1].toUpperCase(), path: m[2], auth: null };
        def.entry = "route";
      }
      if (/^(test|tokio::test|rstest|async_std::test)/.test(a)) def.entry = "test";
      if (/^(tokio::main|actix_web::main|async_std::main)/.test(a)) def.entry = "main";
    }
    if (!implType && name === "main") def.entry = "main";
    info.defs.push(def);
  };

  const typeFields = new Map<string, Map<string, TypeRef>>();
  const visitItems = (items: Node[]) => {
    for (const it of items) {
      if (it.type === "struct_item") {
        const name = it.childForFieldName("name")?.text;
        if (!name) continue;
        const attrs = attributesBefore(it);
        const t: TypeInfo = { name, kind: "struct", fields: new Map(), fieldList: [], bases: [], annotations: attrs, tags: [], line: it.startPosition.row + 1, end: it.endPosition.row + 1, exported: it.children.some((c) => c.type === "visibility_modifier") };
        for (const f of it.childForFieldName("body")?.namedChildren ?? []) {
          if (f.type !== "field_declaration") continue;
          const fnm = f.childForFieldName("name")?.text;
          const ty = typeRefOf(f.childForFieldName("type"));
          if (fnm) {
            if (ty) t.fields.set(fnm, ty);
            t.fieldList.push({ name: fnm, type: f.childForFieldName("type")?.text ?? "", default: null });
          }
        }
        typeFields.set(name, t.fields);
        info.types.push(t);
      } else if (it.type === "enum_item") {
        const name = it.childForFieldName("name")?.text;
        if (name) info.types.push({ name, kind: "enum", fields: new Map(), fieldList: [], bases: [], annotations: attributesBefore(it), tags: [], line: it.startPosition.row + 1, end: it.endPosition.row + 1, exported: it.children.some((c) => c.type === "visibility_modifier") });
      } else if (it.type === "trait_item") {
        const name = it.childForFieldName("name")?.text;
        if (!name) continue;
        const t: TypeInfo = { name, kind: "trait", fields: new Map(), fieldList: [], bases: [], annotations: [], tags: [], line: it.startPosition.row + 1, end: it.endPosition.row + 1, exported: it.children.some((c) => c.type === "visibility_modifier") };
        for (const m of it.childForFieldName("body")?.namedChildren ?? []) {
          const mn = m.childForFieldName("name")?.text;
          if (mn) t.fieldList.push({ name: mn, type: "fn", default: null });
          if (m.type === "function_item" || m.type === "function_signature_item") fnItem(m, name, new Map());
        }
        info.types.push(t);
      } else if (it.type === "mod_item") {
        const b = it.childForFieldName("body");
        if (b) visitItems(b.namedChildren);
      }
    }
  };
  visitItems(root.namedChildren);
  for (const it of root.namedChildren) {
    if (it.type === "function_item") fnItem(it, null, new Map());
    else if (it.type === "impl_item") {
      const ty = typeRefOf(it.childForFieldName("type"));
      const tr = typeRefOf(it.childForFieldName("trait"));
      if (!ty) continue;
      if (tr) info.traitImpls.push({ type: ty.name, trait: tr.name });
      const fields = typeFields.get(ty.name) ?? new Map();
      for (const m of it.childForFieldName("body")?.namedChildren ?? []) if (m.type === "function_item") fnItem(m, ty.name, fields);
    } else if (it.type === "const_item" || it.type === "static_item") {
      const nm = it.childForFieldName("name")?.text;
      const val = it.childForFieldName("value");
      if (nm && val && /string_literal/.test(val.type) && SECRET_RE.test(nm) && !SECRET_EXCLUDE.test(nm)) {
        const v = unquote(val.text);
        if (v.length >= 6 && !v.includes("://")) issue(null, it, "warning", "security", "hardcoded-secret", `Secret potentiellement codé en dur dans « ${nm} »`, "medium", { name: nm });
      }
    }
  }
  return info;
}
