/* Cartograph — analyseur multi-langages (tree-sitter) : Go, Java, Rust.
 * Produit le même JSON que analyzer/analyze.py. Usage : node analyze_multi.js <racine> [--exclude d] [--out f] */
import Parser from "web-tree-sitter";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { INFRA, TOKEN_LAYER } from "../ts-analyzer/config";
import { finalize } from "../ts-analyzer/output";
import type { ModelOut, ModelsResult } from "../ts-analyzer/models";
import type { Mod, Rec, State } from "../ts-analyzer/types";
import type { Def, FileInfo, TypeInfo, TypeRef } from "./common";
import { extractGo } from "./go";
import { extractJava } from "./java";
import { extractRust } from "./rust";
import { extractKotlin } from "./kotlin";
import { extractPhp } from "./php";
import { extractDart } from "./dart";

const IGNORE = new Set(["node_modules", ".git", "vendor", "target", "build", "out", "bin", ".gradle", ".mvn", ".idea", ".vscode", "dist", "third_party", ".venv", "venv", "__pycache__"]);
type Lang = "go" | "java" | "rust" | "kotlin" | "php" | "dart";
const EXT: Record<string, Lang> = { ".go": "go", ".java": "java", ".rs": "rust", ".kt": "kotlin", ".kts": "kotlin", ".php": "php", ".dart": "dart" };
const COMMON = new Set(["new", "get", "set", "add", "run", "close", "open", "read", "write", "len", "push", "pop", "insert", "remove", "clone", "from", "into", "default", "build", "init", "main", "toString", "equals", "hashCode", "String", "Error", "Close", "Get", "Set", "Add", "Run", "Read", "Write", "Len"]);

