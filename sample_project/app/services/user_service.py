from app.core.cache import get_cached, set_cached
from app.core.security import hash_password
from app.models.user import UserIn
from app.repositories import user_repo
from app.workers.tasks import send_welcome_email


class UserService:
    async def create(self, data: UserIn):
        existing = await user_repo.find_by_email(data.email)
        if existing:
            raise ValueError("email déjà utilisé")
        doc = {"email": data.email, "name": data.name, "password_hash": hash_password(data.password)}
        user_id = await user_repo.insert_user(doc)
        send_welcome_email.delay(user_id)
        return user_id

    async def get(self, email: str):
        cached = await get_cached(f"user:{email}")
        if cached:
            return cached
        user = await user_repo.find_by_email(email)
        if user:
            await set_cached(f"user:{email}", {"email": user["email"], "name": user["name"]})
        return user

    def export_csv(self):
        return "legacy"


def format_user_label(user: dict) -> str:
    name = user.get("name", "").strip()
    email = user.get("email", "").strip().lower()
    if not name:
        name = email.split("@")[0]
    label = f"{name} <{email}>"
    if len(label) > 60:
        label = label[:57] + "..."
    return label
