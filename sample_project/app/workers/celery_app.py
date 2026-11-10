from celery import Celery

from app.core.config import REDIS_URL

celery_app = Celery("boutique", broker=REDIS_URL, backend="redis://redis:6379/1")
