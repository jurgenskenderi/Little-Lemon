# Clocktails

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

`npm test` runs the server suite (111 tests). `npm run typecheck` covers both
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

## Getting your location right

A happy hour search lives or dies on a couple of hundred metres — the wrong side
of Queen Street is a different set of bars. Three things make the fix as good as
the device allows:

- **Highest accuracy, no cached fix.** The browser and the app both ask for GPS
  rather than accepting the cheap wifi/IP estimate, which on a laptop can land
  kilometres away. This was the single biggest cause of a wrong starting point.
- **It refines after the first fix.** The first reading is often the coarsest,
  so both clients keep watching for ~30 seconds and accept only *better*
  readings. Your position never drifts worse while you're looking at it.
- **You can override it.** The status line states the accuracy out loud
  ("accurate to 35 m"), and when it's poor it offers *set it on the map* —
  drop a pin where you actually are, and everything measures from there. In the
  app, long-press the map. The pin is remembered.

The map draws the accuracy radius as a blue circle when it's large enough to
matter, so you can see how much to trust it rather than guessing.

**When the browser refuses, the app says why.** There are four ways a fix fails
and they need four different responses, so the preview reports the real error
rather than quietly falling back to downtown. The one that catches people: an
embedded page whose frame lacks `allow="geolocation"` has the API disabled by
Permissions Policy — no prompt, instant denial, and nothing the page can do from
the inside. Opening the preview in its own tab fixes it, and the page now says
so instead of looking broken.

**And there is always a way through.** Pick your neighbourhood from the *I'm
near* list — the names are the basemap's own, so whatever you choose is drawn on
the map — or drop a pin. Neither needs the browser's permission, and both are
remembered.

## Map search

The map is the second way to browse, and it behaves the way people expect a map
to: drag to pan, pinch or scroll to zoom, tap a pin to select it. Venues render
as price pills rather than generic markers, so the offer is readable without
tapping. Pins are coloured by state — partner, on now, later.

Under the pins is a card strip synced to the map both ways: swiping the cards
flies the map to that venue, and tapping a pin scrolls its card into view.
Tapping the already-selected card opens the full detail sheet. Panning away
raises **Search this area**, which re-runs the search centred where you moved
to; the ◎ button returns to your own location.

Two details decide whether a map feels like a map:

**It has to draw streets.** No tile server is reachable from a sandboxed page,
so the preview build carries the geometry itself — the Toronto arterials by
class, the Lake Ontario shoreline, the Don and Humber, the larger parks, and
neighbourhood labels, all at real coordinates. Street names are drawn rotated
along their own line, and every label is claimed against the ones already
placed so names never stack. It is a generalised network, not a survey; zoom or
pan past central Toronto and the map says so rather than presenting bare land
as fact. The shipping app has no such limit — it uses Google and Apple's own
maps with the full road graph.

**It has to move under your finger.** `touch-action: none` has to sit on the
canvas element itself. The property is not inherited, so setting it on the
wrapper — which is what this build did at first — leaves the browser claiming
every touch for page scrolling, and the map simply does not pan on a phone.
Drag pans, pinch and wheel zoom, double-tap zooms in, arrow keys and `+`/`−`
do the same from the keyboard.

Below the arterials sits the downtown local grid — Portland, John, Duncan,
Simcoe, York, Victoria, Berkeley and the rest — generated between the arterials
they actually meet rather than drawn as straight lines, because the core grid is
tilted about twelve degrees off north and the tilt is not uniform. A local
street therefore meets King and Queen exactly where King and Queen are. Only
streets whose downtown position is unambiguous are listed; elsewhere the map
stays honestly sparse rather than guessing.

You are a blue dot with an accuracy halo, venues are teardrop pins carrying the
glyph for what's on offer, and dense strips like King West collapse into a
count until you zoom in.

iOS uses Apple Maps and needs no key. **Android needs a Google Maps API key**, or
the map renders blank — that is the usual cause of "the map is grey". Supply it
as an environment variable and `app.config.js` picks it up:

```bash
GOOGLE_MAPS_ANDROID_KEY=your-key npm run mobile
```

## Links out of a sandboxed page

**Call and Directions cannot navigate from the preview.** The artifact runs in
a sandboxed frame, and Chromium blocks both routes out of it:

```
Navigation to external protocol blocked by sandbox, because it doesn't contain
any of: 'allow-top-navigation-to-custom-protocols', … or 'allow-popups'
Blocked opening 'https://maps.google.com/…' because the request was made in a
sandboxed frame whose 'allow-popups' permission is not set
```

Both failures are silent — the anchor looks fine and does nothing, which is
exactly how a Call button ends up "not working". So the preview no longer
pretends: the number is always on screen as selectable text and as a `tel:`
link (which works the moment the page is in its own tab), the buttons detect
the refusal, and the fallback copies the number or address to the clipboard and
says what happened. In the app there is no sandbox — `Call` dials, but it now
checks `canOpenURL` first and says so on a device with no dialler instead of
failing silently.

## Pictures

The crawler pulls a photo for each deal from the venue's own page, preferring
their Open Graph image — the picture the venue chose to represent itself, already
sized for a card — and falling back to the largest editorial-looking image on the
page. Logos, icons, social buttons, tracking pixels, SVGs and anything declared
smaller than 200×150 are filtered out.

When there's no usable photo, the app draws the dish or drink instead, chosen
from what the deal actually says: "$1.75 oysters" gets oysters, not a generic
plate. Partner deals can carry their own `imageUrl` through the admin API, which
is where you'd put photography a restaurant gives you directly.

**Before production, cache these images rather than hotlinking.** The stored
value is a URL on the venue's host, so every app user currently costs that
restaurant bandwidth, and the image breaks the moment they reorganise their site.
Fetching once into your own bucket fixes both.

## Where the venues come from

Two independent sources fill the venues table. Both write the same shape, so
nothing downstream cares which one you used, and you can run both.

### Google Places

```bash
GOOGLE_MAPS_API_KEY=... npm run import:toronto              # all 15 strips
GOOGLE_MAPS_API_KEY=... npm run import:places -- --preset toronto-core
GOOGLE_MAPS_API_KEY=... npm run import:places -- --lat 43.6487 --lon -79.3980 --radius-km 1.5
```

Better coverage than OpenStreetMap, especially for chains, phone numbers and
places without their own website. It needs a Google Cloud project with **Places
API (New)** enabled, a billing account attached, and a key with no HTTP-referrer
restriction — referrer-restricted keys reject server-side calls, which is the
usual cause of a `403`. `--dry-run` reports what it found without writing, but
it still calls the API: discovery is the billed part.

Two things about this API are worth knowing before you budget for it.

**Nearby Search returns at most 20 places and has no page token.** A 1.2 km
circle over King West holds far more than 20 bars, so asking once gives you an
arbitrary 20 of them and no indication that anything is missing. The importer
ranks by distance, notices a response that came back full, and splits that
circle into quadrants until the results stop hitting the cap. That is why one
"area" can cost five or twenty-one requests rather than one.

**Google's terms cap how long you may keep the data.** A place ID may be stored
indefinitely; every other field — name, address, coordinates, rating — has to be
refreshed at least every 30 days. Every import stamps `place_refreshed_at`, a
re-run skips anything still inside the window and re-fetches anything outside
it, and the CLI tells you how many stored places have gone stale. Two further
constraints the code cannot enforce for you: Places content may not be shown on
a non-Google map, which matters because this app uses **Apple Maps on iOS**, and
wherever you do show it you must display the "Powered by Google" credit — the
`/api/places` response carries that string so the client renders it only when it
applies.

Once venues are in, one more command puts them in front of people:

```bash
npm run export:preview          # rewrite preview/index.html from the database
npm run export:preview -- --dry-run
```

The preview is a single self-contained file with its venue table inlined,
because a sandboxed page cannot call an API — which normally means it drifts
from reality the moment you import anything. This closes the loop: import,
crawl, export, and the page people open is showing the same data the app is.
Only the block between the `CLOCKTAILS:VENUES` markers is rewritten.

### OpenStreetMap

```bash
npm run scrape -- --preset toronto --dry-run   # discovery only, no crawl
```

Free, keyless, no terms to work around, and the data is ODbL — attribution
required, and a derived database inherits the licence. Coverage is thinner and
more uneven than Google's, and many venues carry no website tag at all. This is
the path `npm run scrape` uses by default.

## Before the deals exist

A freshly imported city is thousands of real bars and zero known happy hours,
and an app that only shows deals shows nothing at all in that state — which
reads as broken rather than as honest. So venues are first-class whether or not
we know a deal for them:

