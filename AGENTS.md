# Repository guide

FastAPI + SQLite app for multiple meters in one instance. Backend:
`app/main.py` (routes/auth), `app/config.py` (meters config), `app/db.py` (raw
`sqlite3`). Frontend: `app/static/`, served as-is with no build step.

## Commands

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

METERS_CONFIG=data/meters.json DB_PATH=data/readings.db \
  uvicorn app.main:app --reload
```

- Tests: `pytest -q`; one test:
  `pytest tests/test_api.py::test_ingest_stores_optional_comment -q`.
- JS syntax only: `node --check app/static/app.js`. No lint, typecheck or CI is configured.
- Docker: `docker compose up -d --build`; UI <http://localhost:8080> → container 8000.
- Docker health check: `/api/health`.

## Configuration

- Meters and their tokens live in `meters.json` (local `data/meters.json`,
  container `/data/meters.json`, override `METERS_CONFIG`). If missing, startup
  creates a `default` meter with a random token, mode `600`.
- Configuration is re-read when its mtime/size changes; a valid edit needs no
  restart. Invalid configuration makes `/api/health` and data endpoints return
  `503`; startup fails if the initial file is invalid.
- Each meter has a unique lowercase `slug`, `name`, optional `description`,
  optional hex `color` (`#rrggbb`), and a unique token of at least 16 characters.
  The color tints the overview card and the detail page background. Tokens must
  never appear in logs, `/api/meters`, or committed files.
- `METERS_CONFIG`, `DB_PATH` and `RETENTION_DAYS` are read at module import.
  Tests must set them before importing `app`.
- `.env` is optional and only carries `PORT` / `RETENTION_DAYS` / optional
  `METERS_CONFIG`; there is no global `API_TOKEN`.

## Backend and data

- One SQLite DB stores all meters in `readings.meter`. Older DBs are migrated at
  startup: missing `meter` gets `DEFAULT 'default'`, so legacy data appears under
  a meter named `default`; config must include that slug to expose it.
- No ORM/migration framework. `db.init_db()` runs in the lifespan. Schema changes
  must be idempotent: add columns via `PRAGMA table_info` + `ALTER TABLE` (see
  `meter` and `comment`).
- Timestamps are Unix seconds UTC. `readings_window` defaults to 24 h, caps chart
  points at `MAX_POINTS = 1500` (bucket average, newest comment per bucket) while
  stats use every sample. Retention is enforced on insert, not on reads.
- API paths are per meter: `POST /api/meters/{slug}/readings`,
  `GET /api/meters/{slug}/readings?hours=24`, `GET /api/meters/{slug}/readings/all`.
  Metadata: `GET /api/meters` and `GET /api/meters/{slug}`.
- Reads are public; only POST requires the slug's token (`X-API-Token` or
  Bearer). Comments are public data — never store secrets there. No CORS is
  configured.
- Keep the custom `RequestValidationError` handler: it prevents reflected input
  and a 500 when NaN/Infinity fails serialization.

## Frontend and design

- `/` is the overview with one small chart per meter; `/m/{slug}` is the detail
  with the full chart. Both views live in `index.html` and are switched by the
  route parsed in `app.js`. The server serves the same HTML for both routes.
- Follow the available design-system reference. It is intentionally implemented
  without Tailwind/npm: Material 3 tokens live in `app/static/style.css` under
  `:root` and `.dark`, light theme is the default, and theme choice is persisted
  in `localStorage`. Use tokens, not raw hex values, in markup or JS.
- Fonts are self-hosted in `app/static/fonts`; do not add CDN dependencies.
- Charts resolve CSS colors at runtime. Define new colors in both themes and keep
  the redraw on theme change. The detail hover-comment strip has fixed `6rem`
  height; its `mouseleave` lives on `#chart-live`, not the canvas.
- Header logo is `app/static/logo.png` in a 40×40 slot. User-facing name is
  “Nahovnost metr”.
- API examples are duplicated in `README.md` and the topbar help panel
  (`#api-help` in `index.html`); update both for API changes.
- UI changes should be checked at 320/390/1440 px, in both themes, with no
  horizontal overflow or console errors.

## Tests

- `tests/test_api.py` writes a temporary meters config and sets `METERS_CONFIG`
  and `DB_PATH` before importing the app; keep that import order.
- All tests share one temporary SQLite DB. Do not assume an empty table; insert
  data inside the test and use assertions tolerant of earlier rows.
- Config tests monkeypatch `config.CONFIG_PATH` and call `config.reset_cache()`.

## Docker

- Runs as non-root uid 10001; `/data` must stay writable so the app can create
  `meters.json` and the SQLite WAL files.
- Data and `meters.json` live in the compose `data` volume. `docker compose
  down -v` is destructive and wipes both.
