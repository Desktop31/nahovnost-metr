# Repository guide

FastAPI + SQLite API with a static dashboard. Backend: `app/main.py` (routes,
auth), `app/db.py` (raw `sqlite3`). Frontend: `app/static/`, served as-is with
no build step.

## Commands

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

API_TOKEN=dev-token-123456 DB_PATH=data/readings.db \
  uvicorn app.main:app --reload
```

- Tests: `pytest -q`; one test:
  `pytest tests/test_api.py::test_ingest_stores_optional_comment -q`.
- JS syntax only: `node --check app/static/app.js`. No lint, typecheck or CI is configured.
- Docker: `cp .env.example .env` (set `API_TOKEN`), then `docker compose up -d --build`.
- UI: <http://localhost:8080> → container port 8000. Health: `/api/health`.

## Configuration gotchas

- `API_TOKEN`, `DB_PATH` and `RETENTION_DAYS` are read at module import. Restart
  uvicorn after changing them; tests must set env vars before importing `app`.
- `API_TOKEN` is required and must be at least 8 characters. Compose refuses to
  start without it; `.env` is gitignored.
- Local default DB is `data/readings.db`; the container uses `/data/readings.db`
  on the `data` volume.
- Host port defaults to 8080 because 8000 is occupied by Portainer on the dev
  machine; the app itself always listens on 8000.

## Backend and data

- No ORM or migration framework. `db.init_db()` runs in the lifespan. Schema
  changes must be idempotent: `CREATE TABLE IF NOT EXISTS` does not alter
  existing DBs, so add columns via `PRAGMA table_info` + `ALTER TABLE` (see the
  `comment` migration).
- Timestamps are Unix seconds in UTC. `GET /api/readings` defaults to 24 h.
  Above `MAX_POINTS = 1500`, chart points are bucket-averaged; stats always use
  every sample. Buckets keep the newest comment as hover context.
- Retention is enforced on insert (`add_reading` deletes old rows), not on reads.
- Comments are optional, max 500 characters, trimmed, blank → `null`. They are
  returned by `GET /api/readings` (latest, and `c` on points) and
  `GET /api/readings/all` (oldest first).
- Reads are public; only `POST /api/readings` requires `X-API-Token` or Bearer.
  Comments are public data — never store secrets there. No CORS middleware is
  configured.
- Keep the custom `RequestValidationError` handler: it prevents reflected input
  and a 500 when NaN/Infinity fails serialization.

## Frontend and design

- Follow the available design-system reference. It is intentionally implemented
  without Tailwind/npm: Material 3 tokens live in `app/static/style.css` under
  `:root` and `.dark`, light theme is the default, and theme choice is persisted
  in `localStorage`. Use tokens, not raw hex values, in markup or JS.
- Fonts are self-hosted in `app/static/fonts`; do not add CDN dependencies.
- The canvas chart resolves CSS colors at runtime. Define new colors in both
  themes and keep the redraw on theme change. The hover-comment strip has a
  fixed `6rem` height to prevent layout jumps; its `mouseleave` lives on
  `#chart-live`, not the canvas, so long comments remain scrollable.
- Header logo is `app/static/logo.png` in a 40×40 slot. User-facing name is
  “Nahovnost metr”.
- API examples are duplicated in `README.md` and the topbar help panel
  (`#api-help` in `index.html`); update both for API changes.
- UI changes should be checked at 320/390/1440 px, in both themes, with no
  horizontal overflow or console errors.

## Tests

- `tests/test_api.py` sets `API_TOKEN` and `DB_PATH` before importing the app;
  keep that import order.
- All tests share one temporary SQLite DB. Do not assume an empty table; insert
  data inside the test and use assertions tolerant of earlier rows.

## Docker

- Runs as non-root uid 10001; `/data` must stay writable by the volume.
- SQLite data lives in the compose `data` volume. `docker compose down -v` is
  destructive and wipes it.
