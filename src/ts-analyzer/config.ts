export const VERSION = "0.1.0";

export const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output", "out", "coverage", ".turbo", ".cache", ".vercel",
  ".svelte-kit", "storybook-static", ".venv", "venv", "env", "__pycache__", ".idea", ".vscode", "public", "vendor", ".expo",
]);
export const SRC_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
export const MAX_FILE_BYTES = 1_000_000;

export const TOKEN_LAYER: Record<string, string> = {
  test: "test", tests: "test", spec: "test", e2e: "test", stories: "test", storybook: "test", mocks: "test", __tests__: "test",
  workers: "worker", worker: "worker", jobs: "worker", job: "worker", queues: "worker", queue: "worker", cron: "worker", consumers: "worker", processors: "worker", tasks: "worker",
  app: "route", pages: "route", api: "route", routes: "route", route: "route", router: "route", routers: "route", controllers: "route", controller: "route", endpoints: "route", handlers: "route",
  components: "ui", component: "ui", ui: "ui", screens: "ui", layouts: "ui", views: "ui", widgets: "ui",
  services: "service", service: "service", hooks: "service", store: "service", stores: "service", state: "service", usecases: "service", domain: "service", features: "service", actions: "service",
  repositories: "repository", repository: "repository", repo: "repository", dao: "repository", db: "repository", database: "repository", prisma: "repository", drizzle: "repository",
  mongo: "repository", redis: "repository", cache: "repository", storage: "repository", queries: "repository",
  models: "model", model: "model", entities: "model", entity: "model", schemas: "model", schema: "model", types: "model", dto: "model", dtos: "model", interfaces: "model",
  main: "core", cmd: "core", config: "core", settings: "core", env: "core", auth: "core", middleware: "core", lib: "core", core: "core", providers: "core", context: "core",
  blocs: "service", bloc: "service", cubit: "service", cubits: "service", viewmodels: "service", viewmodel: "service", listeners: "worker", commands: "worker", requests: "model", resources: "model",
  utils: "util", util: "util", helpers: "util", common: "util", shared: "util", tools: "util", constants: "util",
};

export const STRICT_LAYERS: Record<string, number> = { route: 0, ui: 0, service: 2, worker: 2, repository: 3, model: 4 };

export const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "all", "options", "head"]);
export const ROUTE_ROOT_RE = /^(app|router|server|api|route|routes|fastify|express|hono|elysia|[a-z]*Router|[a-z]*Routes?|[a-z]*App|[a-z]*Api)$/;
export const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
export const AUTH_TEXT_RE = /getserversession|auth\(|getauth|currentuser|getuser|getsession|session|jwt|token|clerk|authorization|authenticate|requireauth|withauth|guard|verify/;
export const SECRET_RE = /(password|passwd|pwd|secret|token|api_?key|private_?key|access_?key|auth_?key)/i;
export const SECRET_NAME_EXCLUDE = /(url|uri|path|header|type|name|field|expire|expires|minutes|days|hours|prefix|endpoint|route|label|env|scheme|algorithm)$/i;
export const SECRET_VALUE_RE = /(sk_live_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN (RSA |EC )?PRIVATE KEY-----)/;
export const HOC_NAMES = new Set(["memo", "forwardRef", "observer", "defineEventHandler", "defineComponent", "cache", "asyncHandler", "catchAsync", "withAuth"]);

// id, libellé, type, paquets (suffixe « / » = préfixe de portée)
export const INFRA: [string, string, string, string[]][] = [
  ["redis", "Redis", "cache", ["ioredis", "redis", "@upstash/redis", "@redis/client"]],
  ["mongodb", "MongoDB", "database", ["mongodb", "mongoose", "@typegoose/typegoose"]],
  ["postgres", "PostgreSQL", "database", ["pg", "postgres", "@neondatabase/serverless", "pg-promise", "@vercel/postgres"]],
  ["mysql", "MySQL", "database", ["mysql", "mysql2"]],
  ["sqlite", "SQLite", "database", ["sqlite3", "better-sqlite3", "sqlite", "@libsql/client"]],
  ["sql", "SQL (ORM)", "database", ["prisma", "@prisma/client", "typeorm", "sequelize", "drizzle-orm", "knex", "kysely", "@mikro-orm/"]],
  ["supabase", "Supabase", "database", ["@supabase/supabase-js", "@supabase/ssr"]],
  ["bullmq", "BullMQ", "queue", ["bullmq", "bull", "bee-queue", "agenda"]],
  ["rabbitmq", "RabbitMQ", "broker", ["amqplib", "amqp-connection-manager"]],
  ["kafka", "Kafka", "broker", ["kafkajs"]],
  ["s3", "S3 / stockage objet", "storage", ["@aws-sdk/", "aws-sdk", "minio", "@google-cloud/storage"]],
  ["http", "APIs externes (HTTP)", "external", ["axios", "node-fetch", "got", "undici", "ky", "superagent"]],
  ["elastic", "Elasticsearch", "search", ["@elastic/elasticsearch", "@opensearch-project/opensearch", "meilisearch", "algoliasearch"]],
  ["llm", "LLM / IA", "external", ["openai", "@anthropic-ai/sdk", "ai", "@ai-sdk/", "langchain", "@langchain/", "@google/generative-ai", "ollama"]],
  ["email", "Email (SMTP)", "external", ["nodemailer", "@sendgrid/mail", "resend"]],
  ["stripe", "Stripe", "external", ["stripe"]],
  ["firebase", "Firebase / GCP", "external", ["firebase", "firebase-admin", "@firebase/"]],
  ["websocket", "WebSocket", "external", ["socket.io", "socket.io-client", "ws"]],
  ["scheduler", "Planificateur", "queue", ["node-cron", "node-schedule", "cron"]],
  ["asynq", "Asynq", "queue", ["github.com/hibiken/asynq"]],
  ["kv", "Stockage local", "database", []],
  ["queue", "File de tâches", "queue", []],
  ["cache", "Cache", "cache", []],
];
export const QUEUE_IDS = new Set(["bullmq", "scheduler", "asynq", "queue"]);

export function infraForPackage(pkg: string | null | undefined): string | null {
  if (!pkg) return null;
  for (const [id, , , libs] of INFRA) {
    for (const lib of libs) {
      if (lib.endsWith("/") ? pkg.startsWith(lib) : pkg === lib || pkg.startsWith(lib + "/")) return id;
    }
  }
  return null;
}

export function pkgName(spec: string): string {
  const p = spec.split("/");
  return spec.startsWith("@") ? p.slice(0, 2).join("/") : p[0];
}
