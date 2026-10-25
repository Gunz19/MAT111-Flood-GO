# ไปได้ไหม – Flood Go

A Thai-language web page that helps people, especially older users, decide whether to travel when it rains.
It shows rain forecast near you and along a driving route, an estimated green / yellow / red travel-risk level,
a preparation checklist, emergency numbers, and a simple Q&A (preset answers, plus optional AI).

> **The risk level is an estimate from rain forecasts, not a measurement of floodwater.**
> Green does not mean a road is safe. Always follow official warnings, road closures and local conditions.

## Files

| Path | What it is |
|---|---|
| `index.html` | The whole website (HTML, CSS and JavaScript in one file). |
| `config.js` | Public settings: AI endpoint URL, refresh interval, map tile provider. **No secrets.** |
| `worker/` | Optional AI backend (Cloudflare Worker) that keeps the Gemini API key on the server. |
| `worker/test/` | Unit tests for the AI backend (mocked Gemini, no key needed). |

The website is static, so it can be hosted on GitHub Pages. The AI backend cannot run on GitHub Pages (see below).

## Run locally

The page must be opened over `http://` or `https://`. Opening `index.html` directly from disk (`file://`)
makes the map tiles fail (see "Map fix").

```bash
python -m http.server 8080
```

Then open <http://localhost:8080/>. Geolocation and the microphone also need `https://` or `localhost`.

## Map fix (the "403 Access blocked" tiles)

**Cause.** The map used OpenStreetMap's standard tile server, `tile.openstreetmap.org`. Its
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/) requires browsers to send a valid
`Referer` header. When the HTML file is opened directly from disk, the browser sends no `Referer`, and the
server answers every tile with an "Access blocked" image (header `x-blocked: No referer sent`). That image comes
back with HTTP 200, so Leaflet did not treat it as an error. The same tile requested with a `Referer` returns the
real map.

**Fix.**
- Serve the site over HTTPS (GitHub Pages) so the browser sends a `Referer`. The tile layer also sets
  `referrerPolicy: strict-origin-when-cross-origin` and the page sets the same policy, so the Referer is never stripped.
- When the page is opened as `file://`, the app does not request OSM tiles at all and shows a clear message instead.
- If tiles fail to load (offline, provider down), a message appears over the map. Route, markers and rain data still work.
- Attribution "© OpenStreetMap contributors" links to the copyright page, plus a "report a map issue" link.
- The tile URL is configurable in `config.js`, as the policy recommends.
- Maps in hidden sections now resize correctly (a `ResizeObserver` calls `invalidateSize()` and applies pending `fitBounds`).

**Is the OSM tile server suitable?** For a class project with modest traffic, yes, if the rules above are followed.
OSM's servers are volunteer-run, best-effort, with no SLA, and heavy use can be blocked without notice. For large
public traffic, switch to a commercial provider (for example MapTiler, Stadia Maps or Thunderforest, each needs an
account and a domain-restricted key) by changing `tileUrl`, `tileAttribution` and `tileMaxZoom` in `config.js`.

**Second map bug found.** RainViewer radar tiles exist only up to zoom 7; above that the server returns a
"Zoom Level Not Supported" image, which the old home map (zoom 10) drew over the map. The radar layer now uses
`maxNativeZoom: 7`, so Leaflet scales up zoom-7 tiles instead.

## External services and their limits

All of these are called directly from the visitor's browser. Each call checks the HTTP status, validates the
response, has a timeout, and shows a Thai error message if it fails. No live data is ever made up.

