/**
 * YRcine Edge Worker  —  one Cloudflare Worker that does EVERYTHING the app needs,
 * at the edge: fast loading, network-block bypass, and ad-stripping.
 *
 * Routes (all CORS-enabled):
 *   GET  /api/tmdb/<path>?<qs>      → TMDB proxy (key stays server-side)
 *   GET  /api/catalog?source=tmdb&path=<p>   → TMDB proxy (same)
 *   GET  /api/catalog?source=anilist         → AniList trending (default query)
 *   ANY  /api/proxy?url=<url>       → generic CORS/unblock proxy (forwards POST bodies)
 *   GET  /api/embed?url=<url>       → fetch a player page and STRIP ADS
 *   GET  /api/image?url=<url>       → image proxy (streams, long cache)
 *   GET  /health                    → status
 *
 * Deploy: Workers & Pages → Create → Worker → paste this → Deploy.
 * Then set the Worker secret TMDB_API_KEY (Settings → Variables → Encrypt) to your
 * TMDB API key, and copy the worker URL into the app's `edgeBase` config field.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "*",
  "x-yrcine-edge": "1"
};
function hdrs(extra) {
  const h = new Headers(extra || {});
  for (const k in CORS) h.set(k, CORS[k]);
  return h;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: hdrs({ "content-type": "application/json; charset=utf-8" }) });
}
function ok(url) { return /^https?:\/\//i.test(String(url || "")); }

/* ---------- ad stripping ---------- */
const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
  "adsbygoogle", "googletagmanager.com", "googletagservices.com",
  "popads.net", "popcash.net", "propellerads.com", "onclickads.net", "onclckds.com",
  "exoclick.com", "exosrv.com", "juicyads.com", "trafficjunky.net", "trafficjunky.com",
  "adsterra.com", "hilltopads.net", "clickadu.com", "mgid.com", "adnium.com",
  "taboola.com", "outbrain.com", "revcontent.com", "pubmatic.com", "rubiconproject.com",
  "criteo.com", "criteo.net", "adnxs.com", "33across.com", "sharethrough.com",
  "adform.net", "smartadserver.com", "teads.tv", "zedo.com", "adcash.com",
  "bidvertiser.com", "infolinks.com", "realsrv.com", "tsyndicate.com", "adspyglass.com",
  "histats.com", "adskeeper.com", "ad-delivery.net", "profitableratecpm.com"
];
const AD_PATTERN = "advert|\\bads?\\b|adsbygoogle|popunder|popup|sponsor|banner|interstitial|preroll|google_ads|ad-slot|adslot";
const AD_ALT = AD_HOSTS.map(h => h.replace(/\./g, "\\.")).join("|");
const RE_AD_SCRIPT = new RegExp("<script\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>\\s*<\\/script>", "gi");
const RE_AD_IFRAME = new RegExp("<iframe\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>\\s*<\\/iframe>", "gi");
const RE_AD_LINK   = new RegExp("<link\\b[^>]*\\bhref=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>", "gi");
const RE_AD_IMG    = new RegExp("<img\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>", "gi");
const RE_AD_DIV    = new RegExp("<(div|ins|section|aside|span)\\b[^>]*\\b(?:class|id)=[\"'][^\"']*(?:" + AD_PATTERN + ")[^\"']*[\"'][^>]*>\\s*<\\/\\1>", "gi");

function stripAds(html, origin) {
  html = html.replace(RE_AD_SCRIPT, "").replace(RE_AD_IFRAME, "").replace(RE_AD_LINK, "").replace(RE_AD_IMG, "").replace(RE_AD_DIV, "");
  const inject =
    '<base href="' + origin + '/">' +
    '<style id="yr-adb">ins.adsbygoogle,iframe[src*="ads"],iframe[id*="ad"],[id^="ad-"],[id*="google_ads"],' +
    '[class*="advert"],[class*="popunder"],[class*="sponsor"],[class*="interstitial"],[id*="popunder"],' +
    '[class*="banner-ad"],[data-ad]{display:none!important;visibility:hidden!important;height:0!important}</style>';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, m => m + inject);
  return inject + html;
}

