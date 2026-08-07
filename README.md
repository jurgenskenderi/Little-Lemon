# Little Lemon

Find happy hour deals near you, filtered by how far you'll walk and when you
actually want to go out. Launching in **Ontario, Canada** — distances in
kilometres, venue times in `America/Toronto`.

One React Native codebase runs on iPhone and Android. On launch it asks for your
location, then shows the deals actually running at the time you pick — as a
ranked list or on a map you can search by panning.

```
mobile/     Expo + React Native app (iOS and Android)
server/     Fastify API, SQLite storage, scraper, and the partner console
```

## Try it now

**[Open the preview →](https://claude.ai/code/artifact/4176a1f5-96b5-4fc1-9772-b91cb2499cc1)**

A working web build you can open on your phone in Toronto. It uses your real
location, has the list and map views, the distance slider, and the time filters.
It runs on **sample data with invented venue names** and needs no server. It is
a preview of the product, not the shippable app — see *Getting a real app* below.

## Quick start

```bash
npm install
npm run seed        # sample Ontario dataset
npm run dev         # API on http://localhost:8787
npm run mobile      # Expo dev server; scan the QR code with Expo Go
```

The app finds the API automatically: it reuses the host Expo is already serving
the bundle from, so a phone on the same Wi-Fi works without editing an IP.
Override with `EXPO_PUBLIC_API_URL` if your setup differs.

`npm test` runs the server suite (78 tests). `npm run typecheck` covers both
workspaces.

## Partner deals

Deals you negotiate directly with a restaurant are entered by hand, and they are
treated differently from anything scraped:

- they carry a **PARTNER** badge in the app,
- they **rank above** scraped results, ahead of even closer venues,
- a later crawl of that venue's site **will not overwrite them**, and
- they are stored at full confidence, so they never show a "call ahead" warning.

Set `ADMIN_TOKEN` in `server/.env`, then open **`http://localhost:8787/admin`**.
Add the venue once (name, coordinates, phone), then add deals against it: pick
the days, type the hours as 24-hour `HH:MM`, save. An end earlier than the start
means it runs past midnight — `22:00` to `02:00` is handled correctly.

The same thing over the API:

```bash
curl -X POST localhost:8787/api/admin/venues \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"The Ossington Room","lat":43.6472,"lon":-79.4203}'

curl -X POST localhost:8787/api/admin/deals \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"venueId":"ven_the-ossington-room-toronto","title":"Happy Hour",
       "priceText":"$4 pints","days":[5,6],"start":"22:00","end":"02:00"}'
```

The whole admin surface returns 404 when `ADMIN_TOKEN` is unset, so a
misconfigured deploy exposes nothing rather than exposing everything.

## How the search works

Two things have to be right for this app to be useful: *is it near me* and *is
it on when I want it*. Both are more subtle than they look.

**Distance.** Deals are filtered by a lat/lon bounding box in SQL, then by exact
haversine distance in JS. The box alone over-selects at the corners — a square
is about 27% larger than the circle inside it — so the second pass is what
enforces the radius you picked.

**Time.** A window is stored as `(dayOfWeek, startMin, endMin)` in the venue's
*local* wall-clock time, because that is how bars publish them. `endMin` may
exceed 1440 so a window running past midnight stays one row: Friday 10pm–2am is
`(5, 1320, 1560)`, not a Friday row plus a Saturday row. That matters at 12:30am
on a Saturday, when the deal someone wants is filed under Friday — the search
projects windows onto a shared axis so the day before and after are both
considered. Times are compared in each venue's own timezone, so results hold
across daylight saving.

## Map search

The map shows every result as a pin, coloured by state (partner / on now /
later), inside a ring showing your chosen radius. Pan it and a **Search this
area** button appears, which re-runs the search centred on where you moved to —
useful for checking a neighbourhood before you head over. "Back to my location"
returns to your device fix.

iOS uses Apple Maps and needs no key. **Android needs a Google Maps API key**, or
the map renders blank — that is the usual cause of "the map is grey". Supply it
as an environment variable and `app.config.js` picks it up:

```bash
GOOGLE_MAPS_ANDROID_KEY=your-key npm run mobile
```

## The scraper

Venues come from OpenStreetMap's Overpass API (free, no key). Each venue's
website is then crawled for deals.

```bash
# Discover and crawl restaurants near Queen & Spadina, Toronto
npm run scrape -- --lat 43.6487 --lon -79.3980 --radius-km 3 --limit 25

# See what would be crawled without fetching anything
npm run scrape -- --lat 43.6487 --lon -79.3980 --dry-run
```

**It's built to be a good citizen**, because it's hitting sites we don't own:
robots.txt is fetched and honoured per host (including `Allow` exceptions,
wildcards, and `Crawl-delay`, and a 5xx is treated as "stay out"); requests to
one host are serialised with a delay; bodies are size-capped; recently-fetched
pages are skipped; and only same-origin links that look like deal pages are
followed, only from the entry page.

**Extraction is two-stage.** A rule-based parser handles the shapes bars
actually publish ("Mon–Fri 4-6pm", "Daily 3–6", "Fri & Sat 10pm–close"),
resolving am/pm the way a person would: `4-6pm` is the afternoon, `11-2pm` is
late morning to early afternoon, `10pm-2am` runs past midnight. Only pages that
mention deals but defeat the parser go to Claude, which keeps a metro-wide crawl
cheap. That call uses structured outputs, so the response is schema-checked by
the API rather than parsed out of prose, and every window is re-validated
locally afterwards.

Set `ANTHROPIC_API_KEY` to enable the model fallback; without it the crawler
runs on the parser alone and skips what it can't read.

**A re-crawl replaces a venue's scraped deals wholesale**, so a deal the venue
removed from its site disappears rather than lingering — but only if the crawl
actually reached the site, and never touching partner deals.

**Every scraped deal carries a confidence score.** Scraped hours go stale and
ambiguous copy gets guessed at, so the app labels anything uncertain
("Unconfirmed times — call ahead") instead of presenting it as fact.

## API

```
GET  /api/deals?lat=&lon=&radiusKm=&at=&windowMin=&category=&sort=&minConfidence=
GET  /api/venues/:id
GET  /api/health
GET  /admin                    # partner console (HTML)
POST /api/admin/venues         # requires ADMIN_TOKEN
POST /api/admin/deals
DELETE /api/admin/deals/:id
POST /api/admin/scrape         # kicks off a crawl
```

`at` is an ISO instant and `windowMin` is how far past it to look —
`windowMin=0` means "open at exactly this moment", `windowMin=120` means "open
at some point in the next two hours". That pair backs every option in the app's
time picker. `radiusM` and `radiusMi` are accepted too.

```bash
curl "localhost:8787/api/deals?lat=43.6479&lon=-79.3968&radiusKm=2&windowMin=120"
```

## Getting a real app

The preview link above runs in a browser. For something installable, Expo builds
both platforms from this same codebase — but the store steps need accounts only
you can create:

```bash
npm install -g eas-cli
eas login
eas build:configure

eas build --platform ios       # needs an Apple Developer account ($99/yr)
eas build --platform android   # needs a Google Play account ($25 one-off)

eas submit --platform ios      # → TestFlight, for testers
eas submit --platform android  # → Play internal testing
```

For testing without the stores, `eas build --profile preview --platform android`
produces an APK you can install directly or send to someone.

Before submitting you will also need an app icon and splash image (referenced in
`app.config.js`), a privacy policy URL covering location use, and a production
host for the API — the app currently points at a dev machine on your LAN.

## Sample data

`server/src/seed/venues.json` holds twelve venues at real Toronto, Hamilton, and
Ottawa coordinates with **invented names and invented deals**, one flagged as a
partner deal so you can see the ranking. They are fictional on purpose:
publishing made-up happy hour times attributed to real businesses would
misinform customers and misrepresent those businesses. Replace it with crawled
data and your own partner deals before launch.

## Known gaps

Worth knowing before this goes near real users:

- **The crawler has not been run against live sites from this repo yet.** It is
  covered end to end by a test that serves a fixture restaurant site over
  loopback — robots.txt, link following, extraction, storage — but the machine
  it was built on has no outbound internet access. Run the `npm run scrape`
  command above locally to point it at real Toronto sites.
- **Timezones are per-crawl, not per-venue.** Overpass returns no timezone, so
  the CLI applies one `--tz` to everything it discovers. Correct for Ontario,
  which is Eastern throughout apart from a small north-western corner around
  Atikokan; a crawl beyond the province needs a real lookup.
- **No deduplication across sources.** The same bar discovered twice under
  different OSM ids becomes two venues.
- **Scraped hours go stale.** Nothing re-verifies a deal beyond the refetch
  interval, which is what the confidence labelling compensates for.
- **The crawler is polite, not invisible.** Sites can still block it. Check a
  site's terms before crawling it at volume.
