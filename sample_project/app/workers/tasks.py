from app.core.cache import set_cached
from app.repositories.order_repo import list_orders
from app.workers.celery_app import celery_app


@celery_app.task
def send_welcome_email(user_id: str):
    return f"email envoyé à {user_id}"


@celery_app.task
def send_receipt(order_id: str):
    set_cached(f"receipt:{order_id}", True)
    return order_id


@celery_app.task
def nightly_cleanup():
    return list_orders("all")