/* ---------- cache helper (fast loading) ---------- */
async function cachedGet(ctx, target, ttl, accept) {
  const cache = caches.default;
  const key = new Request("https://yrcine.cache/" + encodeURIComponent(target), { method: "GET" });
  let hit = await cache.match(key);
  if (hit) return hit;
  const up = await fetch(target, { headers: { "User-Agent": UA, "Accept": accept || "*/*" } });
  const ct = up.headers.get("content-type") || "application/octet-stream";
  const out = new Response(up.body, { status: up.status, headers: hdrs({ "content-type": ct }) });
  if (up.ok && ttl) {
    out.headers.set("cache-control", "public, max-age=" + ttl);
    ctx.waitUntil(cache.put(key, out.clone()));
  }
  return out;
}

/* ---------- handlers ---------- */
async function tmdb(env, ctx, sub, qs) {
  const key = env.TMDB_API_KEY || "";
  if (!key) return json({ error: "TMDB_API_KEY is not set on this Worker. Add it under Settings → Variables." }, 500);
  const sep = qs ? "&" : "?";
  const target = "https://api.themoviedb.org/3" + (sub || "") + (qs || "") + sep + "api_key=" + key;
  return cachedGet(ctx, target, 900, "application/json");
}
async function anilist(ctx) {
  const q = { query: "query{Page(page:1,perPage:30){media(type:ANIME,sort:TRENDING_DESC){id title{romaji english} coverImage{large} format episodes averageScore}}}" };
  const up = await fetch("https://graphql.anilist.co", {
    method: "POST", headers: { "content-type": "application/json", "Accept": "application/json" }, body: JSON.stringify(q)
  });
  const body = await up.text();
  return new Response(body, { status: up.status, headers: hdrs({ "content-type": "application/json; charset=utf-8" }) });
}
async function proxy(request, u) {
  const target = u.searchParams.get("url");
  if (!ok(target)) return json({ error: "missing or bad url" }, 400);
  const init = { method: request.method, headers: { "User-Agent": UA, "Accept": "*/*" }, redirect: "follow" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
    const ct = request.headers.get("content-type");
    if (ct) init.headers["content-type"] = ct;
  }
  const r = await fetch(target, init);
  const ct = r.headers.get("content-type") || "application/octet-stream";
  return new Response(r.body, { status: r.status, headers: hdrs({ "content-type": ct }) });
}
async function embed(request, u) {
  const target = u.searchParams.get("url");
  if (!ok(target)) return json({ error: "missing or bad url" }, 400);
  let t; try { t = new URL(target); } catch (e) { return json({ error: "bad url" }, 400); }
  let up;
  try {
    up = await fetch(target, { headers: { "User-Agent": UA, "Referer": t.origin + "/", "Accept": "text/html,application/xhtml+xml,*/*" }, redirect: "follow" });
  } catch (e) { return new Response("upstream fetch failed", { status: 502, headers: hdrs({ "content-type": "text/plain" }) }); }
  const ct = up.headers.get("content-type") || "";
  if (!/text\/html/i.test(ct)) return new Response(up.body, { status: up.status, headers: hdrs({ "content-type": ct || "application/octet-stream" }) });
  const clean = stripAds(await up.text(), t.origin);
  return new Response(clean, { status: 200, headers: hdrs({ "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" }) });
}
async function image(env, ctx, u) {
  const target = u.searchParams.get("url");
  if (!ok(target)) return json({ error: "missing or bad url" }, 400);
  return cachedGet(ctx, target, 86400, "image/*");
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const p = u.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: hdrs() });
    try {
      if (p === "/" || p === "/health") return json({ status: "ok", edge: "yrcine", routes: ["/api/tmdb", "/api/catalog", "/api/proxy", "/api/embed", "/api/image"] });
      if (p === "/api/tmdb" || p.startsWith("/api/tmdb/")) return await tmdb(env, ctx, p.replace(/^\/api\/tmdb/, ""), u.search);
      if (p === "/api/catalog") {
        const src = (u.searchParams.get("source") || "tmdb").toLowerCase();
        if (src === "anilist") return await anilist(ctx);
        return await tmdb(env, ctx, u.searchParams.get("path") || "/trending/all/day", "");
      }
      if (p === "/api/proxy") return await proxy(request, u);
      if (p === "/api/embed") return await embed(request, u);
      if (p === "/api/image") return await image(env, ctx, u);
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }
};
