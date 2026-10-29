"""Nahovnost meter: token-protected ingest API plus a small read-only dashboard."""

from __future__ import annotations

import hmac
import mimetypes
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import db

mimetypes.add_type("font/woff2", ".woff2")

STATIC_DIR = Path(__file__).parent / "static"
API_TOKEN = os.environ.get("API_TOKEN", "")


def _validate_config() -> None:
    if not API_TOKEN:
        raise RuntimeError(
            "API_TOKEN is not set. Set it in the environment (see .env.example)."
        )
    if len(API_TOKEN) < 8:
        raise RuntimeError("API_TOKEN must be at least 8 characters long.")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _validate_config()
    db.init_db()
    yield


app = FastAPI(
    title="Nahovnost meter",
    version="1.1.0",
    lifespan=lifespan,
)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _request, exc: RequestValidationError
) -> JSONResponse:
    """Compact 422 response.

    The default handler echoes the offending input, which breaks on non-finite
    JSON numbers (NaN/Infinity) and reflects arbitrary payloads back.
    """
    errors = [
        {
            "loc": list(error.get("loc", ())),
            "msg": error.get("msg", "invalid value"),
            "type": error.get("type", "value_error"),
        }
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": errors})


def require_token(
    x_api_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    """Accept either `X-API-Token: <token>` or `Authorization: Bearer <token>`."""
    supplied = x_api_token
    if not supplied and authorization:
        scheme, _, credentials = authorization.partition(" ")
        if scheme.lower() == "bearer":
            supplied = credentials.strip()
    if not supplied or not hmac.compare_digest(supplied, API_TOKEN):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


class ReadingIn(BaseModel):
    value: float = Field(
        ge=0.0,
        le=1.0,
        allow_inf_nan=False,
        description="0.00 = best, 1.00 = worst",
    )
    comment: str | None = Field(
        default=None,
        max_length=500,
        description="Optional free-form note stored with the reading.",
    )

    @field_validator("comment")
    @classmethod
    def normalize_comment(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ReadingOut(BaseModel):
    id: int
    value: float
    created_at: float
    comment: str | None = None


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "time": time.time()}


@app.post(
    "/api/readings",
    response_model=ReadingOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_token)],
)
def create_reading(payload: ReadingIn) -> dict:
    return db.add_reading(payload.value, payload.comment)


@app.get("/api/readings")
def list_readings(
    response: Response,
    hours: float = Query(default=24.0, gt=0, le=24 * 365),
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    latest = db.latest_reading()
    points, stats = db.readings_window(hours)
    now = time.time()
    return {
        "latest": latest,
        "latest_age_seconds": (now - latest["created_at"]) if latest else None,
        "window_hours": hours,
        "points": points,
        "stats": stats,
        "server_time": now,
    }


@app.get("/api/readings/all")
def list_all_readings(response: Response) -> dict:
    """Public export of every retained reading, oldest first."""
    response.headers["Cache-Control"] = "no-store"
    readings = db.all_readings()
    return {"count": len(readings), "readings": readings}


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
