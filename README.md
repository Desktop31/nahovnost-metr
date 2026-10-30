# Nahovnost metr

Jednoduchá webová aplikace pro sběr hodnot v rozsahu **0.00–1.00** přes HTTP API.
Hodnoty se ukládají do SQLite a dashboard zobrazuje nejnovější měření, statistiky
a graf za posledních 24 hodin.

Škála je sémantická: `0.00` = nejlepší (zelená), `1.00` = nejhorší (červená).

## Spuštění

```bash
cp .env.example .env
# vygenerujte token a vložte ho do .env jako API_TOKEN
openssl rand -hex 32
# pokud openssl není k dispozici:
python3 -c "import secrets; print(secrets.token_hex(32))"

docker compose up -d --build
```

Dashboard běží na <http://localhost:8080> (port lze změnit přes `PORT` v `.env`).

Zápis dat (komentář je volitelný, max. 500 znaků):

```bash
curl -X POST http://localhost:8080/api/readings \
  -H "Content-Type: application/json" \
  -H "X-API-Token: $API_TOKEN" \
  -d '{"value": 0.42, "comment": "ranní kontrola"}'
```

Token lze poslat i jako `Authorization: Bearer <token>`. Hodnoty mimo rozsah
`0.00–1.00`, nečíselné vstupy a příliš dlouhé komentáře API odmítne s `422`.

## API

| Metoda | Cesta               | Autorizace | Popis                                       |
| ------ | ------------------- | ---------- | ------------------------------------------- |
| `POST` | `/api/readings`     | token      | Uloží měření a volitelný `comment`.          |
| `GET`  | `/api/readings`     | ne         | Nejnovější hodnota, body a statistiky.      |
| `GET`  | `/api/readings/all` | ne         | Všechna uložená měření včetně komentářů.     |
| `GET`  | `/api/health`       | ne         | Healthcheck.                                |
| `GET`  | `/docs`             | ne         | Interaktivní OpenAPI dokumentace.            |

`GET /api/readings?hours=24` vrací například:

```json
{
  "latest": {
    "id": 12,
    "value": 0.42,
    "created_at": 1793290136.4,
    "comment": "ranní kontrola"
  },
  "latest_age_seconds": 8.2,
  "window_hours": 24.0,
  "points": [
    { "t": 1793290136.4, "v": 0.42, "c": "ranní kontrola" }
  ],
  "stats": { "count": 1, "min": 0.42, "max": 0.42, "avg": 0.42 },
  "server_time": 1793290144.6
}
```

Pole `c` u bodu je volitelný komentář; chybí, pokud měření komentář nemá.
Při přejetí grafem se komentář daného bodu zobrazí v pevně vysokém pruhu
nad grafem.

`GET /api/readings/all` je veřejný export bez tokenu. Vrací všechna měření
vzestupně (od nejstaršího) včetně komentářů:

```json
{
  "count": 1,
  "readings": [
    {
      "id": 12,
      "value": 0.42,
      "created_at": 1793290136.4,
      "comment": "ranní kontrola"
    }
  ]
}
```

Časy jsou UNIX timestampy v UTC (sekundy). Při hustém sběru se body pro graf
zprůměrují na maximálně 1500 bodů, statistika vždy počítá ze všech vzorků.
Stejné instrukce jsou i v dashboardu pod ikonou otazníku v horním baru.

## Konfigurace

| Proměnná         | Výchozí             | Význam                                      |
| ---------------- | ------------------- | ------------------------------------------- |
| `API_TOKEN`      | – (povinné)         | Token pro zápis, min. 8 znaků.              |
| `PORT`           | `8080`              | Port na hostiteli (řeší compose).           |
| `RETENTION_DAYS` | `30`                | Jak dlouho se data uchovávají.              |
| `DB_PATH`        | `/data/readings.db` | Cesta k SQLite (v kontejneru).              |

Data jsou v pojmenovaném Docker volume `data`, takže přežijí restart i rebuild.

## Vzhled

UI vychází z projektového design systému: Material 3 paleta jako CSS tokeny
(`--color-*` v `:root` a `.dark`), Manrope pro nadpisy a čísla, Inter pro text,
karty `rounded-xl` s `border-outline-variant` a `shadow-sm`, světlý režim jako
výchozí a tmavý režim přes tlačítko v hlavičce (volba se ukládá do
`localStorage`). Graf čte barvy z tokenů za běhu, takže se přepíná spolu s
motivem. Nad grafem je pruh s pevnou výškou, který při přejetí zobrazí komentář
bodu pod kurzorem. Fonty jsou self-hostované v `app/static/fonts` (licence SIL
OFL).

Frontend zůstává bez build kroku, proto tokeny spotřebovává přímo CSS místo
Tailwind `@theme`; nevzniká tím druhá sada hodnot.

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
    style.css      design tokeny, světlý a tmavý režim
    app.js         načítání dat, canvasový graf, přepínání motivu
    logo.svg       logo (1:1, nahraditelné)
    fonts/         Inter a Manrope (SIL OFL)
Dockerfile
docker-compose.yml
```

## Bezpečnostní poznámky

- Čtení (`GET /api/readings`, `GET /api/readings/all`) je veřejné, protože ho
  používá dashboard a veřejný export. Zápis vyžaduje token.
- Komentáře jsou součástí veřejných dat; neukládejte do nich citlivé údaje.
- Token se porovnává v konstantním čase. Pro produkci použijte dlouhý náhodný
  token a aplikaci nasaďte za HTTPS reverse proxy (Caddy, Nginx, Traefik).
- Aplikace nemá rate limiting; při veřejném vystavení zvažte limit na proxy.
- Kontejner běží jako neprivilegovaný uživatel.
