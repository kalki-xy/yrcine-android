/**
 * YRcine relay — TMDB, AniList, generic proxy, ad-stripping embed, image proxy.
 * Runs as a Vercel Edge function. Ported from the Cloudflare edge worker, minus
 * the Cloudflare-only Cache API (Vercel Edge has no `caches.default`).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "*",
};
function hdrs(extra) {
  const h = new Headers(extra || {});
  for (const k in CORS) h.set(k, CORS[k]);
  return h;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: hdrs({ "content-type": "application/json; charset=utf-8" }),
  });
}
const ok = (u) => /^https?:\/\//i.test(String(u || ""));

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
  "histats.com", "adskeeper.com", "ad-delivery.net", "profitableratecpm.com", "monetag.com",
];
const AD_PATTERN = "advert|\\bads?\\b|adsbygoogle|popunder|popup|sponsor|banner|interstitial|preroll|google_ads|ad-slot|adslot";
const AD_ALT = AD_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|");
const RE_AD_SCRIPT = new RegExp("<script\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>\\s*</script>", "gi");
const RE_AD_IFRAME = new RegExp("<iframe\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>\\s*</iframe>", "gi");
const RE_AD_LINK   = new RegExp("<link\\b[^>]*\\bhref=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>", "gi");
const RE_AD_IMG    = new RegExp("<img\\b[^>]*\\bsrc=[\"'][^\"']*(?:" + AD_ALT + ")[^\"']*[\"'][^>]*>", "gi");
const RE_AD_DIV    = new RegExp("<(div|ins|section|aside|span)\\b[^>]*\\b(?:class|id)=[\"'][^\"']*(?:" + AD_PATTERN + ")[^\"']*[\"'][^>]*>\\s*</\\1>", "gi");

const POPUP_GUARD =
  "<script>(function(){try{window.open=function(){return {focus:function(){},close:function(){},location:{href:''}};};}catch(e){}" +
  "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[target=_blank]');" +
  "if(a){e.preventDefault();e.stopPropagation();}},true);})();<\/script>";

function stripAds(html, origin) {
  html = html
    .replace(RE_AD_SCRIPT, "")
    .replace(RE_AD_IFRAME, "")
    .replace(RE_AD_LINK, "")
    .replace(RE_AD_IMG, "")
    .replace(RE_AD_DIV, "")
    .replace(/\starget\s*=\s*["']_blank["']/gi, ' target="_self"');
  const inject =
    '<base href="' + origin + '/">' +
    POPUP_GUARD +
    '<style id="yr-adb">ins.adsbygoogle,iframe[src*="ads"],[id^="ad-"],[id*="google_ads"],' +
    '[class*="advert"],[class*="popunder"],[class*="sponsor"],[class*="interstitial"],' +
    '[class*="banner-ad"],[data-ad]{display:none!important;visibility:hidden!important;height:0!important}</style>';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + inject);
  return inject + html;
}

/* ---------- handlers ---------- */
async function tmdb(env, sub, qs) {
  const key = (env && env.TMDB_API_KEY) || "";
  if (!key) return json({ error: "TMDB_API_KEY is not set on this project. Add it under Settings -> Environment Variables." }, 500);
  const sep = qs ? "&" : "?";
  const target = "https://api.themoviedb.org/3" + (sub || "") + (qs || "") + sep + "api_key=" + key;
  const up = await fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
  const body = await up.text();
  return new Response(body, {
    status: up.status,
    headers: hdrs({ "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=900" }),
  });
}

async function anilist() {
  const q = { query: "query{Page(page:1,perPage:30){media(type:ANIME,sort:TRENDING_DESC){id title{romaji english} coverImage{large} format episodes averageScore}}}" };
  const up = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(q),
  });
  const body = await up.text();
  return new Response(body, { status: up.status, headers: hdrs({ "content-type": "application/json; charset=utf-8" }) });
}

async function proxy(request, u) {
  const target = u.searchParams.get("url");
  if (!ok(target)) return json({ error: "missing or bad url" }, 400);
  const init = { method: request.method, headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow" };
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
  let t;
  try { t = new URL(target); } catch (e) { return json({ error: "bad url" }, 400); }
  let up;
  try {
    up = await fetch(target, {
      headers: { "User-Agent": UA, Referer: t.origin + "/", Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
    });
  } catch (e) {
    return new Response("upstream fetch failed", { status: 502, headers: hdrs({ "content-type": "text/plain" }) });
  }
  const ct = up.headers.get("content-type") || "";
  if (!/text\/html/i.test(ct)) {
    return new Response(up.body, { status: up.status, headers: hdrs({ "content-type": ct || "application/octet-stream" }) });
  }
  const clean = stripAds(await up.text(), t.origin);
  return new Response(clean, {
    status: 200,
    headers: hdrs({ "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" }),
  });
}

async function image(u) {
  const target = u.searchParams.get("url");
  if (!ok(target)) return json({ error: "missing or bad url" }, 400);
  const up = await fetch(target, { headers: { "User-Agent": UA, Accept: "image/*" } });
  const ct = up.headers.get("content-type") || "application/octet-stream";
  return new Response(up.body, {
    status: up.status,
    headers: hdrs({ "content-type": ct, "cache-control": "public, max-age=86400" }),
  });
}

/* ---------- dispatcher ---------- */
export async function relay(request, env) {
  const u = new URL(request.url);
  const p = u.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: hdrs() });
  try {
    if (p === "/api/tmdb" || p.startsWith("/api/tmdb/")) return await tmdb(env, p.replace(/^\/api\/tmdb/, ""), u.search);
    if (p === "/api/catalog") {
      const src = (u.searchParams.get("source") || "tmdb").toLowerCase();
      if (src === "anilist") return await anilist();
      return await tmdb(env, u.searchParams.get("path") || "/trending/all/day", "");
    }
    if (p === "/api/proxy") return await proxy(request, u);
    if (p === "/api/embed") return await embed(request, u);
    if (p === "/api/image") return await image(u);
    return json({ error: "not found", routes: ["/api/tmdb", "/api/catalog", "/api/proxy", "/api/embed", "/api/image"] }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502);
  }
}

export const RELAY_CORS = CORS;
export const RELAY_CONFIG = { runtime: "edge" };
