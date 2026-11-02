"""Multi-meter ingest API and dashboard."""

from __future__ import annotations

import hmac
import mimetypes
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import config, db
from .config import ConfigError, Meter

mimetypes.add_type("font/woff2", ".woff2")

STATIC_DIR = Path(__file__).parent / "static"


def _validate_config() -> None:
    try:
        config.ensure_config()
        config.load_meters()
    except ConfigError as error:
        raise RuntimeError(str(error)) from error


@asynccontextmanager
async def lifespan(app: FastAPI):
    _validate_config()
    db.init_db()
    yield


app = FastAPI(
    title="Nahovnost metr",
    version="2.0.0",
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


def get_meter(slug: str) -> Meter:
    try:
        meter = config.find_meter(slug)
    except ConfigError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    if meter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown meter: {slug}",
        )
    return meter


def authorized_meter(
    meter: Meter = Depends(get_meter),
    x_api_token: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> Meter:
    """Accept `X-API-Token` or `Authorization: Bearer` for this meter."""
    supplied = x_api_token
    if not supplied and authorization:
        scheme, _, credentials = authorization.partition(" ")
        if scheme.lower() == "bearer":
            supplied = credentials.strip()
    if not supplied or not hmac.compare_digest(supplied, meter.token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return meter


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
    meter: str
    value: float
    created_at: float
    comment: str | None = None


@app.get("/api/health")
def health() -> dict:
    try:
        meters = config.load_meters()
    except ConfigError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    return {"status": "ok", "meters": len(meters), "time": time.time()}


@app.get("/api/meters")
def list_meters(response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    try:
        meters = config.load_meters()
    except ConfigError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    return {"meters": [meter.public() for meter in meters]}


@app.get("/api/meters/{slug}")
def meter_info(response: Response, meter: Meter = Depends(get_meter)) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return meter.public()


@app.post(
    "/api/meters/{slug}/readings",
    response_model=ReadingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_reading(
    payload: ReadingIn,
    meter: Meter = Depends(authorized_meter),
) -> dict:
    return db.add_reading(meter.slug, payload.value, payload.comment)


@app.get("/api/meters/{slug}/readings")
def list_readings(
    response: Response,
    hours: float = Query(default=24.0, gt=0, le=24 * 365),
    meter: Meter = Depends(get_meter),
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    latest = db.latest_reading(meter.slug)
    points, stats = db.readings_window(meter.slug, hours)
    now = time.time()
    return {
        "meter": meter.public(),
        "latest": latest,
        "latest_age_seconds": (now - latest["created_at"]) if latest else None,
        "window_hours": hours,
        "points": points,
        "stats": stats,
        "server_time": now,
    }


@app.get("/api/meters/{slug}/readings/all")
def list_all_readings(
    response: Response,
    meter: Meter = Depends(get_meter),
) -> dict:
    """Public export of every retained reading for one meter."""
    response.headers["Cache-Control"] = "no-store"
    readings = db.all_readings(meter.slug)
    return {"meter": meter.public(), "count": len(readings), "readings": readings}


def _dashboard_file() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/", include_in_schema=False)
def dashboard() -> FileResponse:
    return _dashboard_file()


@app.get("/m/{slug}", include_in_schema=False)
def meter_dashboard(slug: str) -> FileResponse:
    return _dashboard_file()


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