| Service | Used for | Limits / terms | What the app does |
|---|---|---|---|
| [Open-Meteo](https://open-meteo.com/en/terms) | Rain forecast | Free for non-commercial use, < 10,000 calls/day; CC BY 4.0 attribution | Multi-location requests (documented format), `timeformat=unixtime`, 15-minute cache, no overlapping refreshes, refresh only while the tab is visible, last-update time and stale warning |
| [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | Place search | **Max 1 request/second for the whole site, no autocomplete, cache results, attribution required.** Acceptable for user-triggered searches with a moderate number of users | Searches only when "ตรวจสอบเลย" is pressed, queued at ≥ 1.1 s apart, results cached 30 days (misses 1 hour) |
| [OSRM demo server](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server) | Driving route | Max 1 request/second, non-commercial, no availability guarantee | Queued ≥ 1.1 s apart, identical routes cached 1 hour, checks `code`, geometry and snap distance (> 2 km rejected), timeout 20 s |
| [RainViewer](https://www.rainviewer.com/api/weather-maps-api.html) | Radar overlay on home map | Past 2 hours, max zoom 7 | Validates metadata, drops frames older than 1 hour, optional layer that never breaks the base map |
| [OpenStreetMap tiles](https://operations.osmfoundation.org/policies/tiles/) | Base map | Referer required, attribution, no bulk download | See "Map fix" |

**Nominatim policy, plainly:** the public server is for light, user-triggered use. Its limits apply to the
whole website, not per visitor, so many simultaneous users can exceed them, and per-browser throttling cannot
stop that. If the site gets real traffic, move geocoding to a server-side proxy with a shared cache, run your own
Nominatim, or use a commercial geocoder. The same applies to the OSRM demo server.

Driving time comes from OSRM's road model and **does not include live traffic or road closures**.

## Risk logic

1. The route is sampled at 6 evenly spaced points (start, end and 4 in between).
2. Open-Meteo hourly `precipitation` at time T is the rain total for the hour **ending** at T. The app takes the
   first 4 timestamps after "now", so the bars cover this hour and the next 3. (The old version included the
   past hour as "now".)
3. For each hour, the app uses the wettest of the 6 points (a conservative choice).
4. `levelFrom(maxHour, total4)`:
   - red if any hour ≥ 7.6 mm or the 4-hour total ≥ 25 mm
   - yellow if any hour ≥ 2.5 mm or the 4-hour total ≥ 8 mm
   - otherwise green
5. Missing values are never counted as 0 mm. If data is incomplete, the result cannot be green and shows
   "ไม่ทราบ" (unknown) instead; yellow and red still show, with a note about missing data.

**Limitations of the thresholds.** 2.5 and 7.6 mm/h are the common light / moderate / heavy rain-rate bands.
8 mm and 25 mm over 4 hours are this app's own choices. **None of these are official Thai government flood
criteria.** Rain alone does not predict flooding: drainage, tides, river levels, upstream rain and local terrain
matter, and the app knows none of them. The app does **not** connect to the Thai Meteorological Department (TMD)
or ThaiWater APIs; it only links to their websites. Connecting them would need registration, API credentials and
a server, and has not been done.

## AI backend

**Why a backend.** The old page asked visitors for a Gemini API key and stored it in `localStorage`, then called
Gemini from the browser. On a public site anything in the page or browser can be read and abused. GitHub Pages
only serves static files, so it cannot hide a key. The key must live on a server.

**What changed.**
- The website no longer has any API key field. It also deletes the old `floodgo_key` value from `localStorage`.
- If `aiEndpoint` in `config.js` is empty, the chat uses the preset answers (works with no setup).
- If it is set, questions go to the Worker in `worker/`, which adds the key server-side and calls Gemini.
- If the AI fails for any reason, the chat falls back to the preset answers and says why.

**The Worker** (`worker/src/index.js`):
- Allows only origins in `ALLOWED_ORIGINS` (CORS), only `POST /api/ask` with JSON.
- Validates input: question 1–500 characters, context ≤ 800, body ≤ 4 KB.
- Rate limit: 10 questions/minute per visitor IP using Cloudflare's rate-limiting binding (approximate, per location).
- Sends the key in the `x-goog-api-key` header, never in the URL. 20 s timeout.
- Maps Gemini failures to clear codes: quota (`ai_quota`), bad key (`ai_auth`), model gone (`ai_model_unavailable`),
  timeout, malformed or blocked responses.
- Logs only event names and status codes, never the key or the question.
- System prompt: simple Thai, no made-up water levels or closures, never call a road safe from forecast alone,
  point to 1784 / 1669 and official sources.

**Model.** The old code used `gemini-2.0-flash`, which Google shut down on 2026-06-01, so it no longer works even
with a key. The Worker defaults to `gemini-3.5-flash-lite` (listed as stable, has a free tier), configurable with
`GEMINI_MODEL`. This model choice has **not** been tested against the live API, because no key was available.

### Environment variables

| Name | Where | Example |
|---|---|---|
| `GEMINI_API_KEY` | Worker secret (`wrangler secret put`) | from Google AI Studio |
| `ALLOWED_ORIGINS` | `worker/wrangler.toml` `[vars]` | `https://gunz19.github.io` |
| `GEMINI_MODEL` | `worker/wrangler.toml` `[vars]` | `gemini-3.5-flash-lite` |
| `RATE_LIMIT_PER_MINUTE` | optional, only used without the rate-limit binding | `10` |

For local Worker testing, put `GEMINI_API_KEY=...` and `ALLOWED_ORIGINS=http://localhost:8080` in
`worker/.dev.vars` (ignored by git).

### Deploy the Worker (Cloudflare, free plan)

1. Create a Cloudflare account and a Gemini API key in Google AI Studio.
2. In `worker/`: `npx wrangler@4 login`
3. `npx wrangler@4 secret put GEMINI_API_KEY` and paste the key when asked.
4. `npx wrangler@4 deploy`. Note the URL, e.g. `https://floodgo-ai.<account>.workers.dev`.
5. Put `https://floodgo-ai.<account>.workers.dev/api/ask` in `config.js` as `aiEndpoint`, commit and push.
6. Test one question on the live site, then check the Worker logs in the Cloudflare dashboard.

Run the Worker tests (no key needed): `cd worker && npm test`.

## Deploy the website (GitHub Pages)

The repository owner (only an admin can change Pages settings) does this once:

1. Push the files to `main`.
2. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site appears at `https://gunz19.github.io/MAT111-Flood-GO/` after a minute or two.

All asset paths are relative, so the `/MAT111-Flood-GO/` subpath works. Pages serves HTTPS, which the map,
geolocation and microphone need.

## Emergency numbers in the app

- **1784** – สายด่วนนิรภัย กรมป้องกันและบรรเทาสาธารณภัย (ปภ.)
- **1669** – สายด่วนการแพทย์ฉุกเฉิน สถาบันการแพทย์ฉุกเฉินแห่งชาติ (สพฉ.)
