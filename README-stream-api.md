# YRcine Stream API

> **Self-contained on Vercel.** The app, the stream API *and* the relay
> (TMDB / catalog / proxy / ad-blocking embed / image) all live in this repo and
> run on one origin. No Cloudflare, no external backend.

Your own multi-provider backend — anime, movies, manhwa **and an ad-blocker** —
in one file. No npm packages, no build step, no rented API in the hot path.

## Files

| File | Where it runs |
| --- | --- |
| `stream-api-worker.js` | Cloudflare Worker (paste-and-deploy, self-contained) |
| `vercel-stream-api.js` | Vercel Edge Function — save as `api/stream/[...slug].js` |

Identical core; only the entry point differs.

## Providers

| Section | Provider | Backing | Returns |
| --- | --- | --- | --- |
| anime | `anikoto` | anikoto.net (Zoro-style) + megaCloud | ✅ HLS via own proxy |
| anime | `vidsrc` | vidsrc.to (by TMDB id) | ✅ HLS via own proxy |
| anime | `animesalt` | animesalt.cx scrape | embed servers |
| movie | `vidsrc-vidplay` | vidsrc.to → Vidplay | ✅ HLS |
| movie | `vidsrc-filemoon` | vidsrc.to → Filemoon | ✅ HLS |
| movie | TMDB | official API | metadata |
| manga | MangaDex | official API | pages |

### Provider changelog
- **`123anime` removed** — the source is dead. Replaced by **`anikoto`**.
- **`animesalt` fixed** — was pointed at the wrong domain (`animesalt.ac`); the
  live one is **`animesalt.cx`**, with corrected selectors and the base64
  multi-language server trick.

## Endpoints

### Anime
| Route | Notes |
| --- | --- |
| `GET /anime/search?query=naruto` | provider `anikoto` |
| `GET /anime/search?provider=animesalt&query=naruto` | provider `animesalt` |
| `GET /anime/episodes?id=<slug>` | anikoto episode list |
| `GET /anime/sources?id=<slug>&ep=1` | `{ type: "hls"\|"embed", url, server, subtitles }` |
| `GET /anime/play?id=<slug>&ep=1` | provider `anikoto` → m3u8 (502 + `embed` if HLS unavailable) |
| `GET /anime/play?tmdb=<id>&s=1&e=1` | provider `vidsrc` → m3u8 |
| `GET /anime/servers?url=<episode-page-url>` | provider `animesalt` → `[{ server, language, embed }]` |
| `GET /anime/proxy?url=<enc>&ref=<referer>` | HLS segment proxy |

### Movies / TV
| Route | Notes |
| --- | --- |
| `GET /movie/search?query=dune` | TMDB multi-search |
| `GET /movie/trending` | this week |
| `GET /movie/detail?id=<tmdb>&type=movie\|tv` | one title |
| `GET /movie/stream?id=<tmdb\|tt>&s=&e=` | `[{ name, url, proxied }]` |
| `GET /media/proxy?url=<enc>&ref=<referer>` | generic media proxy |

### Ad-blocker
| Route | Notes |
| --- | --- |
| `GET /embed?url=<enc>&ref=<referer>` | fetch a player and return it **sanitised** |

Strips ad scripts and ad iframes (~35 patterns), rewrites `target="_blank"` to
`_self`, injects a popup guard, adds a `<base>`. Because the API returns a
**fresh** response, the upstream's `X-Frame-Options` never reaches the browser —
players that refuse to be embedded become embeddable.

### Manga / manhwa
| Route | Notes |
| --- | --- |
| `GET /manga/search?query=solo leveling` | `[{ id, title, cover, status, year }]` |
| `GET /manga/chapters?id=<uuid>` | `[{ id, chapter, volume, title, pages, lang }]` |
| `GET /manga/pages?id=<uuid>&saver=1` | `{ base, hash, pages: [url, ...] }` |

### Diagnostics & unified search
| Route | Notes |
| --- | --- |
| `GET /api/health` | service + **per-provider reachability** (parallel probes), config check, route list |
| `GET /api/search?q=dune` | one query across **anime + movie + manga** at once → `{ query, counts, anime, movie, manga }` |

`/api/health` is the one to hit when something looks broken — it tells you which
provider is down and whether `TMDB_API_KEY` is set, instead of guessing.

