from app.core.db import get_db


async def save_order(order: dict):
    res = await get_db().orders.insert_one(order)
    return str(res.inserted_id)


async def list_orders(user_id: str):
    return await get_db().orders.find({"user": user_id}).to_list(100)
