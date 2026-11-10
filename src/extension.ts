import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { mergeGraphs } from "./merge";
import { TsServer } from "./ts-server";

let panel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;
let lastGraph: any | undefined;
let lastRoot: string | undefined;
let running = false;
let queued = false;
let saveTimer: NodeJS.Timeout | undefined;
let diagTimer: NodeJS.Timeout | undefined;
let warnings: string[] = [];
let tsServer: TsServer | undefined;

// ---------------------------------------------------------------- langue
type Lang = "fr" | "en";
function currentLang(): Lang {
  const c = vscode.workspace.getConfiguration("cartograph").get<string>("language", "auto");
  if (c === "fr" || c === "en") return c;
  return vscode.env.language.toLowerCase().startsWith("fr") ? "fr" : "en";
}
const L = (fr: string, en: string) => (currentLang() === "fr" ? fr : en);

export function activate(ctx: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Cartograph");
  tsServer = new TsServer(path.join(ctx.extensionPath, "dist", "analyze_ts.js"), (s) => output.appendLine(s));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = "$(type-hierarchy) Cartograph";
  status.tooltip = L("Ouvrir la carte du projet", "Open the project map");
  status.command = "cartograph.open";
  status.show();

  ctx.subscriptions.push(
    output,
    status,
    { dispose: () => tsServer?.dispose() },
    vscode.commands.registerCommand("cartograph.open", () => openPanel(ctx)),
    vscode.commands.registerCommand("cartograph.refresh", () => (panel ? runAnalysis(ctx) : openPanel(ctx))),
    vscode.commands.registerCommand("cartograph.saveBaseline", () => saveBaseline(ctx)),
    vscode.commands.registerCommand("cartograph.compareGit", () => compareGit(ctx)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!panel || !["python", "typescript", "typescriptreact", "javascript", "javascriptreact", "go", "java", "rust", "kotlin", "php", "dart"].includes(doc.languageId)) return;
      if (!vscode.workspace.getConfiguration("cartograph").get<boolean>("autoRefresh", true)) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => runAnalysis(ctx), 800);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cartograph.language")) panel?.webview.postMessage({ type: "config", language: currentLang() });
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      if (!panel || !lastGraph) return;
      if (diagTimer) clearTimeout(diagTimer);
      diagTimer = setTimeout(() => postGraph(), 1500);
    })
  );
}

export function deactivate() {
  panel?.dispose();
  tsServer?.dispose();
}

function workspaceRoot(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) return folder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function openPanel(ctx: vscode.ExtensionContext) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage(L("Cartograph : ouvre d'abord un dossier de projet.", "Cartograph: open a project folder first."));
    return;
  }
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    if (lastRoot !== root) runAnalysis(ctx);
    return;
  }
  const dist = vscode.Uri.joinPath(ctx.extensionUri, "dist");
  panel = vscode.window.createWebviewPanel("cartograph", "Cartograph", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [dist],
  });
  panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
  panel.webview.html = html(panel.webview, dist);
  panel.onDidDispose(() => {
    panel = undefined;
  }, null, ctx.subscriptions);
  panel.webview.onDidReceiveMessage(
    (msg) => {
      switch (msg?.type) {
        case "ready":
          panel?.webview.postMessage({ type: "config", language: currentLang() });
          postBaseline(ctx, root);
          if (lastGraph) postGraph();
          else runAnalysis(ctx);
          break;
        case "refresh":
          runAnalysis(ctx);
          break;
        case "setLanguage":
          vscode.workspace.getConfiguration("cartograph").update("language", msg.language === "en" ? "en" : "fr", vscode.ConfigurationTarget.Global);
          break;
        case "open":
          openInEditor(String(msg.file), Number(msg.line) || 1, Number(msg.end) || undefined);
          break;
        case "save":
          saveExport(String(msg.name), String(msg.data), msg.encoding === "dataUrl" ? "dataUrl" : "text");
          break;
        case "notify":
          vscode.window.showWarningMessage(String(msg.message));
          break;
        case "saveBaseline":
          saveBaseline(ctx);
          break;
        case "clearBaseline":
          clearBaseline(ctx);
          break;
        case "compareGit":
          compareGit(ctx);
          break;
      }
    },
    undefined,
    ctx.subscriptions
  );
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `<!DOCTYPE html>
<html lang="${currentLang()}">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${style}" />
<title>Cartograph</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

async function openInEditor(rel: string, line: number, end?: number) {
  const root = lastRoot ?? workspaceRoot();
  if (!root) return;
  const uri = vscode.Uri.file(path.join(root, rel));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = new vscode.Position(Math.max(0, line - 1), 0);
    const stop = new vscode.Position(Math.max(0, (end ?? line) - 1), 0);
    const visible = vscode.window.visibleTextEditors.find((e) => e.viewColumn !== undefined);
    await vscode.window.showTextDocument(doc, { viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside, selection: new vscode.Range(start, start), preserveFocus: false });
    vscode.window.activeTextEditor?.revealRange(new vscode.Range(start, stop), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch {
    vscode.window.showErrorMessage(L(`Cartograph : impossible d'ouvrir ${rel}`, `Cartograph: cannot open ${rel}`));
  }
}

