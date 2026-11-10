import sqlite3

from app.core.db import get_db
from app.models.user import User


async def find_by_email(email: str):
    return await get_db().users.find_one({"email": email})


async def insert_user(doc: dict):
    res = await get_db().users.insert_one(doc)
    return str(res.inserted_id)


async def count_users():
    return await User.find().count()


def legacy_report(name: str):
    conn = sqlite3.connect("legacy.db")
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM reports WHERE name = '{name}'")
    return cur.fetchall()


def orphan_helper():
    return 42
