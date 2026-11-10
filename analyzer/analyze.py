#!/usr/bin/env python3
"""Cartograph analyzer.

Analyse statique d'un projet Python (bibliothèque standard uniquement, Python 3.9+)
et production d'un graphe JSON : appels, modules, modèles de données,
infrastructure (Redis, Celery, bases de données...), sécurité, code mort, doublons.

Usage : python analyze.py <racine> [--exclude dossier] [--out fichier.json]
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import pickle
import re
import sys
import time
from collections import Counter, defaultdict

VERSION = "0.1.0"


def _cache_version():
    """Le cache est invalidé dès que le code de l'analyseur change (évite de relire des structures d'une ancienne version)."""
    try:
        with open(os.path.abspath(__file__), "rb") as fh:
            return VERSION + ":" + hashlib.sha1(fh.read()).hexdigest()[:12]
    except OSError:
        return VERSION + ":dev"


CACHE_VERSION = _cache_version()

IGNORE_DIRS = {
    ".git", ".hg", ".svn", ".venv", "venv", "env", ".env", "node_modules", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", "dist", "build", "site-packages",
    ".idea", ".vscode", "out", "migrations", "alembic",
}
MAX_FILE_BYTES = 1_500_000

LAYER_TOKENS = [
    ("test", {"test", "tests", "testing", "conftest"}),
    ("worker", {"worker", "workers", "tasks", "task", "jobs", "job", "celery", "consumers", "consumer", "scheduler", "cron"}),
    ("route", {"route", "routes", "router", "routers", "api", "endpoints", "endpoint", "controllers", "controller", "views", "handlers"}),
    ("service", {"service", "services", "usecases", "usecase", "domain", "business", "managers", "manager"}),
    ("repository", {"repository", "repositories", "repo", "repos", "dao", "crud", "db", "database", "storage", "persistence"}),
    ("model", {"model", "models", "schema", "schemas", "entities", "entity", "tables", "dto", "dtos"}),
    ("core", {"core", "config", "settings", "security", "auth", "deps", "dependencies", "middleware", "main", "lib"}),
    ("util", {"utils", "util", "helpers", "helper", "common", "shared", "tools"}),
]
LAYER_ORDER = ["route", "worker", "service", "repository", "model", "core", "util", "other", "test"]
STRICT_LAYERS = {"route": 0, "service": 2, "worker": 2, "repository": 3, "model": 4}

HTTP = {"get", "post", "put", "delete", "patch", "options", "head", "websocket", "route", "api_route"}
WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}
ROUTE_CTORS = {"FastAPI", "APIRouter", "Flask", "Blueprint", "Sanic", "Quart", "Router", "Namespace", "Starlette", "Api"}
TASK_DECOS = {"task", "shared_task", "periodic_task", "actor", "job"}
HANDLER_DECOS = {
    "on_event", "exception_handler", "middleware", "errorhandler", "before_request", "after_request",
    "teardown_request", "teardown_appcontext", "command", "callback", "listener", "receiver", "fixture",
    "validator", "field_validator", "model_validator", "root_validator", "event", "hybrid_property",
    "asynccontextmanager", "context_processor", "template_filter", "cli", "group",
}
CELERY_STYLE = {"delay", "apply_async", "s", "si", "signature"}
ASYNC_DISPATCH = {
    "add_task": "BackgroundTasks", "enqueue": "RQ", "enqueue_call": "RQ", "submit": "Executor",
    "run_in_executor": "Executor", "add_job": "Planificateur", "send_task": "Celery",
}
COMMON_METHODS = {
    "get", "set", "add", "append", "extend", "update", "pop", "remove", "items", "keys", "values", "join",
    "split", "strip", "replace", "format", "read", "write", "close", "open", "copy", "clear", "sort", "count",
    "index", "find", "insert", "startswith", "endswith", "encode", "decode", "lower", "upper", "run", "start",
    "stop", "send", "put", "delete", "post", "patch", "execute", "commit", "connect", "load", "dump", "dumps",
    "loads", "next", "wait", "result", "submit", "exists", "save", "info", "debug", "warning", "error",
}
SECRET_RE = re.compile(r"(password|passwd|pwd|secret|token|api_?key|private_?key|access_?key|auth_?key)", re.I)
SECRET_NAME_EXCLUDE = re.compile(r"(url|uri|path|header|type|name|field|expire|expires|minutes|days|hours|prefix|endpoint|route|label|env|scheme|algorithm)$", re.I)
AUTH_RE = re.compile(r"auth|user|token|jwt|login|permission|security|role|admin|current|session|apikey|api_key", re.I)
SQL_RE = re.compile(r"\b(select|insert|update|delete|drop|where|from|values)\b", re.I)

# id, libellé, type, bibliothèques
INFRA_SPECS = [
    ("redis", "Redis", "cache", ["redis", "aioredis"]),
    ("mongodb", "MongoDB", "database", ["pymongo", "motor", "beanie", "mongoengine", "odmantic"]),
    ("postgres", "PostgreSQL", "database", ["psycopg2", "psycopg", "asyncpg", "pg8000"]),
    ("mysql", "MySQL", "database", ["pymysql", "mysql", "aiomysql", "MySQLdb"]),
    ("sqlite", "SQLite", "database", ["sqlite3", "aiosqlite"]),
    ("sql", "SQL (ORM)", "database", ["sqlalchemy", "sqlmodel", "databases", "tortoise", "peewee", "django.db"]),
    ("celery", "Celery", "queue", ["celery"]),
    ("rq", "RQ", "queue", ["rq"]),
    ("dramatiq", "Dramatiq", "queue", ["dramatiq"]),
    ("arq", "arq", "queue", ["arq"]),
    ("rabbitmq", "RabbitMQ", "broker", ["pika", "aio_pika", "kombu"]),
    ("kafka", "Kafka", "broker", ["kafka", "aiokafka", "confluent_kafka"]),
    ("s3", "S3 / stockage objet", "storage", ["boto3", "aioboto3", "botocore", "minio"]),
    ("http", "APIs externes (HTTP)", "external", ["requests", "httpx", "aiohttp", "urllib3", "urllib.request"]),
    ("elastic", "Elasticsearch", "search", ["elasticsearch", "opensearchpy"]),
    ("vector", "Base vectorielle", "database", ["chromadb", "qdrant_client", "pinecone", "faiss", "weaviate", "lancedb"]),
    ("llm", "LLM / IA", "external", ["openai", "anthropic", "ollama", "langchain", "litellm", "llama_cpp", "transformers"]),
    ("email", "Email (SMTP)", "external", ["smtplib", "sendgrid", "aiosmtplib", "yagmail"]),
    ("scheduler", "Planificateur", "queue", ["apscheduler", "schedule"]),
    ("firebase", "Firebase / GCP", "external", ["firebase_admin", "google.cloud"]),
    ("stripe", "Stripe", "external", ["stripe"]),
]
INFRA_BY_ID = {i[0]: i for i in INFRA_SPECS}
QUEUE_IDS = {"celery", "rq", "dramatiq", "arq"}
MODEL_BASES = {
    "BaseModel": "pydantic", "BaseSettings": "settings", "SQLModel": "pydantic", "Document": "odm",
    "EmbeddedDocument": "odm", "Base": "orm", "DeclarativeBase": "orm", "Model": "orm",
    "TypedDict": "typeddict", "NamedTuple": "namedtuple", "Struct": "struct",
}
IMAGE_TO_INFRA = [
    ("redis", "redis"), ("mongo", "mongodb"), ("postgres", "postgres"), ("mysql", "mysql"), ("mariadb", "mysql"),
    ("rabbitmq", "rabbitmq"), ("kafka", "kafka"), ("elasticsearch", "elastic"), ("opensearch", "elastic"),
    ("minio", "s3"), ("qdrant", "vector"), ("chroma", "vector"),
]


# --------------------------------------------------------------------------- helpers
def dotted(node):
    """a.b.c -> 'a.b.c' ; base non nominale -> '?.c' ; sinon None."""
    parts = []
    while True:
        if isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        elif isinstance(node, (ast.Subscript, ast.Await)):
            node = node.value
        elif isinstance(node, ast.Call):
            inner = dotted(node.func)
            if inner and not inner.startswith("?."):
                parts.append(inner + "()")
                return ".".join(reversed(parts))
            break
        else:
            break
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    if parts:
        return "?." + ".".join(reversed(parts))
    return None


def value_base(value):
    while isinstance(value, ast.Await):
        value = value.value
    if isinstance(value, ast.Call):
        return dotted(value.func)
    return dotted(value)


def top(counter, n=3):
    """Éléments les plus fréquents, ordre stable en cas d'égalité."""
    return [k for k, _ in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def safe_unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return ""


def const_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def cyclomatic(fn):
    c = 1
    for n in ast.walk(fn):
        if isinstance(n, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.IfExp, ast.ExceptHandler)):
            c += 1
        elif isinstance(n, ast.BoolOp):
            c += len(n.values) - 1
        elif isinstance(n, ast.comprehension):
            c += 1 + len(n.ifs)
        elif hasattr(ast, "match_case") and isinstance(n, getattr(ast, "match_case")):
            c += 1
    return c