### Meta
`GET /health` → sections, providers, features.

## Deploy — Vercel (recommended)

The repo is already wired for it: `vercel.json` serves the app from `www/` and
routes the stream paths to the Edge function at `api/stream/[...slug].js`.

1. **vercel.com → Add New → Project → Import** the `kalki-xy/yrcine-android` repo.
2. Framework preset: **Other**. Leave build/output as-is (`vercel.json` sets
   `outputDirectory: "www"`). If Vercel doesn't pick that up, set
   **Settings → Build & Development → Output Directory** to `www`.
3. **Settings → Environment Variables → add `TMDB_API_KEY`** (all environments).
4. **Deploy.**

After that, **every push to `main` redeploys automatically** — no workflow file,
no tokens to manage. The app calls the API on its own origin, so `streamApiBase`
stays `""`.

> Note: `api/stream/[...slug].js` runs on the **Edge runtime** (declared in the
> file), so it streams and proxies without Node cold starts.

## Deploy — Cloudflare Worker
1. Workers & Pages → Create → Worker → Deploy.
2. Edit code → paste `stream-api-worker.js` → Deploy.
3. Settings → Variables → `TMDB_API_KEY` (optional `ANIKOTO_BASE`, `ANIMESALT_BASE`).
4. Check `/health`.

## Deploy — Vercel
1. Save `vercel-stream-api.js` as `api/stream/[...slug].js`.
2. Add env `TMDB_API_KEY`.
3. Deploy. Check `/api/stream/health`.

## Wire it into YRcine
Nothing to set. The same Worker serves the app and the API, so the app calls the
API on **its own origin** by default (`streamApiBase: ""`). Only set it if the API
lives on a different host:
```js
streamApiBase: "https://<your-api-host>",   // no trailing slash
```

## How the pieces work
- **anikoto**: `/filter?keyword=` → `/watch/{slug}` → `/ajax/server/list` →
  `/ajax/server` → embed → **megaCloud**. megaCloud returns AES-128-CBC
  encrypted sources; the API decrypts them **locally with WebCrypto** (keys
  fetched live from `MegacloudKeys`, with a built-in fallback). No node crypto,
  no external decrypt service — so it runs on Workers and Edge.
  If HLS can't be resolved it returns the embed, which you play through `/embed`.
- **vidsrc**: base64+RC4 source URL, then Vidplay (futoken → mediainfo) and
  Filemoon (JS-packer unpack).
- **animesalt**: plain scrape; `?data=` iframes carry base64 multi-language
  server lists.
- **Manga**: MangaDex official API.

## Swapping a dead provider
Providers are small, self-contained functions. To replace one, edit only its
block (`ANIME PROVIDER A/B/C` are clearly marked) and the provider name in the
`/anime/search` route and `/health`. The rest of the API is unaffected.

## Verification
**48 automated checks pass** on the Cloudflare build (and the Vercel port for the
provider suite). Coverage: anikoto search / episode parse / server list / the full
megaCloud chain including a **real AES-128-CBC decrypt round-trip**; animesalt
search, server resolution and base64 multi-language decode; the full vidsrc chain
(RC4 round-trip, Vidplay futoken→mediainfo, Filemoon packer unpack); the
ad-blocker (ad script stripped, legit kept, ad iframe stripped, legit kept,
`target=_blank` neutralised, `<base>` + popup guard, no `X-Frame-Options`); manga
search/chapters/pages/data-saver; TMDB shaping.

Everything is tested against **mocked upstreams**, not the live services — this
sandbox has no egress to them.

## Caveats — read these
- **Provider sites die and change.** `123anime` was dead and `animesalt` had
  moved domains. Sources rot; expect to swap one occasionally. The code is
  organised so that's a small, contained edit.
- **megaCloud keys rotate** — fetched live, with a fallback.
- **animesalt is embed-only** — play it through `/embed`.
- **Sites needing TLS-fingerprint impersonation are out of scope** (Workers/Edge
  can't do it without a native TLS module).
- **Cloudflare IPs are sometimes blocked** by stream hosts.
- **This scrapes third-party sites.** Whether you may host or redistribute what
  it returns is your call and your responsibility. Not legal advice.