// id d'infra -> préfixes de chemins d'import (Go, Java, Rust)
const INFRA_PATHS: [string, string[]][] = [
  ["redis", ["github.com/redis/go-redis", "github.com/go-redis/redis", "github.com/gomodule/redigo", "redis.clients.jedis", "io.lettuce", "org.springframework.data.redis", "redis::", "fred::", "deadpool_redis"]],
  ["mongodb", ["go.mongodb.org/mongo-driver", "com.mongodb", "org.springframework.data.mongodb", "mongodb::"]],
  ["postgres", ["github.com/jackc/pgx", "github.com/lib/pq", "org.postgresql", "tokio_postgres", "deadpool_postgres"]],
  ["mysql", ["github.com/go-sql-driver/mysql", "com.mysql", "mysql_async", "mysql::"]],
  ["sqlite", ["github.com/mattn/go-sqlite3", "modernc.org/sqlite", "org.sqlite", "rusqlite"]],
  ["sql", ["gorm.io/gorm", "database/sql", "github.com/jmoiron/sqlx", "javax.persistence", "jakarta.persistence", "org.hibernate", "org.springframework.data.jpa", "org.springframework.jdbc", "java.sql", "sqlx::", "diesel::", "sea_orm"]],
  ["kafka", ["github.com/segmentio/kafka-go", "github.com/Shopify/sarama", "github.com/IBM/sarama", "github.com/confluentinc/confluent-kafka-go", "org.apache.kafka", "org.springframework.kafka", "rdkafka"]],
  ["rabbitmq", ["github.com/streadway/amqp", "github.com/rabbitmq/amqp091-go", "com.rabbitmq", "org.springframework.amqp", "lapin"]],
  ["s3", ["github.com/aws/aws-sdk-go", "software.amazon.awssdk", "com.amazonaws", "github.com/minio/minio-go", "aws_sdk_", "aws_config"]],
  ["http", ["github.com/go-resty/resty", "java.net.http", "org.springframework.web.client", "org.springframework.web.reactive.function.client", "okhttp3", "reqwest", "ureq"]],
  ["elastic", ["github.com/elastic/go-elasticsearch", "org.elasticsearch", "elasticsearch"]],
  ["llm", ["github.com/sashabaranov/go-openai", "dev.langchain4j", "com.openai", "async_openai"]],
  ["email", ["net/smtp", "javax.mail", "jakarta.mail", "org.springframework.mail", "lettre"]],
  ["firebase", ["firebase.google.com/go", "com.google.firebase"]],
  ["stripe", ["github.com/stripe/stripe-go", "com.stripe", "stripe::"]],
  ["asynq", ["github.com/hibiken/asynq"]],
  ["scheduler", ["github.com/robfig/cron", "org.quartz", "org.springframework.scheduling", "tokio_cron_scheduler"]],
  ["supabase", ["package:supabase", "io.github.jan.supabase"]],
  ["kv", ["package:hive", "package:shared_preferences", "package:isar", "package:get_storage", "package:flutter_secure_storage"]],
  ["queue", ["Illuminate.Support.Facades.Queue", "Illuminate.Contracts.Queue", "Illuminate.Bus", "Illuminate.Queue"]],
  ["cache", ["Illuminate.Support.Facades.Cache", "Illuminate.Cache"]],
];
INFRA_PATHS[0][1].push("Illuminate.Support.Facades.Redis", "Illuminate.Redis", "Predis");
INFRA_PATHS[1][1].push("MongoDB", "Jenssegers.Mongodb", "package:mongo_dart");
INFRA_PATHS[2][1].push("package:postgres");
INFRA_PATHS[3][1].push("Doctrine.DBAL.Driver.PDOMySql");
INFRA_PATHS[4][1].push("package:sqflite", "package:drift", "package:floor");
INFRA_PATHS[5][1].push("Illuminate.Support.Facades.DB", "Illuminate.Database", "Doctrine.ORM", "Doctrine.DBAL", "androidx.room", "org.jetbrains.exposed");
INFRA_PATHS[6][1].push("RdKafka");
INFRA_PATHS[7][1].push("PhpAmqpLib");
INFRA_PATHS[8][1].push("Illuminate.Support.Facades.Storage", "Aws.");
INFRA_PATHS[9][1].push("Illuminate.Support.Facades.Http", "GuzzleHttp", "Symfony.Contracts.HttpClient", "io.ktor.client", "retrofit2", "package:dio", "package:http", "package:graphql", "package:retrofit");
INFRA_PATHS[13][1].push("package:firebase", "package:cloud_firestore");
INFRA_PATHS[12][1].push("Illuminate.Support.Facades.Mail", "Symfony.Component.Mailer", "PHPMailer");

function infraForPath(p0: string): string | null {
  const p = p0.replace(/\\/g, ".");
  for (const [id, prefixes] of INFRA_PATHS) for (const pre of prefixes) if (p === pre || p.startsWith(pre) && (pre.endsWith("::") || pre.endsWith("_") || /[./:]/.test(p[pre.length] ?? "/") || p.length === pre.length)) return id;
  return p.includes("::") || p.includes("/") || p.includes(".") ? null : infraForPath(p + "::");
}

const norm = (p: string) => p.split(path.sep).join("/");
const stripExt = (p: string) => p.replace(/\.(go|java|rs|kt|kts|php|dart)$/, "");

function classifyLayer(rel: string): string {
  const tokens = stripExt(rel).split(/[\/_.\-]|(?<=[a-z])(?=[A-Z])/).map((t) => t.toLowerCase()).filter(Boolean);
  if (tokens.some((t) => ["test", "tests", "spec", "it"].includes(t))) return "test";
  for (let i = tokens.length - 1; i >= 0; i--) if (TOKEN_LAYER[tokens[i]]) return TOKEN_LAYER[tokens[i]];
  return "other";
}

