// Test de fumée : lance les trois analyseurs sur sample_project et vérifie les résultats essentiels.
// Usage : npm test   (après npm run build)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const tmp = mkdtempSync(join(tmpdir(), "cartograph-test-"));
const sample = "sample_project";

console.log("Fichiers compilés");
for (const f of ["dist/extension.js", "dist/webview.js", "dist/webview.css", "dist/analyze_ts.js", "dist/analyze_multi.js", "dist/grammars/tree-sitter.wasm", "dist/grammars/tree-sitter-go.wasm", "dist/grammars/tree-sitter-php.wasm", "analyzer/analyze.py"])
  check(f, existsSync(f));

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r;
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

console.log("Analyseur Python");
const py = ["python3", "python"].map((c) => ({ c, r: run(c, ["analyzer/analyze.py", sample, "--cache", join(tmp, "py.cache"), "--out", join(tmp, "py.json")]) })).find((x) => x.r.status === 0);
check("s'exécute", !!py, py ? "" : "Python 3.9+ introuvable");
if (py) {
  const g = json(join(tmp, "py.json"));
  check("fonctions détectées", g.metrics.functions >= 30, String(g.metrics.functions));
  check("routes et workers", g.metrics.routes >= 5 && g.metrics.workers >= 2, `${g.metrics.routes} routes, ${g.metrics.workers} workers`);
  check("infrastructure (Redis, MongoDB, Celery)", ["redis", "mongodb", "celery"].every((i) => g.infra.some((x) => x.id === `infra:${i}`)));
  check("failles détectées", g.issues.some((i) => i.category === "security" && i.rule === "sql-injection"));
  const again = run(py.c, ["analyzer/analyze.py", sample, "--cache", join(tmp, "py.cache"), "--out", join(tmp, "py2.json")]);
  check("cache incrémental", again.status === 0 && json(join(tmp, "py2.json")).metrics.parsed === 0);
}

console.log("Analyseur TypeScript / JavaScript");
const ts = run(process.execPath, ["dist/analyze_ts.js", sample, "--out", join(tmp, "ts.json")]);
check("s'exécute", ts.status === 0, ts.stderr.slice(0, 200));
if (ts.status === 0) {
  const g = json(join(tmp, "ts.json"));
  check("fonctions détectées", g.metrics.functions >= 15, String(g.metrics.functions));
  check("routes Next.js et NestJS", g.nodes.some((n) => n.route && n.route.path === "/api/orders") && g.nodes.some((n) => n.route && n.route.path === "/nest-users"));
  check("worker BullMQ", g.metrics.workers >= 1);
  check("injection NestJS (interface → implémentation)", g.edges.some((e) => e.label === "DI"));
}

console.log("Analyseur multi-langages (Go, Java, Kotlin, PHP, Dart, Rust)");
const mu = run(process.execPath, ["dist/analyze_multi.js", sample, "--cache", join(tmp, "mu.json"), "--out", join(tmp, "mu.json.out")]);
check("s'exécute", mu.status === 0, mu.stderr.slice(0, 200));
if (mu.status === 0) {
  const g = json(join(tmp, "mu.json.out"));
  check("fichiers analysés", g.metrics.files >= 20, String(g.metrics.files));
  for (const [label, frag] of [["Go", "go-service"], ["Java", "java-service"], ["Kotlin", "kotlin-service"], ["PHP", "php-service"], ["Dart", "flutter-app"], ["Rust", "rust-service"]])
    check(`${label} : fonctions et routes/pages`, g.nodes.some((n) => n.file.startsWith(frag) && n.route) || (label === "Dart" && g.nodes.some((n) => n.file.startsWith(frag))));
  const again = run(process.execPath, ["dist/analyze_multi.js", sample, "--cache", join(tmp, "mu.json"), "--out", join(tmp, "mu2.json")]);
  check("cache incrémental", again.status === 0 && json(join(tmp, "mu2.json")).metrics.parsed === 0);
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} vérification(s) en échec` : "\nTout est bon.");
process.exit(failed ? 1 : 0);
