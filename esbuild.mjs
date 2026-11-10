import { build, context } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: "info" };

const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
};

const tsAnalyzer = {
  ...common,
  entryPoints: ["src/ts-analyzer/index.ts"],
  outfile: "dist/analyze_ts.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: production,
  logOverride: { "empty-import-meta": "silent" },
};

const multi = {
  ...common,
  entryPoints: ["src/sitter/index.ts"],
  outfile: "dist/analyze_multi.js",
  platform: "node",
  format: "cjs",
  target: "node18",
};

function copyGrammars() {
  mkdirSync("dist/grammars", { recursive: true });
  for (const f of ["tree-sitter-go.wasm", "tree-sitter-java.wasm", "tree-sitter-rust.wasm", "tree-sitter-kotlin.wasm", "tree-sitter-php.wasm"]) copyFileSync(`node_modules/tree-sitter-wasms/out/${f}`, `dist/grammars/${f}`);
  copyFileSync("node_modules/web-tree-sitter/tree-sitter.wasm", "dist/grammars/tree-sitter.wasm");
}

const webview = {
  ...common,
  entryPoints: ["webview/index.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
};

if (watch) {
  for (const cfg of [extension, tsAnalyzer, multi, webview]) {
    const ctx = await context(cfg);
    await ctx.watch();
  }
  copyGrammars();
  console.log("[cartograph] watching…");
} else {
  await Promise.all([build(extension), build(tsAnalyzer), build(multi), build(webview)]);
  copyGrammars();
}
