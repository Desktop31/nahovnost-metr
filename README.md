# Nahovnost metr

Více měřidel v jedné instanci. Každé měřidlo má vlastní slug, vlastní API a
vlastní secret token. Hlavní stránka zobrazuje grafy všech měřidel, detail
jednoho měřidla je na `/m/{slug}`.

Škála je sémantická: `0.00` = nejlepší (zelená), `1.00` = nejhorší (červená).

## Spuštění

```bash
docker compose up -d --build
```

Při prvním startu se ve volume vedle databáze vytvoří `/data/meters.json` s
jedním měřidlem `default` a náhodným tokenem:

```bash
docker exec nahovnost-metr cat /data/meters.json
```

Konfiguraci upravte takto:

```bash
docker cp nahovnost-metr:/data/meters.json ./meters.json
# upravte měřidla a tokeny
docker cp ./meters.json nahovnost-metr:/data/meters.json
```

Změny se načtou při dalším požadavku, restart není potřeba. Dashboard běží na
<http://localhost:8080>; port lze změnit přes `PORT` v `.env`.

Formát konfigurace (vzor je v `meters.example.json`):

```json
{
  "meters": [
    {
      "slug": "sklad",
      "name": "Sklad",
      "description": "Teplota a vlhkost ve skladu",
      "color": "#4f9d69",
      "token": "dlouhy-nahodny-token"
    },
    {
      "slug": "kotelna",
      "name": "Kotelna",
      "color": "#d96c4f",
      "token": "jiny-dlouhy-nahodny-token"
    }
  ]
}
```

- `slug` je unikátní, malými písmeny, číslicemi a pomlčkami.
- `color` je volitelný hex odstín (`#rrggbb`) pro jemný akcent karty v přehledu
  a pozadí detailu.
- `token` je unikátní, alespoň 16 znaků. Token se nikdy nevrací v API.
- Existujícím datům z původní jednoverzové verze se při migraci přiřadí
  měřidlo `default`; pokud je chcete dál vidět, nechte `default` v konfiguraci.

## API

| Metoda | Cesta                                  | Autorizace | Popis                                       |
| ------ | -------------------------------------- | ---------- | ------------------------------------------- |
| `GET`  | `/api/meters`                          | ne         | Seznam měřidel bez tokenů.                   |
| `GET`  | `/api/meters/{slug}`                   | ne         | Metadata jednoho měřidla.                    |
| `POST` | `/api/meters/{slug}/readings`          | token      | Uloží měření a volitelný `comment`.          |
| `GET`  | `/api/meters/{slug}/readings`          | ne         | Nejnovější hodnota, body a statistiky.       |
| `GET`  | `/api/meters/{slug}/readings/all`      | ne         | Všechna měření měřidla včetně komentářů.     |
| `GET`  | `/api/health`                          | ne         | Healthcheck včetně kontroly konfigurace.     |
| `GET`  | `/docs`                                | ne         | Interaktivní OpenAPI dokumentace.            |

Zápis (komentář je volitelný, max. 500 znaků):

```bash
curl -X POST http://localhost:8080/api/meters/sklad/readings \
  -H "Content-Type: application/json" \
  -H "X-API-Token: $METER_TOKEN" \
  -d '{"value": 0.42, "comment": "ranní kontrola"}'
```

Token lze poslat i jako `Authorization: Bearer <token>`. Token musí patřit
danému měřidlu. Hodnoty mimo rozsah `0.00–1.00`, nečíselné vstupy a příliš
dlouhé komentáře API odmítne s `422`.

`GET /api/meters` vrací seznam měřidel bez tokenů, včetně volitelné barvy:

```json
{
  "meters": [
    { "slug": "sklad", "name": "Sklad", "description": null, "color": "#4f9d69" }
  ]
}
```

`GET /api/meters/{slug}/readings?hours=24` vrací například:

```json
{
  "meter": {
    "slug": "sklad",
    "name": "Sklad",
    "description": null,
    "color": "#4f9d69"
  },
  "latest": {
    "id": 12,
    "meter": "sklad",
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
nad grafem. `GET /api/meters/{slug}/readings/all` vrací všechna uchovaná měření
vzestupně, včetně komentářů.

Časy jsou UNIX timestampy v UTC (sekundy). Při hustém sběru se body pro graf
zprůměrují na maximálně 1500 bodů, statistika vždy počítá ze všech vzorků.

## Přidání hodnoty v dashboardu

Tlačítko **+** v horním baru otevře formulář pro zápis hodnoty. Na přehledu
vyberete měřidlo, na detailu je pevně dané. Formulář obsahuje slider s ručním
zápisem čísla, volitelný komentář a token měřidla.

Token se po úspěšném zápisu uloží do `localStorage` prohlížeče pod klíčem
`nahovnost-token:<slug>`. Při dalším otevření je pole tokenu zakázané a vedle
něj je tlačítko **Smazat uložený token**. Token se neposílá do prohlížeče ze
serveru; uživatel ho zadává sám.

## Migrace starých databází

Nová databáze má jeden soubor a sloupec `meter`. Každou starou
jednoměřidlovou databázi importujte zvlášť pod jiným slugem. Skript
`app.import_legacy` zachová `value`, `created_at` i `comment`, doplní `meter` a
při opakování přeskočí již importované řádky.

Nejprve zastavte staré aplikace. Pokud jejich SQLite používal WAL, vytvořte
konzistentní kopii (pro každou starou DB):

```bash
python3 - <<'PY'
import sqlite3
src = sqlite3.connect("stara1.db")
dst = sqlite3.connect("stara1-kopie.db")
src.backup(dst)
dst.close()
src.close()
PY
```

Pokud stará DB leží v Docker volume, zkopírujte ji po zastavení původního
kontejneru přes `docker cp stary-kontejner:/data/readings.db ./stara1.db` a
teprve pak vytvořte záložní kopii výše.

Potom jednou inicializujte novou instanci a zastavte ji:

```bash
docker compose up -d --build
docker compose stop meter
docker cp nahovnost-metr:/data/readings.db ./readings-backup.db
```

Import opakujte pro každou starou databázi:

```bash
docker compose run --rm \
  -v "$PWD/stara1-kopie.db:/tmp/stara1.db:ro" \
  meter python -m app.import_legacy \
  --source /tmp/stara1.db --target /data/readings.db --meter domov