def norm_tokens(fn):
    body = list(fn.body)
    if body and isinstance(body[0], ast.Expr) and const_str(getattr(body[0], "value", None)) is not None:
        body = body[1:]
    toks, callees = [], []
    for st in body:
        for n in ast.walk(st):
            toks.append(type(n).__name__)
            if isinstance(n, ast.Call):
                f = n.func
                callees.append(f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "?"))
    return toks, callees, len(body)


def classify_layer(rel):
    stem = rel[:-3] if rel.endswith(".py") else rel
    tokens = [t for t in re.split(r"[/_.\-]", stem.lower()) if t]
    if tokens and tokens[-1].startswith("test") or (tokens and tokens[0] == "test"):
        return "test"
    for tok in reversed(tokens):
        for layer, words in LAYER_TOKENS:
            if tok in words:
                return layer
    return "other"


def is_dynamic_sql(arg):
    if isinstance(arg, ast.JoinedStr):
        text = " ".join(v.value for v in arg.values if isinstance(v, ast.Constant) and isinstance(v.value, str))
        return any(isinstance(v, ast.FormattedValue) for v in arg.values) and bool(SQL_RE.search(text))
    if isinstance(arg, ast.BinOp) and isinstance(arg.op, (ast.Mod, ast.Add)):
        sides = [arg.left, arg.right]
        text = " ".join(const_str(s) or "" for s in sides)
        has_dyn = any(const_str(s) is None for s in sides)
        return has_dyn and bool(SQL_RE.search(text))
    if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Attribute) and arg.func.attr == "format":
        base = const_str(arg.func.value)
        return base is not None and bool(SQL_RE.search(base))
    return False


# --------------------------------------------------------------------------- état par fichier (cache)
class FileState:
    """Résultats du visiteur pour UN fichier : sérialisable, donc réutilisable d'une analyse à l'autre."""

    def __init__(self):
        self.funcs = {}
        self.classes = {}
        self.issues = []
        self.route_objs = {}
        self.route_obj_names = set()
        self.global_deps = False
        self.strings = set()


# --------------------------------------------------------------------------- visiteur AST
class Visitor(ast.NodeVisitor):
    def __init__(self, A, mod):
        self.A = A
        self.m = mod
        self.cls = []
        self.fn = None

    def cur(self):
        return self.fn or self.m["top"]

    def issue(self, sev, cat, rule, msg, node, level=None, params=None):
        rec = self.cur()
        self.A.issues.append({
            "severity": sev, "category": cat, "rule": rule, "message": msg, "level": level, "params": params or {},
            "file": self.m["file"], "line": getattr(node, "lineno", 1), "node": rec["id"], "source": "cartograph",
        })

    # ---- imports
    def visit_Import(self, node):
        for a in node.names:
            if a.asname:
                self.m["imports"][a.asname] = a.name
                alias = a.asname
            else:
                root = a.name.split(".")[0]
                self.m["imports"][root] = root
                alias = root
            self.m["import_full"].append(a.name)
            self.m["import_lines"].append((alias, node.lineno, a.name))

    def visit_ImportFrom(self, node):
        if node.level:
            pkg = self.m["name"].split(".") if self.m["is_pkg"] else self.m["name"].split(".")[:-1]
            up = node.level - 1
            if up:
                pkg = pkg[:-up] if up <= len(pkg) else []
            parts = pkg + (node.module.split(".") if node.module else [])
        else:
            parts = node.module.split(".") if node.module else []
        base = ".".join(parts)
        for a in node.names:
            if a.name == "*":
                continue
            full = (base + "." + a.name) if base else a.name
            alias = a.asname or a.name
            self.m["imports"][alias] = full
            self.m["import_full"].append(full)
            self.m["import_lines"].append((alias, node.lineno, full))
        if node.module == "__future__":
            self.m["future"] = True

    # ---- classes
    def visit_ClassDef(self, node):
        qual = ".".join(self.cls + [node.name])
        fields, tablename = [], None
        for st in node.body:
            if isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
                fields.append({
                    "name": st.target.id, "type": safe_unparse(st.annotation)[:80],
                    "default": safe_unparse(st.value)[:50] if st.value is not None else None,
                })
            elif isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
                n = st.targets[0].id
                if n == "__tablename__":
                    tablename = const_str(st.value)
                elif isinstance(st.value, ast.Call) and not n.startswith("__"):
                    fields.append({"name": n, "type": safe_unparse(st.value)[:70], "default": None, "orm": True})
        rec = {
            "id": f"cls:{self.m['name']}:{qual}", "module": self.m["name"], "qual": qual, "name": node.name,
            "file": self.m["file"], "line": node.lineno, "end": getattr(node, "end_lineno", node.lineno),
            "bases": [dotted(b) for b in node.bases],
            "table_kw": any(k.arg == "table" and isinstance(k.value, ast.Constant) and k.value.value is True for k in node.keywords),
            "decorators": [self._deco_name(d) for d in node.decorator_list],
            "fields": fields, "tablename": tablename,
        }
        self.m["classes"][qual] = rec
        self.A.classes[(self.m["name"], qual)] = rec
        for d in node.decorator_list:
            self.visit(d)
        for b in node.bases:
            self.visit(b)
        for k in node.keywords:
            self.visit(k)
        self.cls.append(node.name)
        for st in node.body:
            self.visit(st)
        self.cls.pop()

    @staticmethod
    def _deco_name(d):
        base = d.func if isinstance(d, ast.Call) else d
        return dotted(base) or "?"

    # ---- fonctions
    def visit_FunctionDef(self, node):
        self._func(node)

    def visit_AsyncFunctionDef(self, node):
        self._func(node)

    def _func(self, node):
        if self.fn is not None:  # fonction imbriquée : rattachée à la fonction parente
            self.generic_visit(node)
            return
        for d in node.decorator_list:
            self.visit(d)
        cls_qual = ".".join(self.cls) or None
        qual = ".".join(self.cls + [node.name])
        decos = []
        for d in node.decorator_list:
            info = {"name": self._deco_name(d), "args": [], "kw": {}}
            if isinstance(d, ast.Call):
                info["args"] = [const_str(a) for a in d.args[:2]]
                for k in d.keywords:
                    if k.arg == "methods" and isinstance(k.value, (ast.List, ast.Tuple)):
                        info["kw"]["methods"] = [const_str(e) for e in k.value.elts]
                    elif k.arg:
                        info["kw"][k.arg] = const_str(k.value)
            decos.append(info)
        a = node.args
        allargs = a.posonlyargs + a.args + a.kwonlyargs
        pos = a.posonlyargs + a.args
        defaults = list(zip(pos[len(pos) - len(a.defaults):], a.defaults))
        defaults += [(k, d) for k, d in zip(a.kwonlyargs, a.kw_defaults) if d is not None]
        rec = {
            "id": f"fn:{self.m['name']}:{qual}", "module": self.m["name"], "qual": qual, "name": node.name,
            "cls": cls_qual, "file": self.m["file"], "line": node.lineno,
            "end": getattr(node, "end_lineno", node.lineno), "decos": decos,
            "async": isinstance(node, ast.AsyncFunctionDef), "calls": [], "refs": set(),
            "args": [x.arg for x in allargs if x.arg not in ("self", "cls")], "deps": [], "returns": [],
            "arg_types": {x.arg: dotted(x.annotation) for x in allargs if isinstance(x.annotation, (ast.Name, ast.Attribute))},
            "dep_params": {}, "ret_ann": dotted(node.returns) if isinstance(node.returns, (ast.Name, ast.Attribute)) else None,
            "complexity": cyclomatic(node),
        }
        rec["loc"] = rec["end"] - rec["line"] + 1
        rec["doc"] = (ast.get_docstring(node) or "").strip().split("\n")[0][:140]
        toks, callees, nstmts = norm_tokens(node)
        rec["toks"], rec["callees"], rec["nstmts"] = toks, callees, nstmts
        self.A.funcs[rec["id"]] = rec
        self.m["funcs"][qual] = rec
        for arg, d in defaults:
            if isinstance(d, (ast.List, ast.Dict, ast.Set)) or (isinstance(d, ast.Call) and dotted(d.func) in ("list", "dict", "set")):
                self.fn = rec
                self.issue("warning", "quality", "mutable-default", f"Argument « {arg.arg} » avec valeur par défaut mutable", d, params={"arg": arg.arg})
                self.fn = None
            if isinstance(d, ast.Call):
                dn = dotted(d.func) or ""
                if dn.split(".")[-1] in ("Depends", "Security"):
                    dep = (dotted(d.args[0]) if d.args else "") or ""
                    rec["deps"].append((dn.split(".")[-1], dep))
                    rec["dep_params"][arg.arg] = dep
        # FastAPI moderne : param: Annotated[Type, Depends(fn)]
        for x in allargs:
            ann = x.annotation
            if isinstance(ann, ast.Subscript) and (dotted(ann.value) or "").split(".")[-1] == "Annotated":
                elts = ann.slice.elts if isinstance(ann.slice, ast.Tuple) else []
                t0 = dotted(elts[0]) if elts and isinstance(elts[0], (ast.Name, ast.Attribute)) else None
                if t0:
                    rec["arg_types"][x.arg] = t0
                for e in elts[1:]:
                    if isinstance(e, ast.Call) and (dotted(e.func) or "").split(".")[-1] in ("Depends", "Security"):
                        dep = (dotted(e.args[0]) if e.args else "") or ""
                        rec["deps"].append((dotted(e.func).split(".")[-1], dep))
                        rec["dep_params"][x.arg] = dep or (t0 or "")
        self.fn = rec
        for _, d in defaults:
            self.visit(d)
        for arg in allargs + [x for x in (a.vararg, a.kwarg) if x]:
            if arg.annotation is not None:
                self.visit(arg.annotation)
        if node.returns is not None:
            self.visit(node.returns)
        for st in node.body:
            self.visit(st)
        self.fn = None

    # ---- appels / références
    def visit_Call(self, node):
        rec = self.cur()
        name = dotted(node.func)
        info = {
            "name": name, "line": node.lineno,
            "args": [dotted(x) for x in node.args[:3]],
            "kw": {k.arg: dotted(k.value) for k in node.keywords if k.arg},
        }
        last = name.split(".")[-1] if name else ""
        if last in ("Celery", "RedisBroker", "RabbitmqBroker", "Queue", "Worker"):
            info["src"] = safe_unparse(node)[:400].lower()
        rec["calls"].append(info)
        if any(k.arg == "dependencies" for k in node.keywords):
            self.A.global_deps = True
        self._security_call(node, name or "", last)
        self.generic_visit(node)

    def visit_Return(self, node):
        if self.fn is not None and node.value is not None:
            self.fn["returns"].append(value_base(node.value))
        self.generic_visit(node)

    def visit_Yield(self, node):
        if self.fn is not None and node.value is not None:
            self.fn["returns"].append(value_base(node.value))
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.cur()["refs"].add(node.id)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Load):
            d = dotted(node)
            if d and not d.startswith("?."):
                self.cur()["refs"].add(d)
        self.generic_visit(node)

    def visit_Assign(self, node):
        self._assign(node.targets, node.value, node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self._assign([node.target], node.value, node)
        self.generic_visit(node)

    def _assign(self, targets, value, node):
        base = value_base(value)
        for t in targets:
            tn = dotted(t) if isinstance(t, (ast.Name, ast.Attribute)) else None
            if not tn or tn.startswith("?."):
                continue
            if tn.startswith("self.") and tn.count(".") != 1:
                continue
            self.m["assigns"].append({
                "target": tn, "base": base, "cls": ".".join(self.cls) or None,
                "func": self.fn["id"] if self.fn else None, "line": node.lineno,
            })
            if isinstance(value, ast.Call) and base and base.split(".")[-1] in ROUTE_CTORS:
                prefix = ""
                for k in value.keywords:
                    if k.arg in ("prefix", "url_prefix"):
                        prefix = const_str(k.value) or ""
                self.A.route_objs[(self.m["name"], tn)] = prefix
                self.A.route_obj_names.add(tn)
            sv = const_str(value)
            last = tn.split(".")[-1]
            if sv and len(sv) >= 6 and SECRET_RE.search(last) and not SECRET_NAME_EXCLUDE.search(last) \
                    and not sv.startswith(("/", "http", "<", "${", "your", "Your")) and "://" not in sv:
                self.issue("warning", "security", "hardcoded-secret", f"Secret potentiellement codé en dur dans « {last} »", node, "medium", {"name": last})

    def visit_ExceptHandler(self, node):
        if node.type is None:
            self.issue("warning", "quality", "bare-except", "« except: » nu — capture une exception précise", node)
        swallowed = all(
            isinstance(s, (ast.Pass, ast.Continue)) or (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))
            for s in node.body
        )
        if swallowed:
            self.issue("warning", "quality", "swallowed-exception", "Exception ignorée silencieusement", node)
        self.generic_visit(node)

    # ---- sécurité
    def _security_call(self, node, n, last):
        kw = {k.arg: k.value for k in node.keywords if k.arg}

        def is_const(k, val):
            v = kw.get(k)
            return isinstance(v, ast.Constant) and v.value is val

        def sec(level, rule, msg, **params):
            self.issue({"high": "error", "medium": "warning", "low": "info"}[level], "security", rule, msg, node, level, params)

        if n in ("eval", "exec"):
            sec("high", "dangerous-eval", f"Exécution dynamique de code ({n})", fn=n)
        elif n in ("pickle.loads", "pickle.load", "marshal.loads", "dill.loads", "cPickle.loads"):
            sec("medium", "unsafe-deserialization", "Désérialisation non sûre (pickle/marshal)")
        elif n in ("os.system", "os.popen"):
            sec("high", "shell-exec", f"Commande shell ({n})", fn=n)
        elif n.startswith("subprocess.") and is_const("shell", True):
            sec("high", "shell-true", "subprocess avec shell=True")
        elif n == "yaml.load" and "Loader" not in kw and len(node.args) < 2:
            sec("medium", "yaml-load", "yaml.load sans Loader sûr (utiliser safe_load)")
        elif n in ("hashlib.md5", "hashlib.sha1"):
            sec("low", "weak-hash", f"Algorithme de hachage faible ({n.split('.')[-1]})", algo=n.split('.')[-1])
        elif n == "tempfile.mktemp":
            sec("low", "mktemp", "tempfile.mktemp est vulnérable aux collisions")
        if last in ("get", "post", "put", "delete", "request", "patch", "head") and is_const("verify", False):
            sec("medium", "tls-verify-off", "Vérification TLS désactivée (verify=False)")
        if last == "run" and is_const("debug", True):
            sec("medium", "debug-on", "Mode debug activé")
        if last in ("execute", "executemany", "executescript", "raw", "text", "query", "fetch", "fetchrow", "fetchall") \
                and node.args and is_dynamic_sql(node.args[0]):
            sec("high", "sql-injection", "Requête SQL construite dynamiquement (injection possible)")
        ao = kw.get("allow_origins")
        if isinstance(ao, (ast.List, ast.Tuple)) and any(const_str(e) == "*" for e in ao.elts):
            sec("medium", "cors-wildcard", "CORS ouvert à toutes les origines (*)")
        if last == "decode" and ("jwt" in n.lower()):
            opts = kw.get("options")
            if is_const("verify", False) or (isinstance(opts, ast.Dict) and any(
                    const_str(k) == "verify_signature" and isinstance(v, ast.Constant) and v.value is False
                    for k, v in zip(opts.keys, opts.values))):
                sec("high", "jwt-no-verify", "Signature JWT non vérifiée")
        for k, v in kw.items():
            sv = const_str(v)
            if sv and len(sv) >= 6 and SECRET_RE.search(k) and not SECRET_NAME_EXCLUDE.search(k) and "://" not in sv:
                sec("medium", "hardcoded-secret", f"Secret codé en dur dans l'argument « {k} »", name=k)


