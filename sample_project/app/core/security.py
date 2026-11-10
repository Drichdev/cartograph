import hashlib

import jwt

from app.core.config import JWT_SECRET


def hash_password(password: str) -> str:
    return hashlib.md5(password.encode()).hexdigest()


def decode_token(token: str):
    return jwt.decode(token, JWT_SECRET, options={"verify_signature": False})


def get_current_user(token: str = ""):
    return decode_token(token)