function discover(root: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let es: fs.Dirent[];
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      if (e.isDirectory()) {
        if (IGNORE.has(e.name) || exclude.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < 16) walk(path.join(dir, e.name), depth + 1);
      } else if (EXT[path.extname(e.name)]) {
        const p = path.join(dir, e.name);
        try {
          if (fs.statSync(p).size <= 1_500_000) out.push(p);
        } catch {
          /* ignoré */
        }
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

interface TypeEntry {
  info: TypeInfo;
  file: FileInfo;
}

const CACHE_VERSION = (() => {
  try {
    return "1:" + crypto.createHash("sha1").update(fs.readFileSync(__filename)).digest("hex").slice(0, 12);
  } catch {
    return "1:dev";
  }
})();

function readCache(p?: string): Record<string, { k: [number, number]; info: string }> {
  if (!p || !fs.existsSync(p)) return {};
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d.version === CACHE_VERSION ? d.files : {};
  } catch {
    return {};
  }
}

function writeCache(p: string | undefined, files: Record<string, { k: [number, number]; info: string }>) {
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ version: CACHE_VERSION, files }), "utf8");
  } catch {
    /* cache désactivé */
  }
}

export async function analyze(rootArg: string, extraExclude: string[] = [], wasmDir: string, cachePath?: string) {
  const t0 = Date.now();
  const root = path.resolve(rootArg);
  const files = discover(root, new Set(extraExclude));
  const S: State = {
    root, files: new Set(files), recs: [], byId: new Map(), recByKey: new Map(), ctorKey: new Map(), modules: new Map(), fileToMod: new Map(), issues: [],
    edges: new Map(), infraOps: new Map(), infraLibs: new Map(), thisAssigns: new Map(), pendingRoutes: [], pendingWorkers: [], varDecls: [], classDecls: [],
    implsByIface: new Map(), providers: [], knownNames: new Set(), modelByKey: new Map(), prismaUse: new Map(), programs: [],
  };
  if (files.length === 0) return finalize(S, [], t0);

  // ---- 1. parsing (avec cache par fichier)
  const cache = readCache(cachePath);
  const newCache: Record<string, { k: [number, number]; info: string }> = {};
  let inited = false;
  const parsers = new Map<string, Parser>();
  const getParser = async (lang: "go" | "java" | "rust" | "kotlin" | "php"): Promise<Parser> => {
    if (!inited) {
      await Parser.init({ locateFile: (n: string) => path.join(wasmDir, n) });
      inited = true;
    }
    let parser = parsers.get(lang);
    if (!parser) {
      parser = new Parser();
      parser.setLanguage(await Parser.Language.load(path.join(wasmDir, `tree-sitter-${lang}.wasm`)));
      parsers.set(lang, parser);
    }
    return parser;
  };
  const infos: FileInfo[] = [];
  let parsedCount = 0;
  let cachedCount = 0;
  for (const f of files) {
    const lang = EXT[path.extname(f)];
    const rel = norm(path.relative(root, f));
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    const hit = cache[rel];
    if (hit && hit.k[0] === st.size && hit.k[1] === st.mtimeMs) {
      try {
        infos.push(JSON.parse(hit.info, (_k, v) => (v && typeof v === "object" && v.__map ? new Map(v.__map) : v)));
        newCache[rel] = hit;
        cachedCount++;
        continue;
      } catch {
        /* entrée de cache illisible : on réanalyse */
      }
    }
    const src = fs.readFileSync(f, "utf8");
    try {
      let info: FileInfo;
      if (lang === "dart") info = extractDart(src, rel);
      else {
        const parser = await getParser(lang);
        const tree = parser.parse(src);
        info = lang === "go" ? extractGo(tree.rootNode, rel, src) : lang === "java" ? extractJava(tree.rootNode, rel, src) : lang === "kotlin" ? extractKotlin(tree.rootNode, rel, src) : lang === "php" ? extractPhp(tree.rootNode, rel, src) : extractRust(tree.rootNode, rel, src);
        tree.delete();
      }
      infos.push(info);
      parsedCount++;
      newCache[rel] = { k: [st.size, st.mtimeMs], info: JSON.stringify(info, (_k, v) => (v instanceof Map ? { __map: [...v] } : v)) };
    } catch (e) {
      process.stderr.write(`[tree-sitter] ${rel} : ${String((e as Error).message ?? e)}\n`);
    }
  }
  writeCache(cachePath, newCache);

  // ---- 2. modules et recs
  const mkRec = (id: string, over: Partial<Rec>): Rec =>
    ({ id, kind: "function", qual: "", name: "", module: "", file: "", line: 1, end: 1, complexity: 0, loc: 0, args: [], async: false, decorators: [], doc: "", exported: false, tag: null, route: null, worker: null, entry: null, calls: [], ids: [], toks: [], callees: [], nstmts: 0, http: [], sf: null as any, auth: false, dead: null, dup: null, callers: 0, callees2: 0, defaultExport: false, ...over }) as Rec;

  const fileOf = new Map<string, FileInfo>();
  const recDef = new Map<Rec, { def: Def; info: FileInfo }>();
  const byPkgFunc = new Map<string, Map<string, Rec>>();
  const methodIdx = new Map<string, Rec>();
  const byName = new Map<string, Rec[]>();
  const types = new Map<string, TypeEntry[]>();
  const modOfFile = new Map<string, Mod>();

  for (const info of infos) {
    const name = stripExt(info.rel);
    const mod: Mod = { name, file: info.rel, layer: classifyLayer(info.rel), loc: info.loc, top: mkRec(`mod:${name}`, { kind: "module", qual: "<module>", name, module: name, file: info.rel }), imports: new Set(), pkgs: new Set(), checker: null as any, functions: 0 };
    S.modules.set(name, mod);
    S.fileToMod.set(info.rel, mod);
    modOfFile.set(info.rel, mod);
    fileOf.set(info.rel, info);
    const seen = new Map<string, number>();
    for (const def of info.defs) {
      if (def.iface) continue;
      let qual = def.qual;
      const n = seen.get(qual) ?? 0;
      seen.set(qual, n + 1);
      if (n > 0) qual = `${qual}#${n + 1}`;
      const rec = mkRec(`fn:${name}:${qual}`, {
        kind: def.recvType ? "method" : "function", qual, name: def.name, module: name, file: info.rel, line: def.line, end: def.end, complexity: def.complexity,
        loc: def.end - def.line + 1, args: def.params, async: def.async, decorators: def.annotations, doc: def.doc, exported: def.exported, route: def.route, worker: def.worker ? { lib: def.worker.lib, queue: def.worker.lib } : null,
        entry: def.entry, toks: def.toks, callees: def.callees, nstmts: def.nstmts, http: def.http, auth: def.route?.auth === true, tag: def.tag ?? null,
      });
      (rec as any).authUnknown = def.route ? def.route.auth === null : false;
      S.recs.push(rec);
      S.byId.set(rec.id, rec);
      mod.functions++;
      recDef.set(rec, { def, info });
      if (def.recvType) {
        methodIdx.set(`${def.recvType}.${def.name}`, rec);
      } else {
        const m = byPkgFunc.get(info.pkgKey) ?? byPkgFunc.set(info.pkgKey, new Map()).get(info.pkgKey)!;
        m.set(def.name, rec);
      }
      (byName.get(def.name) ?? byName.set(def.name, []).get(def.name)!).push(rec);
    }
    for (const t of info.types) {
      (types.get(t.name) ?? types.set(t.name, []).get(t.name)!).push({ info: t, file: info });
      S.classDecls.push({ mod: name } as any);
    }
  }

  // ---- 3. implémentations (interfaces, traits)
  const implsOf = new Map<string, Set<string>>();
  const addImpl = (iface: string, type: string) => (implsOf.get(iface) ?? implsOf.set(iface, new Set()).get(iface)!).add(type);
  const methodsOfType = new Map<string, Set<string>>();
  for (const [k] of methodIdx) {
    const [t, m] = k.split(".");
    (methodsOfType.get(t) ?? methodsOfType.set(t, new Set()).get(t)!).add(m);
  }
  for (const [, entries] of types) {
    for (const e of entries) {
      for (const b of e.info.bases) addImpl(b, e.info.name);
      if (e.file.lang === "go" && e.info.kind === "interface" && e.info.fieldList.length > 0) {
        for (const [, others] of types) for (const o of others) {
          if (o.info.kind !== "struct") continue;
          const ms = methodsOfType.get(o.info.name);
          if (ms && e.info.fieldList.every((f) => ms.has(f.name))) addImpl(e.info.name, o.info.name);
        }
      }
    }
  }
  for (const info of infos) for (const ti of info.traitImpls) addImpl(ti.trait, ti.type);
  for (const info of infos) for (const b of info.binds ?? []) addImpl(b.iface, b.impl);

  // ---- 4. résolution
  const classify = (e: TypeEntry): { kind: string; store: string | null } | null => {
    const t = e.info;
    const anns = t.annotations.join(" ");
    let kind: string | null = null;
    let store: string | null = null;
    if (e.file.lang === "go" && t.kind === "struct" && t.tags.length > 0) {
      const tags = t.tags.join(" ");
      if (/gorm:/.test(tags)) { kind = "orm"; store = "sql"; }
      else if (/bson:/.test(tags)) { kind = "odm"; store = "mongodb"; }
      else if (t.tags.length >= 2) kind = "struct";
    } else if (e.file.lang === "java" && /(^|\s)(Entity|Table|MappedSuperclass)(\s|$)/.test(anns)) { kind = "orm"; store = "sql"; }
    else if (e.file.lang === "java" && /(^|\s)Document(\s|$)/.test(anns)) { kind = "odm"; store = "mongodb"; }
    else if (e.file.lang === "dart" && /(^|\s)(Table|Entity)(\s|$)/.test(anns)) { kind = "orm"; store = "sqlite"; }
    else if (e.file.lang === "dart" && /(FromJson|JsonSerializable|freezed|HiveType)/.test(anns)) kind = "struct";
    else if ((e.file.lang === "php" || e.file.lang === "kotlin") && /(^|\s)Entity(\s|$)/.test(anns)) { kind = "orm"; store = "sql"; }
    else if (e.file.lang === "rust" && t.kind === "struct" && /(FromRow|Queryable|Insertable|DeriveEntityModel|Selectable)/.test(anns)) { kind = "orm"; store = "sql"; }
    else if (e.file.lang === "rust" && t.kind === "struct" && /(Serialize|Deserialize)/.test(anns)) kind = "struct";
    return kind ? { kind, store } : null;
  };

  const typeEntry = (name: string, from: FileInfo): TypeEntry | null => {
    const list = types.get(name);
    if (!list) return null;
    return list.find((e) => e.file.pkgKey === from.pkgKey) ?? list[0];
  };
  const findMethod = (type: string, method: string, depth = 0): Rec | null => {
    const r = methodIdx.get(`${type}.${method}`);
    if (r) return r;
    if (depth > 4) return null;
    for (const e of types.get(type) ?? []) for (const b of e.info.bases) {
      const r2 = findMethod(b, method, depth + 1);
      if (r2) return r2;
    }
    return null;
  };
  const pkgDirFor = (p: string): string | null => {
    const segs = p.replace(/::/g, "/").replace(/^(crate|self|super)\//, "").replace(/\./g, "/");
    for (const key of byPkgFunc.keys()) if (key && (segs === key || segs.endsWith("/" + key) || segs.startsWith(key + "/") || key.endsWith("/" + segs))) return key;
    return null;
  };
  const addEdge = (src: string, tgt: string, kind: "call" | "ref" | "async", certain: boolean, label: string | null = null) => {
    if (src === tgt) return;
    const key = `${src}>${tgt}>${kind === "async" ? "a" : "c"}`;
    const e = S.edges.get(key);
    if (!e) S.edges.set(key, { source: src, target: tgt, kind, certain, count: 1, label });
    else {
      e.count++;
      if (kind === "call") e.kind = "call";
    }
  };
  const addInfra = (rec: Rec, id: string, op: string, lib: string) => {
    const k = `${rec.id}|${id}`;
    const m = S.infraOps.get(k) ?? new Map<string, number>();
    m.set(op, (m.get(op) ?? 0) + 1);
    S.infraOps.set(k, m);
    (S.infraLibs.get(id) ?? S.infraLibs.set(id, new Set()).get(id)!).add(lib);
  };
  const HTTP_CLIENT_CALLS = new Set(["Get", "Post", "Head", "PostForm", "NewRequest", "NewRequestWithContext", "Do"]);
  const modelUsers = new Map<string, Set<string>>();

  const infraOfType = (t: TypeRef, info: FileInfo): { id: string; lib: string } | null => {
    const p = t.pkg ? info.imports.get(t.pkg) ?? t.pkg : info.imports.get(t.name);
    if (!p) return null;
    const id = infraForPath(p);
    return id ? { id, lib: p } : null;
  };

  for (const rec of S.recs) {
    const { def, info } = recDef.get(rec)!;
    for (const di of def.infra ?? []) addInfra(rec, di.id, di.op, di.lib);
    for (const call of def.calls) {
      let target: Rec | null = null;
      let certain = true;
      let label: string | null = null;
      let infra: { id: string; lib: string } | null = null;
      let typeKnown = false;

      if (call.pkg !== undefined && !call.root) {
        const p = info.imports.get(call.pkg) ?? call.pkg;
        const dir = pkgDirFor(((call as any).modPath ? (call as any).modPath.join("/") : p));
        if (dir) target = byPkgFunc.get(dir)?.get(call.name) ?? null;
        if (!target && info.lang !== "go") {
          // Rust : crate::module::fonction via un alias importé
          const dir2 = pkgDirFor(p);
          if (dir2) target = byPkgFunc.get(dir2)?.get(call.name) ?? null;
        }
        if (!target && !dir) {
          const id = infraForPath(p);
          if (id && (id !== "http" || info.lang !== "go" || HTTP_CLIENT_CALLS.has(call.name))) infra = { id, lib: p };
          if (id === "sql" && p === "database/sql" && !/^(Open|Query|Exec|QueryRow|Prepare|Begin)/.test(call.name)) infra = null;
          if (p === "net/http") infra = HTTP_CLIENT_CALLS.has(call.name) ? { id: "http", lib: p } : null;
        }
      } else if (call.root) {
        let t: TypeRef | null = call.root;
        let ok = true;
        for (const f of call.chain ?? []) {
          const e: TypeEntry | null = t ? typeEntry(t.name, info) : null;
          const nx: TypeRef | undefined = e?.info.fields.get(f);
          if (!nx) {
            ok = false;
            break;
          }
          t = nx;
        }
        if (ok && t) {
          const ext = infraOfType(t, info);
          if (ext && (ext.id !== "http" || info.lang !== "go" || HTTP_CLIENT_CALLS.has(call.name))) infra = ext;
          const e = typeEntry(t.name, info);
          if (e) typeKnown = true;
          if (e && !t.name.startsWith("?")) {
            const cl = classify(e);
            if (cl?.store) addInfra(rec, cl.store, call.name, t.name);
            (modelUsers.get(t.name) ?? modelUsers.set(t.name, new Set()).get(t.name)!).add(rec.id);
            target = findMethod(t.name, call.ctor && info.lang !== "go" ? "<init>" : call.name);
            if (!target && call.ctor && e.info.annotations.includes("Widget")) target = findMethod(t.name, "build");
            if (!target && /^dispatch(Sync|Now)?$/.test(call.name)) {
              const h = findMethod(t.name, "handle");
              if (h) addEdge(rec.id, h.id, "async", true, "queue");
            }
            if (!target && (e.info.kind === "interface" || e.info.kind === "trait" || e.info.kind === "class" || e.info.kind === "struct")) {
              const impls = [...(implsOf.get(t.name) ?? [])].map((tn) => findMethod(tn, call.name)).filter((x): x is Rec => !!x);
              for (const im of impls) addEdge(rec.id, im.id, "call", false, "DI");
            }
            if (target && (e.info.kind === "interface" || e.info.kind === "trait")) label = null;
          }
        }
      } else if (call.plain) {
        target = byPkgFunc.get(info.pkgKey)?.get(call.name) ?? null;
        if (!target && def.recvType) target = findMethod(def.recvType, call.name);
        if (!target && info.imports.has(call.name)) {
          const p = info.imports.get(call.name)!;
          const dir = pkgDirFor(p.split("::").slice(0, -1).join("::"));
          if (dir) target = byPkgFunc.get(dir)?.get(call.name) ?? null;
        }
      }
      if (!target && !infra && !call.ctor && !typeKnown) {
        const cands = byName.get(call.name) ?? [];
        if (cands.length === 1 && !COMMON.has(call.name) && call.name.length >= 4 && !call.plain) {
          target = cands[0];
          certain = false;
        }
      }
      if (target) addEdge(rec.id, target.id, "call", certain, label);
      if (infra) addInfra(rec, infra.id, call.name, infra.lib);
    }
    // références (handlers passés en argument)
    for (const ref of def.refs) {
      const parts = ref.split(/\.|::/);
      const nm = parts[parts.length - 1];
      let t: Rec | null = null;
      if (parts.length === 1) t = byPkgFunc.get(info.pkgKey)?.get(nm) ?? null;
      else t = (byName.get(nm) ?? []).length === 1 ? byName.get(nm)![0] : null;
      if (t && t !== rec) addEdge(rec.id, t.id, "ref", parts.length === 1);
    }
  }

  // ---- 5. routes / workers déclarés par référence
  const resolveHandler = (h: string, info: FileInfo, recvType?: string): Rec | null => {
    const parts = h.split(/\.|::/);
    const nm = parts[parts.length - 1];
    if (recvType) {
      const m = findMethod(recvType, nm);
      if (m) return m;
    }
    if (parts.length === 1) return byPkgFunc.get(info.pkgKey)?.get(nm) ?? (byName.get(nm)?.length === 1 ? byName.get(nm)![0] : null);
    const c = byName.get(nm) ?? [];
    return c.length === 1 ? c[0] : c.find((r) => r.file === info.rel) ?? null;
  };
  for (const info of infos) {
    const noAuthInfo = /\.Use\([^)]*(auth|jwt|session)/i.test(fs.readFileSync(path.join(root, info.rel), "utf8"));
    for (const rr of info.routeRefs) {
      const r = resolveHandler(rr.handler, info, rr.recvType);
      if (r && !r.route) {
        r.route = { method: rr.method, path: rr.path, auth: null };
        r.entry = "route";
        r.auth = rr.auth;
        (r as any).authUnknown = noAuthInfo || info.lang === "rust";
      }
    }
    for (const wr of info.workerRefs) {
      const r = resolveHandler(wr.handler, info);
      if (r && !r.worker) {
        r.worker = { lib: wr.lib, queue: wr.lib };
        r.entry = "worker";
      }
    }
  }
  for (const rec of S.recs) {
    const { info } = recDef.get(rec)!;
    if (rec.route && rec.entry === "route" && (rec as any).authUnknown === undefined) (rec as any).authUnknown = info.lang === "rust";
    if (rec.route && info.lang === "go" && !rec.auth && /\.Use\([^)]*(auth|jwt|session)/i.test(fs.readFileSync(path.join(root, info.rel), "utf8"))) (rec as any).authUnknown = true;
  }

  // ---- 6. problèmes de sécurité de l'extraction
  const idOfDef = new Map<string, Rec>();
  for (const rec of S.recs) idOfDef.set(`${rec.file}|${recDef.get(rec)!.def.qual}`, rec);
  for (const info of infos) {
    for (const iss of info.issues) {
      const rec = iss.def ? idOfDef.get(`${info.rel}|${iss.def}`) : null;
      S.issues.push({ id: "", severity: iss.severity, category: iss.category, rule: iss.rule, message: iss.message, file: info.rel, line: iss.line, node: rec ? rec.id : `mod:${stripExt(info.rel)}`, source: "cartograph", level: iss.level, params: iss.params });
    }
  }

  // ---- 7. imports entre fichiers (cycles Java/Rust)
  const filesByPkg = new Map<string, FileInfo[]>();
  for (const info of infos) (filesByPkg.get(info.pkgKey) ?? filesByPkg.set(info.pkgKey, []).get(info.pkgKey)!).push(info);
  for (const info of infos) {
    const mod = modOfFile.get(info.rel)!;
    for (const p of info.importPaths) {
      if (info.lang === "java") {
        const cls = p.split(".").pop()!;
        const pkg = p.split(".").slice(0, -1).join(".");
        const target = (types.get(cls) ?? []).find((e) => e.file.pkgKey === pkg);
        if (target && target.file.rel !== info.rel) mod.imports.add(target.file.rel);
      } else if (info.lang === "rust") {
        const dir = pkgDirFor(p.split("::").slice(0, -1).join("::"));
        const f = dir ? filesByPkg.get(dir)?.[0] : undefined;
        if (f && f.rel !== info.rel) mod.imports.add(f.rel);
      }
    }
  }

  // ---- 8. modèles
  const modelList: ModelOut[] = [];
  const modelEdges: ModelsResult["edges"] = [];
  const names = new Map<string, ModelOut>();
  for (const [, entries] of types) {
    for (const e of entries) {
      const t = e.info;
      const anns = t.annotations.join(" ");
      const cl = classify(e);
      const kind = cl?.kind ?? null;
      const store = cl?.store ?? null;
      if (!kind) continue;
      const mod = stripExt(e.file.rel);
      const m: ModelOut = { id: `cls:${mod}:${t.name}`, name: t.name, module: mod, file: e.file.rel, line: t.line, kind, store, fields: t.fieldList.slice(0, 40).map((f) => ({ name: f.name, type: f.type.slice(0, 60), default: null })), nFields: t.fieldList.length, tablename: null, usedBy: [], used: modelUsers.get(t.name) ?? new Set() };
      modelList.push(m);
      names.set(t.name, m);
    }
  }
  for (const m of modelList) {
    for (const f of m.fields) for (const tok of new Set(f.type.match(/[A-Za-z_]\w*/g) ?? [])) {
      const o = names.get(tok);
      if (o && o !== m) modelEdges.push({ source: m.id, target: o.id, label: f.name, kind: "relation" });
    }
  }
  const mr: ModelsResult = { list: modelList, edges: modelEdges, prismaStore: null };
  const out: any = finalize(S, modelList, t0, mr);
  out.lang = "sitter";
  out.metrics.parsed = parsedCount;
  out.metrics.cached = cachedCount;
  void INFRA;
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const root = argv[0];
  const exclude: string[] = [];
  let out: string | undefined;
  let wasm = path.join(__dirname, "grammars");
  let cache: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--exclude") exclude.push(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--wasm") wasm = argv[++i];
    else if (argv[i] === "--cache") cache = argv[++i];
  }
  if (!root) {
    console.error("Usage : analyze_multi <racine> [--exclude dossier] [--out fichier] [--wasm dossier]");
    process.exit(2);
  }
  const result = await analyze(root, exclude, wasm, cache);
  const json = JSON.stringify(result);
  if (out) fs.writeFileSync(out, json, "utf8");
  else process.stdout.write(json);
}

if (require.main === module) main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
