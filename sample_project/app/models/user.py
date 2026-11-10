from typing import Optional

from beanie import Document
from pydantic import BaseModel


class User(Document):
    email: str
    name: str
    password_hash: str
    plan: Optional[str] = None

    class Settings:
        name = "users"


class UserIn(BaseModel):
    email: str
    name: str
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    name: str