async function saveExport(name: string, data: string, encoding: "text" | "dataUrl") {
  const root = lastRoot ?? workspaceRoot();
  const ext = path.extname(name).slice(1).toLowerCase();
  const filters: Record<string, string[]> = ext === "png" ? { PNG: ["png"] } : ext === "svg" ? { SVG: ["svg"] } : { Markdown: ["md"] };
  const uri = await vscode.window.showSaveDialog({ defaultUri: root ? vscode.Uri.file(path.join(root, name)) : undefined, filters });
  if (!uri) return;
  let bytes: Buffer;
  if (encoding === "dataUrl") {
    const i = data.indexOf(",");
    const meta = data.slice(0, i);
    const body = data.slice(i + 1);
    bytes = meta.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  } else {
    bytes = Buffer.from(data, "utf8");
  }
  await vscode.workspace.fs.writeFile(uri, bytes);
  const open = L("Ouvrir", "Open");
  const pick = await vscode.window.showInformationMessage(L(`Export enregistré : ${path.basename(uri.fsPath)}`, `Export saved: ${path.basename(uri.fsPath)}`), open);
  if (pick) vscode.commands.executeCommand("vscode.open", uri);
}

// ---------------------------------------------------------------- processus
interface PyCandidate {
  cmd: string;
  pre: string[];
}

function pythonCandidates(): PyCandidate[] {
  const configured = vscode.workspace.getConfiguration("cartograph").get<string>("pythonPath", "").trim();
  if (configured) return [{ cmd: configured, pre: [] }];
  if (process.platform === "win32") return [{ cmd: "python", pre: [] }, { cmd: "py", pre: ["-3"] }];
  return [{ cmd: "python3", pre: [] }, { cmd: "python", pre: [] }];
}

interface ProcResult {
  code: number | null;
  out: Buffer;
  err: string;
  missing: boolean;
}

function runProc(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      err += "\n" + L("Délai dépassé (180 s).", "Timed out (180 s).");
    }, 180_000);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, out: Buffer.alloc(0), err: e.message, missing: e.code === "ENOENT" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks), err, missing: false });
    });
  });
}

interface Analysis {
  graph?: any;
  error?: string;
  missing?: boolean;
}

/** Dernière ligne non vide d'une sortie d'erreur : pour une trace Python, c'est l'exception elle-même. */
const lastLine = (err: string) => err.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? err;

const expandEnv = (s: string) => s.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");