```
GET /api/places?lat=&lon=&radiusKm=&withoutDeals=true
```

On the map they are small hollow dots behind the deal pins; tapping one says
what we know and admits what we don't. The list view still shows only deals,
because a list of venues we know nothing about would bury the ones we do.

## The scraper

Once the venues are in, each one's website is crawled for deals.

```bash
npm run scrape:toronto                      # all 15 Toronto bar strips
npm run scrape -- --preset toronto-core     # downtown only, quicker first run
npm run scrape -- --preset ottawa           # or hamilton
npm run scrape -- --preset toronto --dry-run   # list venues, fetch nothing

# Or a single point
npm run scrape -- --lat 43.6487 --lon -79.3980 --radius-km 2
```

Presets are a set of tight circles over the neighbourhoods that actually have
bars, rather than one big circle over the city — a 10 km radius over Toronto
returns thousands of venues and most are irrelevant. The same presets drive the
Places import. Venues found in overlapping circles are deduplicated by their
source id, so the overlap costs requests but never duplicates a venue.

Every run starts with a connectivity preflight, because a crawl that fails from
no internet looks identical to one that fails because every venue site is down:
a pile of timeouts and an empty database. The check names the difference,
including the case where a proxy answers `403` on the host's behalf.

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
runs on the parser alone and skips what it can't read. Plenty of Toronto
restaurants put their happy hour in an image or a booking widget, so the key
meaningfully changes coverage.

Check it works before committing to a long crawl:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run verify:extractor
```

That runs the real extractor against a sample page written to defeat the
rule-based parser — prose schedule, implied end time, and a decoy line of
opening hours. It prints what it found in a couple of seconds.

**A re-crawl replaces a venue's scraped deals wholesale**, so a deal the venue
removed from its site disappears rather than lingering — but only if the crawl
actually reached the site, and never touching partner deals.

**Every scraped deal carries a confidence score.** Scraped hours go stale and
ambiguous copy gets guessed at, so the app labels anything uncertain
("Unconfirmed times — call ahead") instead of presenting it as fact.

## API

```
GET  /api/deals?lat=&lon=&radiusKm=&at=&windowMin=&category=&sort=&minConfidence=
GET  /api/places?lat=&lon=&radiusKm=&withoutDeals=   # venues, deal or not
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

`server/src/seed/venues.json` holds twenty-four venues at real Toronto,
Hamilton, and Ottawa coordinates with **invented names and invented deals**,
three flagged as partner deals so you can see the ranking and the map
clustering. They are fictional on purpose:
publishing made-up happy hour times attributed to real businesses would
misinform customers and misrepresent those businesses. Replace it with crawled
data and your own partner deals before launch.

## Known gaps

Worth knowing before this goes near real users:

- **The crawler has not been run against live sites from this repo yet.** It is
  covered end to end by a test that serves a fixture restaurant site over
  loopback — robots.txt, link following, extraction, storage — but the machine
  it was built on has outbound HTTPS blocked at the network policy, so every
  host including `example.com` returns 403 at the gateway. Interestingly
  `api.anthropic.com` *is* reachable there, so the model extractor could run —
  but with no venue pages to read, that changes nothing. Run
  `npm run scrape:toronto` from your own machine for real data; the preflight
  will confirm connectivity before it starts.
- **Timezones are per-crawl, not per-venue.** Overpass returns no timezone, so
  the CLI applies one `--tz` to everything it discovers. Correct for Ontario,
  which is Eastern throughout apart from a small north-western corner around
  Atikokan; a crawl beyond the province needs a real lookup.
- **No deduplication across sources.** Each source dedupes within itself, but a
  bar imported from Google and then discovered again in OpenStreetMap becomes
  two venues. Matching them needs name-and-distance fuzzy matching that isn't
  written yet.
- **The Places import has not been run against the real API from this repo.**
  It is covered end to end by tests against a local fixture — the 20-result cap
  and its quadrant split, the cache window, dedup, error handling — and the CLI
  was smoke-tested against that fixture through to `/api/places`. What has never
  happened is a call to Google with a real key, because there isn't one here.
- **Scraped hours go stale.** Nothing re-verifies a deal beyond the refetch
  interval, which is what the confidence labelling compensates for.
- **The crawler is polite, not invisible.** Sites can still block it. Check a
  site's terms before crawling it at volume.
