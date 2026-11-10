export type Severity = "error" | "warning" | "info";

export interface Issue {
  id: string;
  severity: Severity;
  category: "security" | "error" | "quality" | "dead" | "duplicate" | "complexity" | "architecture";
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

export interface FnNode {
  id: string;
  kind: "function" | "method" | "module";
  label: string;
  name: string;
  module: string;
  file: string;
  line: number;
  end: number;
  layer: string;
  complexity: number;
  loc: number;
  args: string[];
  async: boolean;
  decorators: string[];
  doc: string;
  entry: string | null;
  route: { method: string; path: string; auth: boolean | null } | null;
  worker: { lib: string; queue: string } | null;
  dead: { confidence: "high" | "low" } | null;
  dup: number | null;
  callers: number;
  callees: number;
  tag?: string | null;
}

export interface GEdge {
  source: string;
  target: string;
  kind: "call" | "ref" | "async" | "uses";
  certain: boolean;
  count: number;
  label: string | null;
}

export interface ModuleInfo {
  id: string;
  name: string;
  file: string;
  layer: string;
  loc: number;
  functions: number;
  classes: number;
  avgComplexity: number;
  isPackage: boolean;
}

export interface ModuleEdge {
  source: string;
  target: string;
  imports: boolean;
  calls: number;
  violation: boolean;
}

export interface Model {
  id: string;
  name: string;
  module: string;
  file: string;
  line: number;
  kind: string;
  store: string | null;
  fields: { name: string; type: string; default: string | null; orm?: boolean }[];
  nFields: number;
  tablename: string | null;
  usedBy: string[];
}

export interface ModelEdge {
  source: string;
  target: string;
  label: string;
  kind: string;
}

export interface Infra {
  id: string;
  label: string;
  type: string;
  libs: string[];
  declared: boolean;
  service: string | null;
  uses: number;
  queue: boolean;
}

export interface SysNode {
  id: string;
  label: string;
  kind: "routes" | "worker" | "entry" | "process" | "infra";
  sub: string;
  members?: string[];
  unit?: "page" | "route";
  ids?: string[];
  file?: string;
  line?: number;
  role?: string;
  declared?: boolean;
  service?: string | null;
  libs?: string[];
  uses?: number;
}

export interface SysEdge {
  source: string;
  target: string;
  kind: "uses" | "async" | "consume" | "broker" | "depends" | "runs" | "http";
  label: string | null;
}

export interface DupGroup {
  kind: "exact" | "similar";
  similarity: number;
  members: string[];
}

export interface Metrics {
  files: number;
  functions: number;
  classes: number;
  loc: number;
  avgComplexity: number;
  dead: number;
  duplicates: number;
  cycles: number;
  routes: number;
  workers: number;
  infra: number;
  models: number;
  securityHigh: number;
  seconds: number;
}

export interface DbColumn {
  name: string;
  type: string;
  pk: boolean;
  nullable: boolean;
  fk: string | null;
}

export interface DbTable {
  name: string;
  rows: number | null;
  columns: DbColumn[];
  indexes: { name: string; unique: boolean }[];
  sampled?: number;
}

export interface DbSchema {
  id: string;
  name: string;
  type: string;
  source: string;
  tables: DbTable[];
  error: string | null;
}

export interface Graph {
  dbSchemas?: DbSchema[];
  version: string;
  root: string;
  generatedAt: number;
  metrics: Metrics;
  nodes: FnNode[];
  edges: GEdge[];
  modules: ModuleInfo[];
  moduleEdges: ModuleEdge[];
  models: Model[];
  modelEdges: ModelEdge[];
  infra: Infra[];
  infraLinks: { source: string; target: string; kind: string; label: string }[];
  system: { nodes: SysNode[]; edges: SysEdge[] };
  issues: Issue[];
  duplicates: DupGroup[];
  cycles: string[][];
  layers: string[];
}

export type ViewId = "system" | "architecture" | "calls" | "data" | "changes" | "quality";

export interface Baseline {
  graph: Graph;
  label: string;
  savedAt: number;
}

export interface CallFilters {
  focus: "all" | "dead" | "dup" | "security" | "complex" | "errors";
  tests: boolean;
  refs: boolean;
  uncertain: boolean;
  infra: boolean;
  modules: boolean;
}

export interface IssueCount {
  error: number;
  warning: number;
  info: number;
  security: number;
}
