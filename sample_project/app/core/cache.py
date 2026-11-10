import json

import redis.asyncio as redis

from app.core.config import REDIS_URL

redis_client = redis.from_url(REDIS_URL)


async def get_cached(key: str):
    raw = await redis_client.get(key)
    return json.loads(raw) if raw else None


async def set_cached(key: str, value, ttl: int = 60):
    await redis_client.set(key, json.dumps(value), ex=ttl)


async def warm_cache():
    await set_cached("boot", {"ok": True})


async def flush_everything():
    await redis_client.flushall()
