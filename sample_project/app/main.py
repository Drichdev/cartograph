from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import users, orders
from app.core.cache import warm_cache

app = FastAPI(title="Boutique")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"])
app.include_router(users.router)
app.include_router(orders.router)


@app.on_event("startup")
async def startup():
    await warm_cache()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", debug=True)
