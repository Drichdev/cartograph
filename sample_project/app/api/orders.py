from fastapi import APIRouter, BackgroundTasks, Depends

from app.core.db import get_db
from app.core.deps import get_service
from app.core.security import get_current_user
from app.services.order_service import place_order

router = APIRouter(prefix="/orders")


@router.post("/")
async def create_order(payload: dict, background: BackgroundTasks, user=Depends(get_current_user)):
    return await place_order(payload, background)


@router.get("/")
async def list_orders(db=Depends(get_db), user=Depends(get_current_user)):
    return await db.orders.find({}).to_list(100)


@router.get("/export")
async def export_orders(svc=Depends(get_service), user=Depends(get_current_user)):
    return svc.export_csv()
