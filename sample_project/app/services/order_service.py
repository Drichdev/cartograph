from fastapi import BackgroundTasks

from app.repositories import order_repo
from app.services.user_service import UserService
from app.workers.tasks import send_receipt


async def place_order(payload: dict, background: BackgroundTasks):
    order_id = await order_repo.save_order(payload)
    send_receipt.delay(order_id)
    background.add_task(audit_order, order_id)
    return order_id


def audit_order(order_id: str):
    return order_id


def format_order_label(order: dict) -> str:
    name = order.get("title", "").strip()
    ref = order.get("ref", "").strip().lower()
    if not name:
        name = ref.split("-")[0]
    label = f"{name} <{ref}>"
    if len(label) > 60:
        label = label[:57] + "..."
    return label


def compute_discount(total, qty, vip, coupon, season, country, channel, legacy):
    discount = 0
    if vip:
        discount += 10
    if qty > 10 and total > 100:
        discount += 5
    elif qty > 5:
        discount += 2
    if coupon == "BF" and season == "winter":
        discount += 15
    for c in ("FR", "BE"):
        if country == c and channel == "web":
            discount += 1
    if legacy or (vip and coupon):
        discount += 3
    return discount
