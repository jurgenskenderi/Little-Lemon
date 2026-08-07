# Little Lemon

Find happy hour deals near you, filtered by how far you'll walk and when you
actually want to go out.

One React Native codebase runs on iPhone and Android. It asks for your location,
lets you pick a distance and a time, and shows the deals that are actually
running then — including the ones that start later tonight, so you can plan
rather than only see what's open this second.

```
mobile/     Expo + React Native app (iOS and Android)
server/     Fastify API, SQLite storage, and the scraper
```

## Quick start

```bash
npm install
npm run seed        # loads the sample dataset so there's something to look at
npm run dev         # API on http://localhost:8787
npm run mobile      # Expo dev server; scan the QR code with Expo Go
```

The app finds the API automatically: it reuses the host Expo is already serving
the bundle from, so a phone on the same Wi-Fi works without editing an IP.
Override with `EXPO_PUBLIC_API_URL` if your setup differs.

`npm test` runs the server suite. `npm run typecheck` covers both workspaces.

## How the search works

Two things have to be right for this app to be useful: *is it near me* and *is
it on when I want it*. Both are more subtle than they look.

**Distance.** Deals are filtered by a lat/lon bounding box in SQL, then by exact
haversine distance in JS. The box alone would over-select at the corners — a
square is about 27% larger than the circle inside it — so the second pass is
what actually enforces the radius you picked. Longitude degrees narrow toward
the poles, so the box widens with latitude to compensate.

**Time.** A window is stored as `(dayOfWeek, startMin, endMin)` in the venue's
*local* wall-clock time, because that's how bars publish them. `endMin` is
allowed to exceed 1440 so a window running past midnight stays one row: Friday
10pm–2am is `(5, 1320, 1560)`, not a Friday row plus a Saturday row. That
matters at 12:30am on a Saturday, when the deal someone wants is filed under
Friday — the search projects windows onto a shared axis so the day before and
after are both considered.

Times are compared in each venue's own timezone, so the results are correct
across a DST boundary and would stay correct for a search spanning two zones.

## The scraper

Venues come from OpenStreetMap's Overpass API (free, no key). Each venue's
website is then crawled for deals.

**It's built to be a good citizen**, because it's hitting sites we don't own:

- robots.txt is fetched and honoured per host, including `Allow` exceptions,
  wildcards, and `Crawl-delay`. A 5xx on robots.txt is treated as "stay out",
  not as permission.
- Requests to one host are serialised with a delay between them; different
  hosts still run concurrently.
- Response bodies are size-capped, requests time out, and pages fetched
  recently are skipped rather than refetched.
- Only same-origin links that look like deal pages are followed, and only from
  the entry page — the crawl doesn't wander.

**Extraction is two-stage.** A rule-based parser handles the shapes bars
actually publish ("Mon–Fri 4-6pm", "Daily 3–6", "Fri & Sat 10pm–close"),
resolving am/pm the way a person would: `4-6pm` is the afternoon, `11-2pm` is
late morning to early afternoon, `10pm-2am` runs past midnight. Only pages that
mention deals but defeat the parser go to Claude, which keeps a metro-wide crawl
cheap. The model call uses structured outputs, so the response is schema-checked
by the API rather than parsed out of prose, and every window is re-validated
locally afterwards — a schema-valid answer can still be a wrong one.

```bash
# Discover and crawl venues near a point
npm run scrape -- --lat 47.6205 --lon -122.3493 --radius-mi 2 \
  --tz America/Los_Angeles --limit 25

# See what would be crawled without fetching anything
npm run scrape -- --lat 47.6205 --lon -122.3493 --dry-run
```

Set `ANTHROPIC_API_KEY` to enable the model fallback; without it the crawler
runs on the parser alone and skips what it can't read.

**Every deal carries a confidence score.** Scraped hours go stale and ambiguous
copy gets guessed at, so the app labels anything uncertain ("Unconfirmed times —
call ahead") instead of presenting it as fact. `minConfidence` on the API hides
weak extractions entirely.

## API

```
GET  /api/deals?lat=&lon=&radiusMi=&at=&windowMin=&category=&sort=&minConfidence=
GET  /api/venues/:id
GET  /api/health
POST /api/admin/scrape        # requires ADMIN_TOKEN; disabled when unset
```

`at` is an ISO instant and `windowMin` is how far past it to look — `windowMin=0`
means "open at exactly this moment", `windowMin=120` means "open at some point
in the next two hours". That single pair is what backs every option in the app's
time picker.

```bash
curl "localhost:8787/api/deals?lat=47.6142&lon=-122.3283&radiusMi=1&windowMin=120"
```

## Sample data

`server/src/seed/venues.json` holds ten venues at real Seattle coordinates with
**invented names and invented deals**. They're fictional on purpose: publishing
made-up happy hour times attributed to real businesses would misinform anyone
who saw them. Replace it with crawled data before this is useful to real users.

## Configuration

See `server/.env.example`. Everything has a working default except
`ANTHROPIC_API_KEY` (enables model extraction) and `ADMIN_TOKEN` (enables the
scrape endpoint).

## Known gaps

Worth knowing before this goes anywhere near real users:

- **Timezones are per-crawl, not per-venue.** Overpass doesn't return one, so
  the CLI applies a single `--tz` to everything it discovers. Fine for one
  metro; a crawl spanning a timezone boundary needs a real lookup.
- **No deduplication across sources.** The same bar discovered twice under
  different OSM ids becomes two venues.
- **No map view.** Results are a ranked list; venue coordinates are returned by
  the API, so a map is additive rather than a rework.
- **Scraped hours go stale.** Nothing re-verifies a deal after it's stored
  beyond the refetch interval, which is what the confidence labelling is
  compensating for.
- **The crawler is polite, not invisible.** Sites can still block it. Check a
  site's terms before crawling it at volume.