# --------------------------------------------------------------------------- analyse
class Analyzer:
    def __init__(self, root, exclude, cache_path=None):
        self.root = os.path.abspath(root)
        self.cache_path = cache_path
        self.parsed = 0
        self.cached = 0
        self.errors = 0
        self.exclude = set(IGNORE_DIRS) | set(exclude)
        self.modules = {}
        self.funcs = {}
        self.classes = {}
        self.issues = []
        self.route_objs = {}
        self.route_obj_names = set()
        self.global_deps = False
        self.all_strings = set()
        self.edges = {}
        self.infra_ops = defaultdict(Counter)
        self.infra_libs = defaultdict(set)
        self.mod_clients = {}
        self.self_clients = {}
        self.local_clients = {}
        self.mod_inst, self.self_inst, self.local_inst = {}, {}, {}
        self.func_returns = {}
        self.func_ret_class = {}
        self.class_users = defaultdict(set)
        self.methods_by_name = defaultdict(list)
        self.async_targets = {}
        self.processes = []
        self.compose_infra = {}
        self.extra_infra_edges = []

    # ---------------------------------------------------------------- chargement
    def iter_files(self):
        for dp, dn, fn in os.walk(self.root):
            dn[:] = sorted(d for d in dn if d not in self.exclude and not d.endswith(".egg-info"))
            for f in sorted(fn):
                if f.endswith(".py"):
                    yield os.path.join(dp, f)

    def load_cache(self):
        if not self.cache_path or not os.path.isfile(self.cache_path):
            return {}
        try:
            with open(self.cache_path, "rb") as fh:
                data = pickle.load(fh)
            if data.get("version") == CACHE_VERSION:
                return data.get("files", {})
        except Exception:
            pass
        return {}

    def save_cache(self, files):
        if not self.cache_path:
            return
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.cache_path)), exist_ok=True)
            tmp = self.cache_path + ".tmp"
            with open(tmp, "wb") as fh:
                pickle.dump({"version": CACHE_VERSION, "files": files}, fh, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp, self.cache_path)
        except Exception:
            pass

    def load(self):
        entries = []
        for path in self.iter_files():
            rel = os.path.relpath(path, self.root).replace(os.sep, "/")
            try:
                st = os.stat(path)
            except OSError:
                continue
            if st.st_size > MAX_FILE_BYTES:
                continue
            parts = rel[:-3].split("/")
            is_pkg = parts[-1] == "__init__"
            if is_pkg:
                parts = parts[:-1]
            entries.append((path, rel, ".".join(parts) or "__init__", is_pkg, st))
        # disposition « src/ » : on retire le préfixe
        strip = bool(entries) and sum(1 for e in entries if e[2].startswith("src.")) > len(entries) / 2
        old_cache = self.load_cache()
        new_cache = {}
        for path, rel, name, is_pkg, st in entries:
            if strip and name.startswith("src."):
                name = name[4:]
            key = (st.st_size, st.st_mtime_ns, strip, CACHE_VERSION)
            blob = None
            hit = old_cache.get(rel)
            if hit and hit[0] == key:
                blob = hit[1]
                self.cached += 1
            else:
                blob = self.parse_file(path, rel, name, is_pkg)
                self.parsed += 1
            new_cache[rel] = (key, blob)
            mod, state = pickle.loads(blob)
            if mod is not None:
                self.modules[name] = mod
            self.funcs.update(state.funcs)
            self.classes.update(state.classes)
            self.issues.extend(state.issues)
            self.route_objs.update(state.route_objs)
            self.route_obj_names |= state.route_obj_names
            self.global_deps = self.global_deps or state.global_deps
            self.all_strings |= state.strings
        self.save_cache(new_cache)

    def parse_file(self, path, rel, name, is_pkg):
        """Analyse un fichier et renvoie (module, état) sérialisés."""
        state = FileState()
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                src = fh.read()
            tree = ast.parse(src, filename=rel)
        except SyntaxError as e:
            state.issues.append({
                "severity": "error", "category": "error", "rule": "syntax-error",
                "message": f"Erreur de syntaxe : {e.msg}", "params": {"msg": e.msg}, "file": rel, "line": e.lineno or 1,
                "node": None, "source": "cartograph", "level": None,
            })
            return pickle.dumps((None, state), protocol=pickle.HIGHEST_PROTOCOL)
        except (OSError, ValueError, RecursionError, MemoryError):
            return pickle.dumps((None, state), protocol=pickle.HIGHEST_PROTOCOL)
        mod = {
            "name": name, "file": rel, "is_pkg": is_pkg, "layer": classify_layer(rel), "src": src,
            "loc": sum(1 for ln in src.splitlines() if ln.strip() and not ln.strip().startswith("#")),
            "imports": {}, "import_full": [], "import_lines": [], "funcs": {}, "classes": {}, "assigns": [],
            "top": {"id": f"mod:{name}", "module": name, "qual": "<module>", "calls": [], "refs": set(), "cls": None},
        }
        try:
            Visitor(state, mod).visit(tree)
        except Exception as e:  # noqa: BLE001
            state = FileState()
            state.issues.append({
                "severity": "warning", "category": "error", "rule": "analyzer-error",
                "message": f"Analyse impossible de ce fichier : {type(e).__name__}: {e}", "params": {"msg": f"{type(e).__name__}: {e}"},
                "file": rel, "line": 1, "node": None, "source": "cartograph", "level": None,
            })
            return pickle.dumps((None, state), protocol=pickle.HIGHEST_PROTOCOL)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and len(node.value) < 80:
                state.strings.add(node.value)
        return pickle.dumps((mod, state), protocol=pickle.HIGHEST_PROTOCOL)

    # ---------------------------------------------------------------- résolution de symboles
    def full_of(self, mod, name):
        parts = name.split(".")
        imp = mod["imports"].get(parts[0])
        if imp is None:
            return None
        return ".".join([imp] + parts[1:])

    def module_prefix(self, full):
        parts = full.split(".")
        for k in range(len(parts), 0, -1):
            n = ".".join(parts[:k])
            if n in self.modules:
                return n, parts[k:]
        return None, parts

    def lookup_project(self, full, depth=0):
        mname, rest = self.module_prefix(full)
        if mname is None:
            return None
        m = self.modules[mname]
        if not rest:
            return ("mod", mname)
        qual = ".".join(rest)
        if qual in m["funcs"]:
            return ("fn", m["funcs"][qual]["id"])
        if qual in m["classes"]:
            return ("cls", (mname, qual))
        if rest[0] in m["imports"] and depth < 5:
            nf = ".".join([m["imports"][rest[0]]] + rest[1:])
            if nf != full:
                return self.lookup_project(nf, depth + 1)
        return None

    def find_method(self, mname, cls_qual, meth, depth=0):
        m = self.modules.get(mname)
        if m is None:
            return None
        q = cls_qual + "." + meth
        if q in m["funcs"]:
            return m["funcs"][q]["id"]
        c = self.classes.get((mname, cls_qual))
        if c and depth < 6:
            for b in c["bases"]:
                if not b:
                    continue
                r = self.resolve_class(m, b)
                if r:
                    f = self.find_method(r[0], r[1], meth, depth + 1)
                    if f:
                        return f
        return None

    def resolve_class(self, mod, name):
        r = self.lookup_project(mod["name"] + "." + name)
        if not r or r[0] != "cls":
            full = self.full_of(mod, name)
            r = self.lookup_project(full) if full else None
        return r[1] if r and r[0] == "cls" else None

    def resolve_root_class(self, mod, name):
        return self.resolve_class(mod, name.split(".")[0]) if name and not name.startswith("?.") else None

    def resolve(self, mod, cls, name, func_id=None):
        if not name:
            return None
        if name.startswith("?."):
            return ("method", name.split(".")[-1], False)
        parts = name.split(".")
        root = parts[0]
        if len(parts) >= 2 and "(" not in name:
            ck = self.instance_class(mod, cls, func_id, parts[:-1])
            if ck:
                f = self.find_method(ck[0], ck[1], parts[-1])
                if f:
                    return ("fn", f, True)
        if root in ("self", "cls") and cls:
            if len(parts) == 2:
                f = self.find_method(mod["name"], cls, parts[1])
                return ("fn", f, True) if f else ("method", parts[1], False)
            return ("method", parts[-1], False)
        if root == "super":
            return None
        r = self.lookup_project(mod["name"] + "." + name)
        if r:
            return (r[0], r[1], True)
        full = self.full_of(mod, name)
        if full:
            r = self.lookup_project(full)
            if r:
                return (r[0], r[1], True)
            return ("ext", full, True)
        if len(parts) > 1 and parts[-1] not in COMMON_METHODS:
            return ("method", parts[-1], False)
        return None

    # ---------------------------------------------------------------- infra
    def infra_for_ext(self, full):
        for iid, _label, _typ, libs in INFRA_SPECS:
            for lib in libs:
                if full == lib or full.startswith(lib + "."):
                    self.infra_libs[iid].add(lib.split(".")[0])
                    return iid
        return None

    def client_infra(self, mod, func_id, cls, name):
        """Infra associée à une expression pointée (variable cliente, import, ou lib externe)."""
        if not name or name.startswith("?."):
            return None
        parts = name.split(".")
        root = parts[0]
        if root.endswith("()"):
            r = self.resolve(mod, cls, root[:-2], func_id)
            return self.func_returns.get(r[1]) if r and r[0] == "fn" else None
        if root == "self" and cls and len(parts) >= 2:
            return self.self_clients.get((mod["name"], cls, parts[1]))
        if func_id and (func_id, root) in self.local_clients:
            return self.local_clients[(func_id, root)]
        if (mod["name"], root) in self.mod_clients:
            return self.mod_clients[(mod["name"], root)]
        if root in mod["imports"]:
            full = self.full_of(mod, name)
            mname, rest = self.module_prefix(full)
            if mname:
                if rest and (mname, rest[0]) in self.mod_clients:
                    return self.mod_clients[(mname, rest[0])]
                return None
            return self.infra_for_ext(full)
        return None

    def _slot(self, mod, a, which):
        tn = a["target"]
        if tn.startswith("self."):
            if not a["cls"]:
                return None
            d = self.self_clients if which == "c" else self.self_inst
            return d, (mod["name"], a["cls"], tn.split(".")[1])
        if "." in tn:
            return None
        if a["func"]:
            return (self.local_clients if which == "c" else self.local_inst), (a["func"], tn)
        return (self.mod_clients if which == "c" else self.mod_inst), (mod["name"], tn)

    def collect_clients(self):
        for _ in range(5):
            changed = False
            for mod in self.modules.values():
                for a in mod["assigns"]:
                    base = a["base"]
                    if not base:
                        continue
                    infra = self.client_infra(mod, a["func"], a["cls"], base)
                    ck = None
                    if not infra and not base.startswith("?.") and "(" not in base:
                        ck = self.resolve_class(mod, base)
                    if not infra and not ck:
                        continue
                    slot = self._slot(mod, a, "c" if infra else "i")
                    if slot and slot[1] not in slot[0]:
                        slot[0][slot[1]] = infra or ck
                        changed = True
            for fid, f in self.funcs.items():
                mod = self.modules[f["module"]]
                if fid not in self.func_returns:
                    for rb in f.get("returns", []):
                        infra = self.client_infra(mod, fid, f["cls"], rb) if rb else None
                        if infra:
                            self.func_returns[fid] = infra
                            changed = True
                            break
                if fid not in self.func_ret_class:
                    cands = [f.get("ret_ann")] + [rb for rb in f.get("returns", []) if rb and "(" not in rb and not rb.startswith("?.")]
                    for cn in cands:
                        ck = self.resolve_class(mod, cn) if cn else None
                        if ck:
                            self.func_ret_class[fid] = ck
                            changed = True
                            break
            # paramètres injectés (Depends) : même infra / même classe que ce que renvoie la dépendance
            for fid, f in self.funcs.items():
                mod = self.modules[f["module"]]
                for arg, dep in f.get("dep_params", {}).items():
                    if not dep:
                        continue
                    r = self.resolve(mod, f["cls"], dep, fid)
                    if not r:
                        continue
                    infra, ck = None, None
                    if r[0] == "fn":
                        infra, ck = self.func_returns.get(r[1]), self.func_ret_class.get(r[1])
                    elif r[0] == "cls":
                        ck = r[1]
                    if infra and (fid, arg) not in self.local_clients:
                        self.local_clients[(fid, arg)] = infra
                        changed = True
                    if ck and (fid, arg) not in self.local_inst:
                        self.local_inst[(fid, arg)] = ck
                        changed = True
            if not changed:
                break

    def instance_class(self, mod, cls, func_id, holder):
        """Classe projet de l'objet désigné par `holder` (liste de segments), si connue."""
        if holder == ["self"] or not holder:
            return None
        if holder[0] == "self" and len(holder) == 2 and cls:
            return self.self_inst.get((mod["name"], cls, holder[1]))
        if len(holder) != 1:
            return None
        root = holder[0]
        f = self.funcs.get(func_id)
        if f and root in f.get("arg_types", {}) and f["arg_types"][root]:
            r = self.resolve_class(mod, f["arg_types"][root])
            if r:
                return r
        if func_id and (func_id, root) in self.local_inst:
            return self.local_inst[(func_id, root)]
        if (mod["name"], root) in self.mod_inst:
            return self.mod_inst[(mod["name"], root)]
        if root in mod["imports"]:
            mname, rest = self.module_prefix(mod["imports"][root])
            if mname and len(rest) == 1:
                return self.mod_inst.get((mname, rest[0]))
        return None

    # ---------------------------------------------------------------- arêtes
    def add_edge(self, src, tgt, kind, certain, label=None):
        if src == tgt:
            return
        key = (src, tgt, "async" if kind == "async" else "uses" if kind == "uses" else "call")
        e = self.edges.get(key)
        if e is None:
            self.edges[key] = {"source": src, "target": tgt, "kind": kind, "certain": certain, "count": 1, "label": label}
        else:
            if label and not e["label"]:
                e["label"] = label
            e["count"] += 1
            e["certain"] = e["certain"] or certain
            if kind == "call":
                e["kind"] = "call"
            e["label"] = e["label"] or label

    def resolve_edges(self):
        for fid, f in self.funcs.items():
            self.methods_by_name[f["name"]].append(fid)
        recs = list(self.funcs.values()) + [m["top"] for m in self.modules.values()]
        for rec in recs:
            try:
                self._resolve_rec(rec)
            except Exception as e:  # noqa: BLE001
                self.note_error("résolution", rec.get("id"), e)

    def note_error(self, phase, what, exc):
        self.errors += 1
        if self.errors <= 5:
            sys.stderr.write(f"[cartograph] erreur ignorée ({phase}) sur {what} : {type(exc).__name__}: {exc}\n")

    def _resolve_rec(self, rec):
        if True:
            mod = self.modules[rec["module"]]
            cls = rec.get("cls")
            for dep in rec.get("dep_params", {}).values():
                r = self.resolve(mod, cls, dep, rec["id"]) if dep else None
                if r and r[0] == "fn":
                    self.add_edge(rec["id"], r[1], "ref", True, "DI")
            for ref in rec["refs"]:
                res = self.resolve(mod, cls, ref, rec["id"])
                if not res:
                    continue
                if res[0] == "fn":
                    self.add_edge(rec["id"], res[1], "ref", True)
                elif res[0] == "cls":
                    init = self.modules[res[1][0]]["funcs"].get(res[1][1] + ".__init__")
                    self.class_users[res[1]].add(rec["id"])
                    if init:
                        self.add_edge(rec["id"], init["id"], "ref", True)
            for call in rec["calls"]:
                self.handle_call(rec, mod, cls, call)

    def handle_call(self, rec, mod, cls, call):
        name = call["name"]
        if not name:
            return
        last = name.split(".")[-1]
        res = self.resolve(mod, cls, name, rec["id"])
        # envoi asynchrone (Celery .delay, BackgroundTasks, executor, thread...)
        if last in CELERY_STYLE and "." in name:
            t = self.resolve(mod, cls, name.rsplit(".", 1)[0], rec["id"])
            if t and t[0] == "fn":
                self.add_edge(rec["id"], t[1], "async", True, "Celery")
                self.async_targets[t[1]] = "Celery"
        elif last in ASYNC_DISPATCH:
            for a in call["args"]:
                t = self.resolve(mod, cls, a, rec["id"]) if a else None
                if t and t[0] == "fn":
                    self.add_edge(rec["id"], t[1], "async", True, ASYNC_DISPATCH[last])
                    self.async_targets[t[1]] = ASYNC_DISPATCH[last]
                    break
        elif last in ("Thread", "Process", "Timer"):
            tgt = call["kw"].get("target") or call["kw"].get("function")
            t = self.resolve(mod, cls, tgt, rec["id"]) if tgt else None
            if t and t[0] == "fn":
                self.add_edge(rec["id"], t[1], "async", True, last.lower())
                self.async_targets[t[1]] = last.lower()
        if res:
            if res[0] == "fn":
                self.add_edge(rec["id"], res[1], "call", res[2])
            elif res[0] == "cls":
                init = self.modules[res[1][0]]["funcs"].get(res[1][1] + ".__init__")
                self.class_users[res[1]].add(rec["id"])
                if init:
                    self.add_edge(rec["id"], init["id"], "call", True)
            elif res[0] == "method":
                cands = self.methods_by_name.get(res[1], [])
                if res[1] not in COMMON_METHODS and 0 < len(cands) <= 3:
                    for c in cands:
                        self.add_edge(rec["id"], c, "call", False)
        # infrastructure
        infra = self.client_infra(mod, rec["id"], rec.get("cls"), name)
        root_cls = self.resolve_root_class(mod, name)
        if root_cls:
            self.class_users[root_cls].add(rec["id"])
            if infra is None:
                infra = self.model_store(root_cls)
        if infra:
            self.infra_ops[(rec["id"], infra)][last] += 1
        # liens de broker (Celery(...), RedisBroker...)
        src = call.get("src")
        if src and last in ("Celery", "RedisBroker", "RabbitmqBroker"):
            target = "redis" if ("redis" in src or last == "RedisBroker") else "rabbitmq" if ("amqp" in src or "rabbit" in src or last == "RabbitmqBroker") else None
            self.extra_infra_edges.append(("celery" if last == "Celery" else "dramatiq", target))

    # ---------------------------------------------------------------- modèles
    def model_kind(self, key, depth=0):
        c = self.classes.get(key)
        if not c or depth > 6:
            return None
        if "dataclass" in [d.split(".")[-1] for d in c["decorators"]]:
            return "dataclass"
        mod = self.modules[key[0]]
        for b in c["bases"]:
            if not b:
                continue
            kind = MODEL_BASES.get(b.split(".")[-1])
            if kind:
                if b.split(".")[-1] == "SQLModel" and c["table_kw"]:
                    return "orm"
                return kind
            r = self.resolve_class(mod, b)
            if r:
                k = self.model_kind(r, depth + 1)
                if k:
                    return k
        return None

    def model_store(self, key):
        kind = self.model_kind(key)
        if kind == "orm":
            return "sql"
        if kind == "odm":
            return "mongodb"
        return None

    def build_models(self):
        models, by_name, by_table = [], defaultdict(list), {}
        for key, c in self.classes.items():
            kind = self.model_kind(key)
            if not kind:
                continue
            store = self.model_store(key)
            m = {
                "id": c["id"], "name": c["name"], "module": c["module"], "file": c["file"], "line": c["line"],
                "kind": kind, "store": store, "fields": c["fields"][:40], "tablename": c["tablename"],
                "usedBy": sorted(self.class_users.get(key, set()))[:60], "nFields": len(c["fields"]),
            }
            models.append(m)
            by_name[c["name"]].append(m)
            if c["tablename"]:
                by_table[c["tablename"]] = m
        edges = []
        for m in models:
            for f in m["fields"]:
                t = f["type"]
                for tok in set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", t)):
                    cands = by_name.get(tok)
                    if cands and tok != m["name"] and len(cands) == 1:
                        edges.append({"source": m["id"], "target": cands[0]["id"], "label": f["name"], "kind": "relation"})
                fk = re.search(r"ForeignKey\(['\"]([\w.]+)['\"]", t)
                if fk and fk.group(1).split(".")[0] in by_table:
                    tm = by_table[fk.group(1).split(".")[0]]
                    if tm["id"] != m["id"]:
                        edges.append({"source": m["id"], "target": tm["id"], "label": f["name"] + " (FK)", "kind": "relation"})
        uniq = {(e["source"], e["target"], e["label"]): e for e in edges}
        return models, list(uniq.values())

    # ---------------------------------------------------------------- annotation des fonctions
    def annotate(self):
        has_celery = {n for n, m in self.modules.items() if any(v.split(".")[0] in ("celery", "dramatiq", "rq", "arq") for v in m["imports"].values())}
        for fid, f in self.funcs.items():
            mod = self.modules[f["module"]]
            f["entry"], f["route"], f["worker"] = None, None, None
            for d in f["decos"]:
                parts = d["name"].split(".")
                last, root = parts[-1], parts[0]
                if last in HTTP and len(parts) > 1 and (
                        root in self.route_obj_names or any(s in root.lower() for s in ("app", "router", "api", "bp", "blueprint"))):
                    methods = d["kw"].get("methods") or [last.upper() if last not in ("route", "api_route") else "ANY"]
                    path = d["args"][0] if d["args"] and d["args"][0] else d["kw"].get("path") or ""
                    prefix = self.route_objs.get((f["module"], root), "")
                    f["route"] = {"method": ",".join(m for m in methods if m), "path": (prefix or "") + (path or ""), "auth": None}
                elif last in TASK_DECOS and (f["module"] in has_celery or self.client_infra(mod, None, None, d["name"]) in QUEUE_IDS):
                    infra = self.client_infra(mod, None, None, d["name"])
                    libs = {v.split(".")[0] for v in mod["imports"].values()} & {"celery", "dramatiq", "rq", "arq"}
                    lib = infra if infra in QUEUE_IDS else (sorted(libs)[0] if libs else "celery")
                    f["worker"] = {"lib": lib, "queue": lib}
                elif last in HANDLER_DECOS:
                    f["entry"] = f["entry"] or "handler"
            if f["route"]:
                ok = any(k == "Security" or AUTH_RE.search(a or "") for k, a in f["deps"]) or any(
                    AUTH_RE.search(d["name"]) and d["name"].split(".")[-1] not in HTTP for d in f["decos"])
                f["route"]["auth"] = True if ok else (None if self.global_deps else False)
                f["entry"] = "route"
            elif f["worker"]:
                f["entry"] = "worker"
            elif fid in self.async_targets:
                f["entry"] = f["entry"] or "background"
            if not f["entry"]:
                n = f["name"]
                if n.startswith("test_") or mod["layer"] == "test":
                    f["entry"] = "test"
                elif n.startswith("__") and n.endswith("__"):
                    f["entry"] = "dunder"
                elif n == "main" and not f["cls"]:
                    f["entry"] = "main"
            f["layer"] = "route" if f["route"] else "worker" if f["worker"] else mod["layer"]
            f["kind"] = "method" if f["cls"] else "function"

    def detect_dead(self):
        incoming = Counter()
        for (s, t, _k), e in self.edges.items():
            if s != t and not t.startswith("infra:"):
                incoming[t] += 1
        for fid, f in self.funcs.items():
            f["callers"] = incoming.get(fid, 0)
            f["dead"] = None
            if incoming.get(fid) or f["entry"]:
                continue
            decorated = [d for d in f["decos"] if d["name"].split(".")[-1] not in ("staticmethod", "classmethod")]
            props = any(d["name"].split(".")[-1] in ("property", "setter", "getter", "deleter", "abstractmethod", "cached_property") for d in f["decos"])
            if props:
                continue
            conf = "high"
            if f["cls"] or decorated or f["name"] in self.all_strings:
                conf = "low"
            f["dead"] = {"confidence": conf}
            self.issues.append({
                "severity": "info", "category": "dead", "rule": "unused-function",
                "message": f"« {f['qual']} » n'est appelée nulle part" + (" (méthode : appel dynamique possible)" if conf == "low" else ""),
                "params": {"name": f["qual"], "why": "dynamic" if conf == "low" else ""},
                "file": f["file"], "line": f["line"], "node": fid, "source": "cartograph", "level": None, "confidence": conf,
            })

    def quality_issues(self):
        for fid, f in self.funcs.items():
            c = f["complexity"]
            if c > 10:
                self.issues.append({
                    "severity": "error" if c > 25 else "warning", "category": "complexity", "rule": "high-complexity",
                    "message": f"« {f['qual']} » a une complexité cyclomatique de {c}", "params": {"name": f["qual"], "n": c}, "file": f["file"], "line": f["line"],
                    "node": fid, "source": "cartograph", "level": None,
                })
            if f["loc"] > 80:
                self.issues.append({
                    "severity": "info", "category": "quality", "rule": "long-function",
                    "message": f"« {f['qual']} » fait {f['loc']} lignes", "params": {"name": f["qual"], "n": f["loc"]}, "file": f["file"], "line": f["line"],
                    "node": fid, "source": "cartograph", "level": None,
                })
            if len(f["args"]) > 7:
                self.issues.append({
                    "severity": "info", "category": "quality", "rule": "many-args",
                    "message": f"« {f['qual']} » prend {len(f['args'])} arguments", "params": {"name": f["qual"], "n": len(f["args"])}, "file": f["file"], "line": f["line"],
                    "node": fid, "source": "cartograph", "level": None,
                })
            r = f.get("route")
            if r and r["auth"] is False and any(m in WRITE_METHODS for m in r["method"].split(",")):
                self.issues.append({
                    "severity": "warning", "category": "security", "rule": "route-no-auth",
                    "message": f"Route {r['method']} {r['path'] or '/'} sans authentification apparente", "params": {"method": r["method"], "path": r["path"] or "/"},
                    "file": f["file"], "line": f["line"], "node": fid, "source": "cartograph", "level": "medium",
                })
        for mod in self.modules.values():
            if mod["is_pkg"]:
                continue
            for alias, line, full in mod["import_lines"]:
                if alias == "_" or full.startswith("__future__"):
                    continue
                if len(re.findall(r"\b" + re.escape(alias) + r"\b", mod["src"])) <= 1:
                    self.issues.append({
                        "severity": "info", "category": "quality", "rule": "unused-import",
                        "message": f"Import inutilisé : {alias}", "params": {"name": alias}, "file": mod["file"], "line": line,
                        "node": f"mod:{mod['name']}", "source": "cartograph", "level": None,
                    })

    # ---------------------------------------------------------------- doublons
    def detect_duplicates(self):
        cands = [f for f in self.funcs.values() if len(f["toks"]) >= 30 and f["nstmts"] >= 2]
        groups, seen = [], set()
        by_hash = defaultdict(list)
        for f in cands:
            h = hashlib.md5((" ".join(f["toks"]) + "|" + ",".join(f["callees"])).encode()).hexdigest()
            by_hash[h].append(f)
        for members in by_hash.values():
            if len(members) > 1:
                groups.append({"kind": "exact", "similarity": 1.0, "members": [m["id"] for m in members]})
                seen.update(m["id"] for m in members)
        pool = sorted([f for f in cands if len(f["toks"]) >= 40 and f["id"] not in seen], key=lambda x: -len(x["toks"]))[:900]
        sigs = {}
        for f in pool:
            t = f["toks"]
            grams = {" ".join(t[i:i + 3]) for i in range(len(t) - 2)}
            grams |= {"c:" + c for c in f["callees"]}
            sigs[f["id"]] = grams
        used = set()
        for i, a in enumerate(pool):
            if a["id"] in used:
                continue
            group = [a["id"]]
            best = 0.0
            for b in pool[i + 1:]:
                if b["id"] in used:
                    continue
                if len(b["toks"]) < len(a["toks"]) * 0.75:
                    break
                sa, sb = sigs[a["id"]], sigs[b["id"]]
                inter = len(sa & sb)
                if not inter:
                    continue
                sim = inter / len(sa | sb)
                if sim >= 0.85:
                    group.append(b["id"])
                    best = max(best, sim) if best else sim
            if len(group) > 1:
                used.update(group)
                groups.append({"kind": "similar", "similarity": round(best, 2), "members": group})
        for gi, g in enumerate(groups):
            for fid in g["members"]:
                self.funcs[fid]["dup"] = gi
            names = ", ".join(self.funcs[m]["qual"] for m in g["members"][:4])
            for fid in g["members"]:
                f = self.funcs[fid]
                self.issues.append({
                    "severity": "info", "category": "duplicate", "rule": "duplicate-" + g["kind"],
                    "message": ("Structure identique à : " if g["kind"] == "exact" else f"Fonction très similaire ({int(g['similarity'] * 100)} %) à : ")
                               + ", ".join(self.funcs[m]["qual"] for m in g["members"] if m != fid)[:160],
                    "params": {"others": ", ".join(self.funcs[m]["qual"] for m in g["members"] if m != fid)[:160], "pct": int(g["similarity"] * 100)},
                    "file": f["file"], "line": f["line"], "node": fid, "source": "cartograph", "level": None, "group": gi,
                })
        return groups

    # ---------------------------------------------------------------- modules / architecture
    def module_graph(self):
        mod_edges = {}
        for mod in self.modules.values():
            for full in mod["import_full"]:
                tname, _rest = self.module_prefix(full)
                if not tname or tname == mod["name"]:
                    continue
                tm = self.modules[tname]
                if tm["is_pkg"] and mod["name"].startswith(tname + "."):
                    continue
                mod_edges.setdefault((mod["name"], tname), {"imports": True, "calls": 0})
        for (s, t, _k), e in self.edges.items():
            if t.startswith("infra:"):
                continue
            sm = self.funcs[s]["module"] if s in self.funcs else s[4:]
            tm = self.funcs[t]["module"] if t in self.funcs else t[4:]
            if sm != tm and sm in self.modules and tm in self.modules:
                d = mod_edges.setdefault((sm, tm), {"imports": False, "calls": 0})
                d["calls"] += e["count"]
        out = []
        for (s, t), d in mod_edges.items():
            ls, lt = self.modules[s]["layer"], self.modules[t]["layer"]
            violation = ls in STRICT_LAYERS and lt in STRICT_LAYERS and STRICT_LAYERS[ls] > STRICT_LAYERS[lt] \
                and not (ls == "worker" and lt == "route") and not (ls == "model" and lt == "model")
            out.append({"source": f"mod:{s}", "target": f"mod:{t}", "imports": d["imports"], "calls": d["calls"], "violation": violation})
            if violation:
                self.issues.append({
                    "severity": "warning", "category": "architecture", "rule": "layer-violation",
                    "message": f"Dépendance remontante : {ls} → {lt} ({s} importe {t})", "params": {"from": ls, "to": lt, "src": s, "dst": t},
                    "file": self.modules[s]["file"], "line": 1, "node": f"mod:{s}", "source": "cartograph", "level": None,
                })
        return out

    def find_cycles(self, mod_edges):
        graph = defaultdict(list)
        for e in mod_edges:
            if e["imports"]:
                graph[e["source"]].append(e["target"])
        index, low, on, stack, cycles, counter = {}, {}, set(), [], [], [0]

        def strong(v):
            index[v] = low[v] = counter[0]
            counter[0] += 1
            stack.append(v)
            on.add(v)
            for w in graph.get(v, []):
                if w not in index:
                    strong(w)
                    low[v] = min(low[v], low[w])
                elif w in on:
                    low[v] = min(low[v], index[w])
            if low[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                if len(comp) > 1:
                    cycles.append(sorted(c[4:] for c in comp))

        for v in list(graph):
            if v not in index:
                strong(v)
        for comp in cycles:
            for mname in comp:
                self.issues.append({
                    "severity": "warning", "category": "architecture", "rule": "circular-import",
                    "message": "Import circulaire : " + " ↔ ".join(comp[:5]), "params": {"mods": " ↔ ".join(comp[:5])},
                    "file": self.modules[mname]["file"], "line": 1, "node": f"mod:{mname}", "source": "cartograph", "level": None,
                })
        return cycles

    # ---------------------------------------------------------------- docker-compose / Procfile
    def parse_deploy_files(self):
        for fname in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
            p = os.path.join(self.root, fname)
            if os.path.isfile(p):
                try:
                    self.parse_compose(open(p, encoding="utf-8", errors="replace").read())
                except Exception:
                    pass
                break
        p = os.path.join(self.root, "Procfile")
        if os.path.isfile(p):
            for line in open(p, encoding="utf-8", errors="replace"):
                m = re.match(r"^([\w-]+):\s*(.+)$", line.strip())
                if m:
                    self.processes.append({"id": f"proc:{m.group(1)}", "label": m.group(1), "command": m.group(2)[:90], "role": self.role_of(m.group(1) + " " + m.group(2)), "depends": []})

    @staticmethod
    def role_of(text):
        t = text.lower()
        if "beat" in t:
            return "scheduler"
        if "celery" in t or "worker" in t or "rq " in t or "dramatiq" in t or "arq " in t:
            return "worker"
        if any(k in t for k in ("uvicorn", "gunicorn", "flask", "hypercorn", "web", "manage.py runserver")):
            return "web"
        return "process"

    def parse_compose(self, text):
        services, in_services, base, cur, sub, sub_indent = {}, False, None, None, None, 0
        for raw in text.splitlines():
            if not raw.strip() or raw.strip().startswith("#"):
                continue
            stripped = raw.lstrip()
            indent = len(raw) - len(stripped)
            if indent == 0:
                in_services = stripped.startswith("services:")
                cur, base = None, None
                continue
            if not in_services:
                continue
            if base is None:
                base = indent
            if indent == base and stripped.endswith(":"):
                cur = stripped[:-1].strip()
                services[cur] = {"image": None, "command": "", "depends": [], "build": False}
                sub = None
                continue
            if not cur:
                continue
            if sub and indent <= sub_indent:
                sub = None
            if sub == "depends":
                m = re.match(r"-?\s*([\w.-]+)", stripped)
                if m:
                    services[cur]["depends"].append(m.group(1))
                continue
            m = re.match(r"image:\s*['\"]?([^\s'\"]+)", stripped)
            if m:
                services[cur]["image"] = m.group(1)
            elif stripped.startswith("build:"):
                services[cur]["build"] = True
            elif stripped.startswith("command:") or stripped.startswith("entrypoint:"):
                services[cur]["command"] += " " + stripped.split(":", 1)[1].strip()
            elif stripped.startswith("depends_on:"):
                inline = stripped.split(":", 1)[1].strip()
                if inline.startswith("["):
                    services[cur]["depends"] += [x.strip(" '\"") for x in inline.strip("[]").split(",") if x.strip()]
                else:
                    sub, sub_indent = "depends", indent
        name_to_node = {}
        for name, s in services.items():
            iid = None
            if s["image"] and not s["build"]:
                img = s["image"].lower()
                for needle, target in IMAGE_TO_INFRA:
                    if needle in img:
                        iid = target
                        break
            if iid:
                self.compose_infra[iid] = name
                name_to_node[name] = f"infra:{iid}"
            else:
                pid = f"proc:{name}"
                name_to_node[name] = pid
                self.processes.append({"id": pid, "label": name, "command": s["command"].strip()[:90], "role": self.role_of(name + " " + s["command"]), "depends": s["depends"]})
        for p in self.processes:
            p["depends"] = [name_to_node.get(d, f"proc:{d}") for d in p["depends"]]

    # ---------------------------------------------------------------- système
    def build_infra(self, models):
        used = Counter()
        for (_fid, iid), ops in self.infra_ops.items():
            used[iid] += sum(ops.values())
        for m in models:
            if m["store"]:
                used[m["store"]] += 0
        for mod in self.modules.values():
            for full in mod["import_full"]:
                if self.module_prefix(full)[0] is None:
                    iid = self.infra_for_ext(full)
                    if iid:
                        used[iid] += 0
        for iid in self.compose_infra:
            used[iid] += 0
        links = []
        for src, tgt in self.extra_infra_edges:
            if src in QUEUE_IDS:
                used[src] += 0
            if tgt is None:
                present = [i for i in ("redis", "rabbitmq") if i in used]
                tgt = present[0] if len(present) == 1 else None
            if tgt:
                used[tgt] += 0
                links.append((src, tgt))
        for iid in ("rq", "arq"):
            if iid in used:
                used["redis"] += 0
                links.append((iid, "redis"))
        # ORM générique -> pilote SQL unique éventuel
        drivers = [i for i in ("postgres", "mysql", "sqlite") if i in used]
        remap = {}
        if "sql" in used and len(drivers) == 1:
            remap["sql"] = drivers[0]
        infra, seen_links = [], set()
        for iid in used:
            spec = INFRA_BY_ID.get(iid) or (iid, iid.capitalize(), "external", [])
            if iid in remap:
                continue
            infra.append({
                "id": f"infra:{iid}", "label": spec[1], "type": spec[2], "libs": sorted(self.infra_libs.get(iid, [])),
                "declared": iid in self.compose_infra, "service": self.compose_infra.get(iid),
                "uses": used[iid], "queue": iid in QUEUE_IDS,
            })
        # infra présente uniquement via docker-compose
        for iid, svc in self.compose_infra.items():
            if iid not in used:
                spec = INFRA_BY_ID.get(iid) or (iid, iid, "external", [])
                infra.append({"id": f"infra:{iid}", "label": spec[1], "type": spec[2], "libs": [], "declared": True, "service": svc, "uses": 0, "queue": False})
        for s, t in links:
            s, t = remap.get(s, s), remap.get(t, t)
            if (s, t) not in seen_links:
                seen_links.add((s, t))
        return infra, [{"source": f"infra:{s}", "target": f"infra:{t}", "kind": "broker", "label": "broker"} for s, t in sorted(seen_links)], remap

    def build_system(self, infra, infra_links, remap):
        adj = defaultdict(list)
        for (s, t, k), e in self.edges.items():
            if t.startswith("infra:"):
                continue
            adj[s].append((t, k))
        infra_of = defaultdict(Counter)
        for (fid, iid), ops in self.infra_ops.items():
            infra_of[fid][remap.get(iid, iid)] += 0
            infra_of[fid][remap.get(iid, iid)] += sum(ops.values())
        op_names = defaultdict(Counter)
        for (fid, iid), ops in self.infra_ops.items():
            op_names[(fid, remap.get(iid, iid))].update(ops)
        entries = [f for f in self.funcs.values() if f["entry"] in ("route", "worker", "background", "handler", "main")]
        groups = {}
        nodes, edges = {}, {}
        for p in self.processes:
            nodes[p["id"]] = {"id": p["id"], "label": p["label"], "kind": "process", "sub": p["command"] or p["role"], "role": p["role"]}

        def node_for(f):
            if f["entry"] == "route":
                gid = f"grp:{f['module']}"
                g = nodes.setdefault(gid, {"id": gid, "label": f["module"].split(".")[-1], "kind": "routes", "unit": "route", "sub": "", "members": [], "file": f["file"], "line": f["line"], "ids": []})
                g["members"].append(f"{f['route']['method']} {f['route']['path'] or '/'}")
                g["ids"].append(f["id"])
                g["sub"] = ""
                return gid
            kind = {"worker": "worker", "background": "worker", "handler": "entry", "main": "entry"}[f["entry"]]
            nodes.setdefault(f["id"], {"id": f["id"], "label": f["qual"], "kind": kind, "sub": (f["worker"] or {}).get("lib", f["entry"]) if f["worker"] else f["entry"], "file": f["file"], "line": f["line"], "ids": [f["id"]]})
            return f["id"]

        def add(s, t, kind, label=None):
            e = edges.get((s, t, kind))
            if e is None:
                edges[(s, t, kind)] = {"source": s, "target": t, "kind": kind, "labels": Counter()}
                e = edges[(s, t, kind)]
            if label:
                for part in (label if isinstance(label, list) else [label]):
                    e["labels"][part] += 1

        for f in entries:
            src = node_for(f)
            visited, stack = {f["id"]}, [f["id"]]
            while stack:
                cur = stack.pop()
                for iid, _n in infra_of.get(cur, {}).items():
                    add(src, f"infra:{iid}", "uses", top(op_names[(cur, iid)]))
                for t, k in adj.get(cur, []):
                    if k == "async":
                        tf = self.funcs.get(t)
                        if tf:
                            tgt = node_for({**tf, "entry": tf["entry"] if tf["entry"] in ("worker", "background") else "background"})
                            lib = (tf["worker"] or {}).get("lib")
                            if lib:
                                add(src, f"infra:{lib}", "async", "enqueue")
                                add(f"infra:{lib}", tgt, "consume")
                            else:
                                add(src, tgt, "async", self.edges[(cur, t, "async")]["label"])
                        continue
                    if t not in visited and t in self.funcs:
                        visited.add(t)
                        stack.append(t)
        for p in self.processes:
            for d in p["depends"]:
                if d in nodes or d.startswith("infra:"):
                    edges[(p["id"], d, "depends")] = {"source": p["id"], "target": d, "kind": "depends", "labels": Counter()}
            if p["role"] == "web":
                for gid, g in list(nodes.items()):
                    if g["kind"] == "routes":
                        edges[(p["id"], gid, "runs")] = {"source": p["id"], "target": gid, "kind": "runs", "labels": Counter()}
            if p["role"] in ("worker", "scheduler"):
                for i in infra:
                    if i["queue"]:
                        edges[(p["id"], i["id"], "runs")] = {"source": p["id"], "target": i["id"], "kind": "runs", "labels": Counter()}
                        break
        for i in infra:
            nodes[i["id"]] = {"id": i["id"], "label": i["label"], "kind": "infra", "sub": i["type"], "declared": i["declared"], "service": i["service"], "libs": i["libs"], "uses": i["uses"]}
        for l in infra_links:
            edges[(l["source"], l["target"], "broker")] = {"source": l["source"], "target": l["target"], "kind": "broker", "labels": Counter({"broker": 1})}
        # arêtes vers des infra remappées / inexistantes
        valid = set(nodes)
        out_edges = []
        for e in edges.values():
            if e["source"] in valid and e["target"] in valid:
                out_edges.append({"source": e["source"], "target": e["target"], "kind": e["kind"], "label": ", ".join(top(e["labels"])) or None})
        return {"nodes": list(nodes.values()), "edges": out_edges}

    # ---------------------------------------------------------------- sortie
    def run(self):
        t0 = time.time()
        self.load()
        self.parse_deploy_files()
        self.collect_clients()
        self.resolve_edges()
        self.annotate()
        self.detect_dead()
        self.quality_issues()
        groups = self.detect_duplicates()
        mod_edges = self.module_graph()
        cycles = self.find_cycles(mod_edges)
        models, model_edges = self.build_models()
        infra, infra_links, remap = self.build_infra(models)
        for m in models:
            if m["store"] in remap:
                m["store"] = remap[m["store"]]
        system = self.build_system(infra, infra_links, remap)
        # nœuds
        out_nodes, out_edges, has_edge = [], [], set()
        for (s, t, k), e in self.edges.items():
            has_edge.add(s)
            has_edge.add(t)
        for (fid, iid), ops in self.infra_ops.items():
            iid = remap.get(iid, iid)
            has_edge.add(fid)
            out_edges.append({"source": fid, "target": f"infra:{iid}", "kind": "uses", "certain": True, "count": sum(ops.values()),
                              "label": ", ".join(top(ops))})
        callees = Counter()
        for (s, t, k), e in self.edges.items():
            callees[s] += 1
            out_edges.append({k2: e[k2] for k2 in ("source", "target", "kind", "certain", "count", "label")})
        for fid, f in self.funcs.items():
            out_nodes.append({
                "id": fid, "kind": f["kind"], "label": f["qual"], "name": f["name"], "module": f["module"], "file": f["file"],
                "line": f["line"], "end": f["end"], "layer": f["layer"], "complexity": f["complexity"], "loc": f["loc"],
                "args": f["args"], "async": f["async"], "decorators": [d["name"] for d in f["decos"]], "doc": f["doc"],
                "entry": f["entry"], "route": f["route"], "worker": f["worker"], "dead": f["dead"], "dup": f.get("dup"),
                "callers": f["callers"], "callees": callees.get(fid, 0),
            })
        for mname, m in self.modules.items():
            if m["top"]["id"] in has_edge:
                out_nodes.append({
                    "id": m["top"]["id"], "kind": "module", "label": mname, "name": mname, "module": mname,
                    "file": m["file"], "line": 1, "end": 1, "layer": m["layer"], "complexity": 0, "loc": 0, "args": [], "async": False,
                    "decorators": [], "doc": "", "entry": None, "route": None, "worker": None, "dead": None, "dup": None,
                    "callers": 0, "callees": callees.get(m["top"]["id"], 0),
                })
        mods = []
        for mname, m in self.modules.items():
            fs = [f for f in self.funcs.values() if f["module"] == mname]
            mods.append({
                "id": f"mod:{mname}", "name": mname, "file": m["file"], "layer": m["layer"], "loc": m["loc"],
                "functions": len(fs), "classes": len(m["classes"]),
                "avgComplexity": round(sum(f["complexity"] for f in fs) / len(fs), 1) if fs else 0,
                "isPackage": m["is_pkg"],
            })
        for i, iss in enumerate(self.issues):
            iss["id"] = f"i{i}"
        fn_list = list(self.funcs.values())
        metrics = {
            "files": len(self.modules), "functions": len(fn_list), "classes": len(self.classes),
            "loc": sum(m["loc"] for m in self.modules.values()),
            "avgComplexity": round(sum(f["complexity"] for f in fn_list) / len(fn_list), 1) if fn_list else 0,
            "dead": sum(1 for f in fn_list if f["dead"]), "duplicates": len(groups), "cycles": len(cycles),
            "routes": sum(1 for f in fn_list if f["route"]), "workers": sum(1 for f in fn_list if f["worker"]),
            "infra": len(infra), "models": len(models),
            "securityHigh": sum(1 for i in self.issues if i["category"] == "security" and i.get("level") == "high"),
            "seconds": round(time.time() - t0, 2), "parsed": self.parsed, "cached": self.cached, "errors": self.errors,
        }
        db_schemas = []
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import dbschema
            configs = []
            for k, v in os.environ.items():
                if k.startswith("CARTOGRAPH_DB_"):
                    try:
                        configs.append(json.loads(v))
                    except ValueError:
                        pass
            db_schemas = dbschema.read_all(self.root, configs)
        except Exception:
            db_schemas = []
        return {
            "version": VERSION, "root": self.root, "dbSchemas": db_schemas, "generatedAt": int(time.time()), "metrics": metrics,
            "nodes": out_nodes, "edges": out_edges, "modules": mods, "moduleEdges": mod_edges,
            "models": models, "modelEdges": model_edges, "infra": infra, "infraLinks": infra_links,
            "system": system, "issues": self.issues, "duplicates": groups, "cycles": cycles,
            "layers": LAYER_ORDER,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--out")
    ap.add_argument("--cache")
    args = ap.parse_args()
    sys.setrecursionlimit(20000)
    try:
        result = Analyzer(args.root, args.exclude, args.cache).run()
    except Exception:
        if not args.cache:
            raise
        # cache possiblement corrompu ou issu d'une ancienne version : on le supprime et on réessaie une fois
        sys.stderr.write("[cartograph] erreur avec le cache, nouvelle tentative sans cache\n")
        try:
            os.remove(args.cache)
        except OSError:
            pass
        result = Analyzer(args.root, args.exclude, None).run()
    data = json.dumps(result, ensure_ascii=False, default=list)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(data)
    else:
        sys.stdout.buffer.write(data.encode("utf-8"))


if __name__ == "__main__":
    main()
