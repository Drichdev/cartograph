import type * as ts from "typescript";

export interface Issue {
  id: string;
  severity: "error" | "warning" | "info";
  category: string;
  rule: string;
  message: string;
  file: string;
  line: number;
  node: string | null;
  source: string;
  level: "high" | "medium" | "low" | null;
  confidence?: "high" | "low";
  group?: number;
  params?: Record<string, string | number>;
}

export interface Rec {
  id: string;
  kind: "function" | "method" | "module";
  qual: string;
  name: string;
  module: string;
  file: string;
  line: number;
  end: number;
  complexity: number;
  loc: number;
  args: string[];
  async: boolean;
  decorators: string[];
  doc: string;
  exported: boolean;
  tag: string | null;
  route: { method: string; path: string; auth: boolean | null } | null;
  worker: { lib: string; queue: string } | null;
  entry: string | null;
  calls: (ts.CallExpression | ts.NewExpression)[];
  ids: ts.Identifier[];
  toks: number[];
  callees: string[];
  nstmts: number;
  http: { method: string; url: string; line: number }[];
  node?: ts.Node;
  sf: ts.SourceFile;
  auth: boolean;
  dead: { confidence: "high" | "low" } | null;
  dup: number | null;
  callers: number;
  callees2: number;
  defaultExport: boolean;
  authUnknown?: boolean;
  nextApi?: string;
  nextPage?: string;
}

export interface Mod {
  name: string;
  file: string;
  layer: string;
  loc: number;
  top: Rec;
  imports: Set<string>;
  pkgs: Set<string>;
  checker: ts.TypeChecker;
  functions: number;
}

export interface Target {
  rec?: Rec;
  ext?: string;
  cls?: string;
  decl?: ts.Node;
  lib?: boolean;
  impls?: Rec[];
}

export interface Edge {
  source: string;
  target: string;
  kind: "call" | "ref" | "async" | "uses";
  certain: boolean;
  count: number;
  label: string | null;
}

export interface State {
  root: string;
  files: Set<string>;
  recs: Rec[];
  byId: Map<string, Rec>;
  recByKey: Map<string, Rec>;
  ctorKey: Map<string, string>;
  modules: Map<string, Mod>;
  fileToMod: Map<string, Mod>;
  issues: Issue[];
  edges: Map<string, Edge>;
  infraOps: Map<string, Map<string, number>>;
  infraLibs: Map<string, Set<string>>;
  thisAssigns: Map<string, ts.Node[]>;
  pendingRoutes: { node: ts.Node; method: string; path: string; auth: boolean; C: ts.TypeChecker }[];
  pendingWorkers: { node: ts.Node; lib: string; C: ts.TypeChecker }[];
  varDecls: { decl: ts.VariableDeclaration; mod: string; sf: ts.SourceFile }[];
  classDecls: { node: ts.ClassDeclaration | ts.ClassExpression; mod: string; sf: ts.SourceFile; C: ts.TypeChecker }[];
  implsByIface: Map<string, { mod: string; name: string }[]>;
  providers: { provide: ts.Node; useClass: ts.Node; C: ts.TypeChecker }[];
  knownNames: Set<string>;
  modelByKey: Map<string, Set<string>>;
  prismaUse: Map<string, Set<string>>;
  programs: { program: ts.Program; C: ts.TypeChecker; files: string[] }[];
}