docker compose run --rm \
  -v "$PWD/stara2-kopie.db:/tmp/stara2.db:ro" \
  meter python -m app.import_legacy \
  --source /tmp/stara2.db --target /data/readings.db --meter chalupa
```

Nakonec přidejte oba slugy a jejich tokeny do `meters.json` ve volume a
spusťte aplikaci:

```bash
docker cp nahovnost-metr:/data/meters.json ./meters.json
# upravit meters.json
docker cp ./meters.json nahovnost-metr:/data/meters.json
docker compose up -d
```

Tokeny se z databáze migrovat nedají – stará verze je měla v `API_TOKEN` v
prostředí. Použijte známé tokeny, nebo vygenerujte nové a upravte klienty.

Poznámky:

- Import je idempotentní: opakované spuštění stejné DB přeskočí duplicity
  podle kombinace měřidlo + čas + hodnota + komentář.
- Pokud už zdroj obsahuje sloupec `meter`, vyberte zdrojový slug přes
  `--source-meter`.
- Starší data než `RETENTION_DAYS` (výchozí 30 dní) aplikace smaže při dalším
  zápisu. Pokud je potřebujete, zvyšte `RETENTION_DAYS` ještě před startem.
- Bez Dockeru stačí spustit stejný modul ručně:
  `METERS_CONFIG=data/meters.json DB_PATH=data/readings.db python -m app.import_legacy --source stara1.db --meter domov`.

## Konfigurace

| Proměnná         | Výchozí             | Význam                                      |
| ---------------- | ------------------- | ------------------------------------------- |
| `METERS_CONFIG`  | `/data/meters.json` | Cesta ke konfiguraci měřidel.               |
| `DB_PATH`        | `/data/readings.db` | Cesta k SQLite (v kontejneru).              |
| `RETENTION_DAYS` | `30`                | Jak dlouho se data uchovávají.              |
| `PORT`           | `8080`              | Port na hostiteli (řeší compose).           |

Data i konfigurace jsou v pojmenovaném Docker volume `data`, takže přežijí
restart i rebuild.

## Vzhled

Hlavní stránka je přehled všech měřidel s malými grafy; detail na `/m/{slug}`
obsahuje velký graf, statistiky a komentáře. UI vychází z projektového design
systému: Material 3 paleta jako CSS tokeny (`--color-*` v `:root` a `.dark`),
Manrope pro nadpisy a čísla, Inter pro text, světlý režim jako výchozí a tmavý
režim přes tlačítko v hlavičce. Fonty jsou self-hostované v
`app/static/fonts` (licence SIL OFL).

Frontend zůstává bez build kroku, proto tokeny spotřebovává přímo CSS místo
Tailwind `@theme`; nevzniká tím druhá sada hodnot.

## Vývoj bez Dockeru

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt

METERS_CONFIG=data/meters.json DB_PATH=data/readings.db \
  uvicorn app.main:app --reload
```

Při prvním spuštění se `data/meters.json` vytvoří automaticky; token vypíšete
příkazem `cat data/meters.json`. Testy:

```bash
pytest -q
```

## Struktura

```
app/
  main.py          FastAPI aplikace, autentizace, API
  config.py        načítání a validace meters.json
  import_legacy.py import staré jednoměřidlové SQLite DB
  db.py            SQLite schéma, zápis, dotazy, downsampling
  static/
    index.html     přehled měřidel + detail
    style.css      design tokeny, světlý a tmavý režim
    app.js         routing, přehled, canvasové grafy, přepínání motivu
    logo.png        logo v hlavičce
    fonts/         Inter a Manrope (SIL OFL)
meters.example.json
Dockerfile
docker-compose.yml
```

## Bezpečnostní poznámky

- Čtení (`/api/meters`, `/api/meters/{slug}/readings*`) je veřejné, protože ho
  používá dashboard a veřejný export. Zápis vyžaduje token daného měřidla.
- Komentáře jsou součástí veřejných dat; neukládejte do nich citlivé údaje.
- `meters.json` obsahuje tajné tokeny. Necommitujte ho a v produkci omezte
  přístup k volume. Aplikace ho při vytvoření nastaví na práva `600`.
- Tokeny zadané ve formuláři se ukládají do `localStorage` prohlížeče. Na
  sdíleném počítači je proto po použití smažte tlačítkem v formuláři.
- Tokeny se porovnávají v konstantním čase. Pro produkci použijte dlouhé náhodné
  tokeny a aplikaci nasaďte za HTTPS reverse proxy (Caddy, Nginx, Traefik).
- Aplikace nemá rate limiting; při veřejném vystavení zvažte limit na proxy.
- Kontejner běží jako neprivilegovaný uživatel.
