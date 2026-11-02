"""Meters configuration stored next to the SQLite database."""

from __future__ import annotations

import json
import os
import secrets
import threading
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

CONFIG_PATH = Path(os.environ.get("METERS_CONFIG", "data/meters.json"))
SLUG_PATTERN = r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"

_lock = threading.Lock()
_cache: tuple[tuple[int, int], tuple["Meter", ...]] | None = None


class ConfigError(RuntimeError):
    """Raised when meters.json is missing or invalid."""


class MeterConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: str = Field(min_length=1, max_length=64, pattern=SLUG_PATTERN)
    name: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=240)
    token: str = Field(min_length=16, max_length=256)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be empty")
        return value

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("token")
    @classmethod
    def clean_token(cls, value: str) -> str:
        value = value.strip()
        if any(char.isspace() for char in value):
            raise ValueError("token must not contain whitespace")
        if len(value) < 16:
            raise ValueError("token must be at least 16 characters long")
        return value


class MetersFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    meters: list[MeterConfig]

    @model_validator(mode="after")
    def unique_fields(self) -> "MetersFile":
        slugs = [meter.slug for meter in self.meters]
        tokens = [meter.token for meter in self.meters]
        if len(slugs) != len(set(slugs)):
            raise ValueError("meter slugs must be unique")
        if len(tokens) != len(set(tokens)):
            raise ValueError("meter tokens must be unique")
        return self


@dataclass(frozen=True)
class Meter:
    slug: str
    name: str
    description: str | None
    token: str = field(repr=False)

    def public(self) -> dict:
        return {
            "slug": self.slug,
            "name": self.name,
            "description": self.description,
        }


def ensure_config() -> None:
    """Bootstrap a default meters file on first start.

    The generated file contains one meter and a random token. Users retrieve
    the token from the file and replace/extend the file as needed.
    """
    if CONFIG_PATH.exists():
        return
    payload = {
        "meters": [
            {
                "slug": "default",
                "name": "Výchozí měřidlo",
                "description": "Automaticky vytvořené měřidlo",
                "token": secrets.token_hex(32),
            }
        ]
    }
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.chmod(CONFIG_PATH, 0o600)
    except OSError as error:
        raise ConfigError(
            f"Cannot create meters config {CONFIG_PATH}: {error}"
        ) from error


def load_meters() -> tuple[Meter, ...]:
    """Load meters, re-reading the file when its mtime or size changes."""
    global _cache
    try:
        stat = CONFIG_PATH.stat()
    except FileNotFoundError as error:
        raise ConfigError(
            f"Meters config not found: {CONFIG_PATH}. "
            "Create it from meters.example.json."
        ) from error

    key = (stat.st_mtime_ns, stat.st_size)
    with _lock:
        if _cache is not None and _cache[0] == key:
            return _cache[1]

        try:
            payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ConfigError(
                f"Cannot read meters config {CONFIG_PATH}: {error}"
            ) from error

        try:
            parsed = MetersFile.model_validate(payload)
        except ValidationError as error:
            raise ConfigError(
                f"Invalid meters config {CONFIG_PATH}: {error}"
            ) from error

        meters = tuple(
            Meter(
                slug=item.slug,
                name=item.name,
                description=item.description,
                token=item.token,
            )
            for item in parsed.meters
        )
        _cache = (key, meters)
        return meters


def find_meter(slug: str) -> Meter | None:
    for meter in load_meters():
        if meter.slug == slug:
            return meter
    return None


def reset_cache() -> None:
    """Test helper: force the next load to re-read the file."""
    global _cache
    with _lock:
        _cache = None
