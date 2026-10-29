# Nahovnost meter

Jednoduchá webová aplikace pro sběr hodnot v rozsahu **0.00–1.00** přes HTTP API.
Hodnoty se ukládají do SQLite a dashboard zobrazuje nejnovější měření, statistiky
a graf za posledních 24 hodin.

Škála je sémantická: `0.00` = nejlepší (zelená), `1.00` = nejhorší (červená).

## Spuštění

```bash
cp .env.example .env
# vygenerujte token a vložte ho do .env jako API_TOKEN
openssl rand -hex 32

docker compose up -d --build
```

Dashboard běží na <http://localhost:8080> (port lze změnit přes `PORT` v `.env`).

Zápis dat:

```bash
curl -X POST http://localhost:8080/api/readings \
  -H "Content-Type: application/json" \
  -H "X-API-Token: $API_TOKEN" \
  -d '{"value": 0.42}'
```

Token lze poslat i jako `Authorization: Bearer <token>`. Hodnoty mimo rozsah
`0.00–1.00` a nečíselné vstupy API odmítne s `422`.

## API

| Metoda | Cesta            | Autorizace | Popis                                      |
| ------ | ---------------- | ---------- | ------------------------------------------ |
| `POST` | `/api/readings`  | token      | Uloží jedno měření (`{"value": 0.42}`).     |
| `GET`  | `/api/readings`  | ne         | Nejnovější hodnota, body a statistiky.      |
| `GET`  | `/api/health`    | ne         | Healthcheck.                               |
| `GET`  | `/docs`          | ne         | Interaktivní OpenAPI dokumentace.           |

`GET /api/readings?hours=24` vrací například:

```json
{
  "latest": { "id": 12, "value": 0.42, "created_at": 1793290136.4 },
  "latest_age_seconds": 8.2,
  "window_hours": 24.0,
  "points": [{ "t": 1793290136.4, "v": 0.42 }],
  "stats": { "count": 1, "min": 0.42, "max": 0.42, "avg": 0.42 },
  "server_time": 1793290144.6
}
```

Časy jsou UNIX timestampy v UTC (sekundy). Při hustém sběru se body pro graf
zprůměrují na maximálně 1500 bodů, statistika vždy počítá ze všech vzorků.

## Konfigurace

| Proměnná         | Výchozí             | Význam                                      |
| ---------------- | ------------------- | ------------------------------------------- |
| `API_TOKEN`      | – (povinné)         | Token pro zápis, min. 8 znaků.              |
| `PORT`           | `8080`              | Port na hostiteli (řeší compose).           |
| `RETENTION_DAYS` | `30`                | Jak dlouho se data uchovávají.              |
| `DB_PATH`        | `/data/readings.db` | Cesta k SQLite (v kontejneru).              |

Data jsou v pojmenovaném Docker volume `data`, takže přežijí restart i rebuild.

## Vývoj bez Dockeru

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

API_TOKEN=dev-token-123456 DB_PATH=data/readings.db \
  uvicorn app.main:app --reload
```

Testy:

```bash
pytest -q
```

## Struktura

```
app/
  main.py          FastAPI aplikace, autentizace, API
  db.py            SQLite schéma, zápis, dotazy, downsampling
  static/
    index.html     dashboard
    style.css
    app.js         načítání dat a canvasový graf
Dockerfile
docker-compose.yml
```

## Bezpečnostní poznámky

- Čtení (`GET /api/readings`) je veřejné, protože ho používá dashboard. Zápis
  vyžaduje token.
- Token se porovnává v konstantním čase. Pro produkci použijte dlouhý náhodný
  token a aplikaci nasaďte za HTTPS reverse proxy (Caddy, Nginx, Traefik).
- Aplikace nemá rate limiting; při veřejném vystavení zvažte limit na proxy.
- Kontejner běží jako neprivilegovaný uživatel.