async function runPythonAnalysis(ctx: vscode.ExtensionContext, root: string, exclude: string[], useCache: boolean): Promise<Analysis> {
  const analyzer = path.join(ctx.extensionPath, "analyzer", "analyze.py");
  if (!fs.existsSync(analyzer)) return { error: L("analyzer/analyze.py est introuvable dans l'extension.", "analyzer/analyze.py not found in the extension.") };
  const args = [analyzer, root, ...exclude.flatMap((e) => ["--exclude", e])];
  if (useCache) {
    const storage = ctx.globalStorageUri.fsPath;
    try {
      fs.mkdirSync(storage, { recursive: true });
      args.push("--cache", path.join(storage, `py-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)}.cache`));
    } catch {
      /* cache désactivé si le dossier est inaccessible */
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const dbs = vscode.workspace.getConfiguration("cartograph").get<any[]>("databases", []);
  dbs.forEach((d, i) => {
    if (d && d.uri) env[`CARTOGRAPH_DB_${i}`] = JSON.stringify({ name: d.name ?? `db${i}`, type: d.type, uri: expandEnv(String(d.uri)), database: d.database });
  });
  let last = "";
  for (const cand of pythonCandidates()) {
    const res = await runProc(cand.cmd, [...cand.pre, ...args], root, env);
    if (res.missing) {
      last = L(`Interpréteur introuvable : ${cand.cmd}`, `Interpreter not found: ${cand.cmd}`);
      continue;
    }
    if (res.code !== 0) {
      output.appendLine("[python] " + (res.err.trim() || `code ${res.code}`));
      return { error: res.err.trim() || `exit ${res.code}` };
    }
    if (res.err.trim()) output.appendLine("[python] " + res.err.trim());
    try {
      return { graph: JSON.parse(res.out.toString("utf8")) };
    } catch (e) {
      return { error: L("Réponse de l'analyseur Python invalide : ", "Invalid Python analyzer output: ") + String(e) };
    }
  }
  return { error: last, missing: true };
}

async function runTsAnalysis(root: string, exclude: string[]): Promise<Analysis> {
  if (!tsServer) return {};
  try {
    return { graph: await tsServer.analyze(root, exclude) };
  } catch (e: any) {
    output.appendLine("[typescript] " + String(e?.message ?? e));
    return { error: String(e?.message ?? e) };
  }
}

async function runMultiAnalysis(ctx: vscode.ExtensionContext, root: string, exclude: string[], useCache: boolean): Promise<Analysis> {
  const script = path.join(ctx.extensionPath, "dist", "analyze_multi.js");
  if (!fs.existsSync(script)) return {};
  const args = [script, root, ...exclude.flatMap((e) => ["--exclude", e])];
  if (useCache) {
    try {
      fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
      args.push("--cache", path.join(ctx.globalStorageUri.fsPath, `multi-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)}.json`));
    } catch {
      /* cache désactivé */
    }
  }
  const res = await runProc(process.execPath, args, root, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
  if (res.code !== 0) {
    output.appendLine("[tree-sitter] " + (res.err.trim() || `code ${res.code}`));
    return { error: res.err.trim() || `exit ${res.code}` };
  }
  try {
    return { graph: JSON.parse(res.out.toString("utf8")) };
  } catch (e) {
    return { error: String(e) };
  }
}

/** Lance tous les analyseurs sur un dossier et fusionne les résultats. */
async function analyzeRoot(ctx: vscode.ExtensionContext, root: string, useCache: boolean): Promise<{ graph: any | null; warns: string[]; error?: string }> {
  const exclude = vscode.workspace.getConfiguration("cartograph").get<string[]>("exclude", []);
  const [py, tsr, multi] = await Promise.all([runPythonAnalysis(ctx, root, exclude, useCache), runTsAnalysis(root, exclude), runMultiAnalysis(ctx, root, exclude, useCache)]);
  const nPy = py.graph?.metrics?.files ?? 0;
  const nTs = tsr.graph?.metrics?.files ?? 0;
  const nMulti = multi.graph?.metrics?.files ?? 0;
  output.appendLine(`Python ${nPy}, TypeScript/JavaScript ${nTs}, Go/Java/Rust/Kotlin/PHP/Dart ${nMulti} (${py.graph ? `${py.graph.metrics.parsed}/${py.graph.metrics.cached}` : "-"} · ${tsr.graph ? `${tsr.graph.metrics.parsed}/${tsr.graph.metrics.cached}` : "-"})`);
  const warns: string[] = [];
  if (nPy + nTs + nMulti === 0 && (py.error || tsr.error || multi.error)) {
    return { graph: null, warns, error: [py.error, tsr.error, multi.error].filter(Boolean).join("\n\n") };
  }
  if (multi.error && nPy + nTs > 0) warns.push(L("L'analyse multi-langages a échoué : ", "Multi-language analysis failed: ") + lastLine(multi.error) + L(" (détails : Sortie → Cartograph)", " (details: Output → Cartograph)"));
  if (py.error && nTs + nMulti > 0) {
    const hasPy = (await vscode.workspace.findFiles("**/*.py", "**/{node_modules,.venv,venv}/**", 1)).length > 0;
    if (hasPy) warns.push(L("Les fichiers Python n'ont pas pu être analysés : ", "Python files could not be analyzed: ") + lastLine(py.error) + L(" (détails : Sortie → Cartograph)", " (details: Output → Cartograph)"));
  }
  if (tsr.error && nPy > 0) warns.push(L("L'analyse TypeScript/JavaScript a échoué : ", "TypeScript/JavaScript analysis failed: ") + lastLine(tsr.error) + L(" (détails : Sortie → Cartograph)", " (details: Output → Cartograph)"));
  return { graph: mergeGraphs([py.graph, tsr.graph, multi.graph]), warns };
}

async function runAnalysis(ctx: vscode.ExtensionContext) {
  if (!panel) return;
  if (running) {
    queued = true;
    return;
  }
  const root = workspaceRoot();
  if (!root) return;
  running = true;
  lastRoot = root;
  panel.webview.postMessage({ type: "loading" });
  const res = await analyzeRoot(ctx, root, true);
  running = false;
  if (res.error) {
    panel?.webview.postMessage({
      type: "error",
      message: res.error + "\n\n" + L("Vérifie que Python 3.9+ est installé, ou renseigne « cartograph.pythonPath » dans les paramètres.", "Make sure Python 3.9+ is installed, or set “cartograph.pythonPath” in the settings."),
    });
  } else {
    lastGraph = res.graph;
    warnings = res.warns;
    postGraph();
  }
  if (queued) {
    queued = false;
    runAnalysis(ctx);
  }
}

// ---------------------------------------------------------------- état de référence et comparaison Git
const baselineFile = (ctx: vscode.ExtensionContext, root: string) =>
  path.join(ctx.globalStorageUri.fsPath, `baseline-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 12)}.json`);

function postBaseline(ctx: vscode.ExtensionContext, root: string) {
  try {
    const raw = JSON.parse(fs.readFileSync(baselineFile(ctx, root), "utf8"));
    panel?.webview.postMessage({ type: "baseline", data: raw.graph, label: raw.label, savedAt: raw.savedAt });
  } catch {
    panel?.webview.postMessage({ type: "baseline", data: null });
  }
}

function writeBaseline(ctx: vscode.ExtensionContext, root: string, graph: any, label: string) {
  fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
  const savedAt = Math.floor(Date.now() / 1000);
  fs.writeFileSync(baselineFile(ctx, root), JSON.stringify({ label, savedAt, graph }), "utf8");
  panel?.webview.postMessage({ type: "baseline", data: graph, label, savedAt });
}

function saveBaseline(ctx: vscode.ExtensionContext) {
  const root = lastRoot ?? workspaceRoot();
  if (!root || !lastGraph) {
    vscode.window.showWarningMessage(L("Cartograph : ouvre la carte et attends la fin de l'analyse avant d'enregistrer une référence.", "Cartograph: open the map and wait for the analysis before saving a baseline."));
    return;
  }
  writeBaseline(ctx, root, lastGraph, "");
  vscode.window.showInformationMessage(L("État de référence enregistré. Relance l'analyse après tes modifications : l'onglet « Évolution » montrera les différences.", "Baseline saved. Re-run the analysis after your changes: the “Changes” tab will show the differences."));
}

function clearBaseline(ctx: vscode.ExtensionContext) {
  const root = lastRoot ?? workspaceRoot();
  if (root) {
    try {
      fs.unlinkSync(baselineFile(ctx, root));
    } catch {
      /* déjà absent */
    }
  }
  panel?.webview.postMessage({ type: "baseline", data: null });
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await runProc("git", args, cwd);
  if (r.missing) throw new Error(L("Git est introuvable dans le PATH.", "Git was not found in the PATH."));
  if (r.code !== 0) throw new Error(r.err.trim() || `git ${args[0]} : code ${r.code}`);
  return r.out.toString("utf8");
}

async function compareGit(ctx: vscode.ExtensionContext) {
  const root = lastRoot ?? workspaceRoot();
  if (!root) return;
  const ref = await vscode.window.showInputBox({
    prompt: L("Révision Git à comparer (HEAD, branche, tag ou commit)", "Git revision to compare with (HEAD, branch, tag or commit)"),
    value: "HEAD",
  });
  if (!ref) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: L(`Cartograph : analyse de ${ref}…`, `Cartograph: analyzing ${ref}…`) },
    async () => {
      let tmp = "";
      let top = "";
      let wt = "";
      try {
        top = (await git(["rev-parse", "--show-toplevel"], root)).trim();
        const rel = path.relative(top, root);
        const sha = (await git(["rev-parse", "--short", ref], top)).trim();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cartograph-"));
        wt = path.join(tmp, "wt");
        await git(["worktree", "add", "--detach", wt, ref], top);
        const res = await analyzeRoot(ctx, path.join(wt, rel), false);
        if (!res.graph) throw new Error(res.error ?? L("Aucun code trouvé dans cette révision.", "No source code found in this revision."));
        writeBaseline(ctx, root, res.graph, `git ${ref} (${sha})`);
        if (panel && !lastGraph) runAnalysis(ctx);
        vscode.window.showInformationMessage(
          L("Comparaison prête. Les dépendances npm ne sont pas installées dans la révision : l'infrastructure y est reconnue par ses imports uniquement.", "Comparison ready. npm dependencies are not installed in the revision: infrastructure is detected from imports only there.")
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(L("Cartograph : comparaison impossible — ", "Cartograph: comparison failed — ") + String(e?.message ?? e));
      } finally {
        try {
          if (wt) await git(["worktree", "remove", "--force", wt], top);
        } catch {
          /* nettoyage best-effort */
        }
        try {
          if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
          if (top) await git(["worktree", "prune"], top);
        } catch {
          /* nettoyage best-effort */
        }
      }
    }
  );
}

// ---------------------------------------------------------------- diagnostics VS Code (Pylance, Ruff, TypeScript…)
function postGraph() {
  if (!panel || !lastGraph || !lastRoot) return;
  const graph = { ...lastGraph, issues: [...lastGraph.issues, ...collectDiagnostics(lastGraph, lastRoot)] };
  panel.webview.postMessage({ type: "graph", data: graph, warnings });
}

function collectDiagnostics(graph: any, root: string) {
  const byFile = new Map<string, any[]>();
  for (const n of graph.nodes) {
    if (n.kind === "module") continue;
    if (!byFile.has(n.file)) byFile.set(n.file, []);
    byFile.get(n.file)!.push(n);
  }
  const issues: any[] = [];
  let i = 0;
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file" || !/\.(py|tsx?|jsx?|mjs|cjs|go|java|rs|kt|kts|php|dart)$/.test(uri.fsPath)) continue;
    const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (rel.startsWith("..")) continue;
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      const line = d.range.start.line + 1;
      let best: any;
      for (const n of byFile.get(rel) ?? []) {
        if (line >= n.line && line <= n.end && (!best || n.end - n.line < best.end - best.line)) best = n;
      }
      const code = typeof d.code === "object" && d.code ? String(d.code.value) : d.code !== undefined ? String(d.code) : d.source ?? "";
      issues.push({
        id: `diag${i++}`,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
        category: "error",
        rule: code,
        message: d.message.split("\n")[0].slice(0, 220),
        file: rel,
        line,
        node: best ? best.id : null,
        source: d.source ?? "vscode",
        level: null,
      });
      if (issues.length > 1500) return issues;
    }
  }
  return issues;
}
