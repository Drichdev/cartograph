from typing import List

from pydantic import BaseModel

from app.models.user import UserOut


class OrderItem(BaseModel):
    sku: str
    qty: int
    price: float


class Order(BaseModel):
    id: str
    customer: UserOut
    items: List[OrderItem]
    total: float
