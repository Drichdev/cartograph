from fastapi import APIRouter, Depends

from app.core.security import get_current_user
from app.models.user import UserIn
from app.services.user_service import UserService

router = APIRouter(prefix="/users")
service = UserService()


@router.post("/")
async def create_user(data: UserIn):
    return await service.create(data)


@router.get("/{email}")
async def get_user(email: str, user=Depends(get_current_user)):
    return await service.get(email)


@router.delete("/{email}")
async def delete_user(email: str):
    return {"deleted": email}
