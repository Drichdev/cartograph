"""Lecture (en lecture seule) du schéma réel des bases de données.

- SQLite : bibliothèque standard, fichiers .db/.sqlite/.sqlite3 trouvés dans le projet.
- PostgreSQL : si psycopg2 ou psycopg est installé dans l'interpréteur.
- MongoDB : si pymongo est installé ; les champs sont déduits d'un échantillon de documents.

Les URI de connexion sont transmises par variables d'environnement CARTOGRAPH_DB_<n>
(JSON {"name","type","uri"}), jamais en argument de ligne de commande.
"""
from __future__ import annotations

import os
import re
import sqlite3

SKIP_DIRS = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", "dist", "build", "site-packages", ".idea", ".vscode"}
SQLITE_EXT = (".db", ".sqlite", ".sqlite3", ".db3")
SQLITE_MAGIC = b"SQLite format 3\x00"
MAX_SQLITE_BYTES = 300 * 1024 * 1024
MAX_TABLES = 120
SAMPLE_DOCS = 60


def safe(uri):
    """URI sans identifiants, pour l'affichage."""
    return re.sub(r"//[^/@]*@", "//***@", uri or "")


def find_sqlite_files(root):
    out = []
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if f.lower().endswith(SQLITE_EXT):
                p = os.path.join(dp, f)
                try:
                    if os.path.getsize(p) > MAX_SQLITE_BYTES:
                        continue
                    with open(p, "rb") as fh:
                        if fh.read(16) != SQLITE_MAGIC:
                            continue
                except OSError:
                    continue
                out.append(p)
    return out[:8]


def read_sqlite(path, root):
    rel = os.path.relpath(path, root).replace(os.sep, "/")
    res = {"id": "db:sqlite:" + rel, "name": os.path.basename(path), "type": "sqlite", "source": rel, "tables": [], "error": None}
    try:
        uri = "file:" + path.replace("\\", "/") + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=3)
        cur = con.cursor()
        names = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        for name in names[:MAX_TABLES]:
            q = '"' + name.replace('"', '""') + '"'
            cols = []
            for cid, cname, ctype, notnull, _d, pk in cur.execute(f"PRAGMA table_info({q})"):
                cols.append({"name": cname, "type": ctype or "", "pk": bool(pk), "nullable": not notnull, "fk": None})
            by = {c["name"]: c for c in cols}
            for row in cur.execute(f"PRAGMA foreign_key_list({q})"):
                if row[3] in by:
                    by[row[3]]["fk"] = f"{row[2]}.{row[4]}" if row[4] else row[2]
            idx = []
            for row in cur.execute(f"PRAGMA index_list({q})").fetchall():
                idx.append({"name": row[1], "unique": bool(row[2])})
            try:
                rows = cur.execute(f"SELECT COUNT(*) FROM {q}").fetchone()[0]
            except sqlite3.Error:
                rows = None
            res["tables"].append({"name": name, "rows": rows, "columns": cols, "indexes": idx})
        con.close()
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {e}"
    return res


def read_postgres(cfg):
    res = {"id": "db:postgres:" + cfg["name"], "name": cfg["name"], "type": "postgres", "source": safe(cfg["uri"]), "tables": [], "error": None}
    try:
        try:
            import psycopg2 as pg  # type: ignore
            con = pg.connect(cfg["uri"], connect_timeout=5)
            con.set_session(readonly=True, autocommit=True)
        except ImportError:
            import psycopg as pg  # type: ignore
            con = pg.connect(cfg["uri"], connect_timeout=5)
            con.read_only = True
            con.autocommit = True
        cur = con.cursor()
        cur.execute("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position")
        tables = {}
        for t, c, typ, nul in cur.fetchall():
            tables.setdefault(t, {"name": t, "rows": None, "columns": [], "indexes": []})["columns"].append(
                {"name": c, "type": typ, "pk": False, "nullable": nul == "YES", "fk": None})
        cur.execute("""SELECT tc.table_name, kcu.column_name, tc.constraint_type, ccu.table_name, ccu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
            WHERE tc.table_schema='public' AND tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY')""")
        for t, c, kind, ft, fc in cur.fetchall():
            for col in tables.get(t, {"columns": []})["columns"]:
                if col["name"] == c:
                    if kind == "PRIMARY KEY":
                        col["pk"] = True
                    else:
                        col["fk"] = f"{ft}.{fc}"
        cur.execute("SELECT c.relname, c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
        for name, est in cur.fetchall():
            if name in tables and est is not None and est >= 0:
                tables[name]["rows"] = int(est)
        res["tables"] = sorted(tables.values(), key=lambda t: t["name"])[:MAX_TABLES]
        con.close()
    except ImportError:
        res["error"] = "Installe psycopg2 ou psycopg dans l'interpréteur Python utilisé par Cartograph."
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {str(e)[:200]}"
    return res


def read_mongo(cfg):
    res = {"id": "db:mongodb:" + cfg["name"], "name": cfg["name"], "type": "mongodb", "source": safe(cfg["uri"]), "tables": [], "error": None}
    try:
        import pymongo  # type: ignore
    except ImportError:
        res["error"] = "Installe pymongo dans l'interpréteur Python utilisé par Cartograph."
        return res
    try:
        client = pymongo.MongoClient(cfg["uri"], serverSelectionTimeoutMS=4000, connectTimeoutMS=4000)
        db = client.get_default_database() if client.get_default_database() is not None else None
        dbname = cfg.get("database")
        if dbname:
            db = client[dbname]
        if db is None:
            res["error"] = "Aucune base indiquée : ajoute le nom de la base dans l'URI (/ma_base) ou dans « database »."
            return res
        for name in sorted(db.list_collection_names())[:MAX_TABLES]:
            if name.startswith("system."):
                continue
            col = db[name]
            fields = {}
            n = 0
            for doc in col.find({}, limit=SAMPLE_DOCS):
                n += 1
                for k, v in doc.items():
                    fields.setdefault(k, set()).add(type(v).__name__)
            try:
                rows = col.estimated_document_count()
            except Exception:  # noqa: BLE001
                rows = None
            try:
                idx = [{"name": k, "unique": bool(v.get("unique"))} for k, v in col.index_information().items()]
            except Exception:  # noqa: BLE001
                idx = []
            columns = [{"name": k, "type": "|".join(sorted(t)), "pk": k == "_id", "nullable": True, "fk": None} for k, t in fields.items()]
            res["tables"].append({"name": name, "rows": rows, "columns": columns, "indexes": idx, "sampled": n})
        client.close()
    except Exception as e:  # noqa: BLE001
        res["error"] = f"{type(e).__name__}: {str(e)[:200]}"
    return res


def read_all(root, configs):
    out = [read_sqlite(p, root) for p in find_sqlite_files(root)]
    for cfg in configs:
        t = (cfg.get("type") or "").lower()
        if not cfg.get("uri"):
            continue
        if t in ("postgres", "postgresql"):
            out.append(read_postgres(cfg))
        elif t in ("mongo", "mongodb"):
            out.append(read_mongo(cfg))
        else:
            out.append({"id": "db:" + cfg.get("name", "?"), "name": cfg.get("name", "?"), "type": t, "source": "", "tables": [], "error": f"Type de base non géré : {t}"})
    return out
