from motor.motor_asyncio import AsyncIOMotorClient

from app.core.config import MONGO_URL

client = AsyncIOMotorClient(MONGO_URL)
db = client.boutique


def get_db():
    return db
