/**
 * YRcine Stream API  —  self-owned multi-provider backend
 * -------------------------------------------------------------------------
 * One file. No npm packages, no build step. Cloudflare Workers + Vercel Edge.
 *
 * Sections & providers
 *   anime   123anime.la  (by AniList slug)          -> own HLS proxy
 *   anime   vidsrc.to    (by TMDB id, tv/movie)     -> fallback provider
 *   movie  vidsrc.to     Vidplay + Filemoon         -> direct m3u8 + proxy
 *   movie  TMDB metadata (key server-side)
 *   manga  MangaDex official API (no scraping, no key)
 *
 * Routes
 *   GET /health
 *   GET /anime/search?query=naruto
 *   GET /anime/play?id=<slug>&ep=1                123anime provider
 *   GET /anime/play?tmdb=<id>&s=1&e=1             vidsrc fallback provider
 *   GET /anime/proxy?url=<enc>&id&ep              HLS proxy (anime)
 *   GET /movie/search?query=dune
 *   GET /movie/trending
 *   GET /movie/detail?id=<tmdb>&type=movie|tv
 *   GET /movie/stream?id=<tmdb|tt>&s=&e=          resolved m3u8 sources
 *   GET /media/proxy?url=<enc>&ref=<referer>      generic media proxy (movie CDNs)
 *   GET /manga/search?query=solo leveling
 *   GET /manga/chapters?id=<uuid>
 *   GET /manga/pages?id=<uuid>&saver=1
 *
 * Env: SRC_BASE (anime host), TMDB_API_KEY (enables /movie metadata)
 */

const DEFAULT_SRC = "https://123anime.la";
const MANGADEX = "https://api.mangadex.org";
const TMDB = "https://api.themoviedb.org/3";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/* vidsrc.to source-url key + rotating vidplay keys (fetched live, with fallback) */
const VIDSRC_TO_KEY = "WXrUARXb1aDLaZjI";
const VIDPLAY_KEYS_FALLBACK = ["dawQCziL2v", "E1KyOcIMf9v7XHg"];
const VIDPLAY_KEYS_URL = "https://raw.githubusercontent.com/Ciarands/vidsrc-keys/main/keys.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const SRC = (env) => (env && env.SRC_BASE ? String(env.SRC_BASE).replace(/\/+$/, "") : DEFAULT_SRC);

async function get(url, headers = {}) {
  return fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "follow" });
}

/* =======================================================================
 * CRYPTO / UNPACKERS  (ported from the vidsrc reference implementation)
 * ======================================================================= */
const te = (s) => new TextEncoder().encode(s);
const td = (b) => new TextDecoder().decode(b);

function rc4(keyBytes, srcBytes) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 255;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(srcBytes.length);
  let i = 0, k = 0;
  for (let n = 0; n < srcBytes.length; n++) {
    i = (i + 1) & 255;
    k = (k + s[i]) & 255;
    const t = s[i]; s[i] = s[k]; s[k] = t;
    out[n] = srcBytes[n] ^ s[(s[i] + s[k]) & 255];
  }
  return out;
}

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
  return o;
};
const bytesToB64 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};

/* vidsrc.to returns the embed URL as base64+RC4; undo both */
function decodeSourceUrl(enc, key) {
  const std = enc.replace(/_/g, "/").replace(/-/g, "+");
  return decodeURIComponent(td(rc4(te(key), b64ToBytes(std))));
}

/* Dean-Edwards-style JS packer unpacker (Filemoon / Superembed) */
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
function int2base(x, base) {
  if (x === 0) return "0";
  let out = "";
  while (x) { out = B62[x % base] + out; x = Math.floor(x / base); }
  return out;
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function unpackPacker(p, a, c, k) {
  for (let i = c - 1; i >= 0; i--) {
    if (k[i]) p = p.replace(new RegExp("\\b" + escRe(int2base(i, a)) + "\\b", "g"), k[i]);
  }
  return p;
}
function unpackFromHtml(html) {
  const m = html.match(/return p}\((.+)\)/);
  if (!m) return html;
  const parts = m[1].split(",");
  const p = parts.slice(0, -3).join(",");
  const a = parseInt(parts[parts.length - 3], 10);
  const c = parseInt(parts[parts.length - 2], 10);
  let kstr = parts[parts.length - 1].replace(/\.split\(['"]\|['"]\)/, "");
  kstr = kstr.replace(/[)\s]+$/, "").trim();
  kstr = kstr.replace(/^['"]|['"]$/g, "");
  const k = kstr.split("|");
  return unpackPacker(p.replace(/^['"]|['"]$/g, ""), a, c, k);
}

/* =======================================================================
 * ANIME PROVIDER A — anikoto.net (HiAnime/Zoro-style) + megaCloud resolver
 * ======================================================================= */
const ANIKOTO_DEFAULT = "https://anikoto.net";
const ANIKOTO = (env) => (env && env.ANIKOTO_BASE ? String(env.ANIKOTO_BASE).replace(/\/+$/, "") : ANIKOTO_DEFAULT);
const ANIKOTO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const akHeaders = (base, referer) => ({
  "User-Agent": ANIKOTO_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: referer || base + "/",
  "X-Requested-With": "XMLHttpRequest",
});

async function anikotoSearch(query, env) {
  const base = ANIKOTO(env);
  const html = await (await get(`${base}/filter?keyword=${encodeURIComponent(query)}`, akHeaders(base))).text();
  const out = [], seen = new Set();
  const blocks = html.split(/<div[^>]*class="[^"]*(?:flw-item|film_list-wrap|item)[^"]*"[^>]*>/i).slice(1);
  for (const b of blocks) {
    const href = (b.match(/href="([^"]*\/watch\/[^"#?]+)"/i) || [])[1];
    if (!href) continue;
    const slug = href.replace(/^https?:\/\/[^/]+/, "").replace(/^\/watch\//, "").replace(/\/ep-\d+$/, "").replace(/\/$/, "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    let title = (b.match(/class="[^"]*(?:d-title|name)[^"]*"[^>]*>([^<]+)</i) || [])[1] || "";
    title = title.replace(/\s+/g, " ").trim();
    let image = (b.match(/<img[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1] || "";
    if (image && !/^https?:/i.test(image)) image = base + (image.startsWith("/") ? image : "/" + image);
    if (title) out.push({ id: slug, slug, title, image, poster: image, provider: "anikoto" });
  }
  return out;
}

function parseEpisodeLinks(html) {
  const out = [], re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    if (!/\/watch\//.test(a) && !/data-num=/.test(a)) continue;
    const num = (a.match(/data-num="([^"]+)"/) || [])[1] || (a.match(/\/ep-(\d+)/) || [])[1];
    if (!num) continue;
    out.push({
      num: parseFloat(num),
      dataIds: (a.match(/data-ids="([^"]+)"/) || [])[1] || (a.match(/data-id="([^"]+)"/) || [])[1] || "",
      dataMal: (a.match(/data-mal="([^"]+)"/) || [])[1] || "",
      dataTs: (a.match(/data-timestamp="([^"]+)"/) || [])[1] || "",
      title: (a.match(/title="([^"]+)"/) || [])[1] || `Episode ${num}`,
    });
  }
  return out.filter((e) => Number.isFinite(e.num));
}

async function anikotoEpisodes(slug, env) {
  const base = ANIKOTO(env);
  let html = await (await get(`${base}/watch/${encodeURIComponent(slug)}`, akHeaders(base))).text();
  let eps = parseEpisodeLinks(html);
  if (!eps.length) {
    const animeId = (html.match(/id="watch-main"[^>]*data-id="([^"]+)"/i) || [])[1];
    if (animeId) {
      try {
        const j = await (await get(`${base}/ajax/episode/list/${encodeURIComponent(animeId)}`, akHeaders(base))).json();
        eps = parseEpisodeLinks((j && j.result) || "");
      } catch (_) {}
    }
  }
  return Array.from(new Map(eps.map((e) => [e.num, e])).values()).sort((x, y) => x.num - y.num);
}

async function anikotoServers(dataIds, env) {
  const base = ANIKOTO(env);
  const j = await (await get(`${base}/ajax/server/list?servers=${encodeURIComponent(dataIds)}`, akHeaders(base))).json().catch(() => ({}));
  const html = (j && j.result) || "";
  const out = [], re = /<[^>]*data-link-id="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    out.push({
      linkId: m[1],
      svId: (tag.match(/data-sv-id="([^"]+)"/) || [])[1] || "",
      name: tag.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || "Server",
    });
  }
  return out;
}

async function anikotoServerUrl(linkId, svId, env) {
  const base = ANIKOTO(env);
  const j = await (await get(`${base}/ajax/server?get=${encodeURIComponent(linkId)}&sv=${encodeURIComponent(svId)}`, akHeaders(base))).json().catch(() => ({}));
  return (j && j.result && j.result.url) || "";
}

/* ---- megaCloud: AES-128-CBC via WebCrypto (portable, no node crypto) ---- */
const MG_KEYS_URL = "https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json";
const MG_FALLBACK = { key: "c1d17096f2ca11b7", iv: "9d7759e7d9e83908" };
let _mgKeys = null, _mgKeysAt = 0;

async function megacloudKeys() {
  if (_mgKeys && Date.now() - _mgKeysAt < 900000) return _mgKeys;
  let k = MG_FALLBACK;
  try {
    const j = await (await get(MG_KEYS_URL)).json();
    if (j && (j.mega || j.key)) k = { key: j.key || MG_FALLBACK.key, iv: j.iv || MG_FALLBACK.iv };
  } catch (_) {}
  _mgKeys = k; _mgKeysAt = Date.now();
  return k;
}

async function aesCbcDecrypt(b64, keyStr, ivStr) {
  const key = await crypto.subtle.importKey("raw", te(keyStr), { name: "AES-CBC" }, false, ["decrypt"]);
  const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: te(ivStr) }, key, b64ToBytes(b64));
  return td(new Uint8Array(out));
}

async function resolveMegacloud(embedUrl) {
  const origin = new URL(embedUrl).origin;
  const html = await (await get(embedUrl, { Referer: origin + "/" })).text();
  const m1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  const m2 = html.match(/\b([a-zA-Z0-9]{16})\b[\s\S]*?\b([a-zA-Z0-9]{16})\b[\s\S]*?\b([a-zA-Z0-9]{16})\b/);
  const nonce = (m1 && m1[0]) || (m2 ? m2[1] + m2[2] + m2[3] : null);
  const sId = ((embedUrl.split("/e-1/")[1] || embedUrl.split("/").pop() || "") + "").split("?")[0];

  const urls = [];
  if (nonce) urls.push(`${origin}/embed-2/v3/e-1/getSources?id=${encodeURIComponent(sId)}&_k=${encodeURIComponent(nonce)}`);
  urls.push(`${origin}/embed-2/ajax/e-1/getSources?id=${encodeURIComponent(sId)}`);

  let data = null;
  for (const u of urls) {
    try {
      const r = await get(u, { Referer: embedUrl, "X-Requested-With": "XMLHttpRequest", Accept: "*/*" });
      if (r.ok) { const j = await r.json(); if (j && (j.sources || j.tracks)) { data = j; break; } }
    } catch (_) {}
  }
  if (!data) return null;

  const src0 = data.sources && data.sources[0];
  let m3u8 = "";
  if (src0 && typeof src0.file === "string" && /\.m3u8/i.test(src0.file)) m3u8 = src0.file;
  else {
    const blob = typeof data.sources === "string" ? data.sources : src0 && src0.file;
    if (typeof blob === "string" && blob) {
      const k = await megacloudKeys();
      for (const pair of [[k.key, k.iv], [MG_FALLBACK.key, MG_FALLBACK.iv]]) {
        if (!pair[0] || !pair[1]) continue;
        try {
          const arr = JSON.parse(await aesCbcDecrypt(blob, pair[0], pair[1]));
          if (arr && arr[0] && arr[0].file) { m3u8 = arr[0].file; break; }
        } catch (_) {}
      }
    }
  }
  if (!m3u8) return null;
  const subtitles = (data.tracks || []).filter((t) => t && t.file).map((t) => ({ lang: t.label || "Unknown", url: t.file }));
  return { m3u8, subtitles, referer: origin + "/" };
}

/* full chain: slug + episode -> { type, m3u8|embed } */
async function anikotoStream(slug, ep, env) {
  const eps = await anikotoEpisodes(slug, env);
  if (!eps.length) throw new Error("anikoto: no episodes");
  const target = eps.find((e) => e.num === Number(ep)) || eps[Number(ep) - 1];
  if (!target || !target.dataIds) throw new Error("anikoto: episode not found");

  const servers = await anikotoServers(target.dataIds, env);
  let fallback = null;
  for (const sv of servers.slice(0, 8)) {
    try {
      const embed = await anikotoServerUrl(sv.linkId, sv.svId, env);
      if (!embed || !/^https?:/i.test(embed)) continue;
      const res = await resolveMegacloud(embed).catch(() => null);
      if (res && res.m3u8) return { type: "hls", m3u8: res.m3u8, referer: res.referer, subtitles: res.subtitles, server: sv.name };
      if (!fallback) fallback = { type: "embed", embed, server: sv.name };
    } catch (_) {}
  }
  if (fallback) return fallback;
  throw new Error("anikoto: no playable server");
}

/* =======================================================================
 * MOVIE / ANIME PROVIDER B — vidsrc.to  (Vidplay + Filemoon)
 * ======================================================================= */
let _keys = null;
async function vidplayKeys() {
  if (_keys) return _keys;
  try {
    const j = await (await get(VIDPLAY_KEYS_URL)).json();
    if (Array.isArray(j) && j.length >= 2) { _keys = [j[0], j[1]]; return _keys; }
  } catch (_) {}
  _keys = VIDPLAY_KEYS_FALLBACK.slice();
  return _keys;
}

async function vidplayResolve(embedUrl, keys) {
  const [srcUrl, subUrl] = embedUrl.split("?");
  const id = srcUrl.split("/e/").pop();
  const d1 = rc4(te(keys[0]), te(id));
  const d2 = rc4(te(keys[1]), d1);
  const key = bytesToB64(d2).replace(/\//g, "_");

  const fHtml = await (await get("https://vidplay.online/futoken", { Referer: embedUrl })).text();
  const fm = fHtml.match(/var\s+k\s*=\s*'([^']+)'/);
  if (!fm) throw new Error("vidplay: no futoken");
  const fu = fm[1];

  const offs = [];
  for (let i = 0; i < key.length; i++) offs.push(fu.charCodeAt(i % fu.length) + key.charCodeAt(i));
  const data = fu + "," + offs.join(",");

  const mi = await (await get(`https://vidplay.online/mediainfo/${data}?${subUrl || ""}&autostart=true`, {
    Referer: embedUrl,
  })).json().catch(() => ({}));
  const file = mi && mi.result && mi.result.sources && mi.result.sources[0] && mi.result.sources[0].file;
  if (!file) throw new Error("vidplay: no file");
  return file;
}

async function filemoonResolve(embedUrl) {
  const html = await (await get(embedUrl)).text();
  const unpacked = unpackFromHtml(html);
  const m = unpacked.match(/file:\s*"([^"]*)"/) || html.match(/file:\s*"([^"]*)"/);
  if (!m) throw new Error("filemoon: no file");
  return m[1];
}

async function vidsrcTo(dbid, s, e) {
  const media = s && e ? "tv" : "movie";
  const idUrl = `https://vidsrc.to/embed/${media}/${encodeURIComponent(dbid)}` + (s && e ? `/${s}/${e}` : "");
  const html = await (await get(idUrl)).text();
  const dm = html.match(/data-id="([^"]+)"/);
  if (!dm) throw new Error("vidsrc: no source id");

  const sj = await (await get(`https://vidsrc.to/ajax/embed/episode/${dm[1]}/sources`)).json().catch(() => ({}));
  const list = ((sj && sj.result) || []).filter((x) => ["Vidplay", "Filemoon"].includes(x.title));
  const keys = await vidplayKeys();

  const out = [];
  for (const src of list) {
    try {
      const sr = await (await get(`https://vidsrc.to/ajax/embed/source/${src.id}`)).json().catch(() => ({}));
      const enc = sr && sr.result && sr.result.url;
      if (!enc) continue;
      const dec = decodeSourceUrl(enc, VIDSRC_TO_KEY);
      const url = src.title === "Vidplay" ? await vidplayResolve(dec, keys) : await filemoonResolve(dec);
      if (url) out.push({ name: src.title, url });
    } catch (_) { /* try the next source */ }
  }
  return out;
}

/* =======================================================================
 * PLAYLIST REWRITING + PROXY
 * ======================================================================= */
function rewritePlaylist(text, playlistUrl, selfOrigin, proxyPath, q) {
  const base = playlistUrl.substring(0, playlistUrl.lastIndexOf("/") + 1);
  return text.replace(/^(?!#)(.+)$/gm, (line) => {
    const t = line.trim();
    if (!t) return line;
    const abs = /^https?:/i.test(t) ? t : base + t;
    return `${selfOrigin}${proxyPath}?url=${encodeURIComponent(abs)}${q || ""}`;
  });
}

async function proxyUrl(req, target, extraHeaders, proxyPath, q) {
  const u = new URL(req.url);
  const headers = { "User-Agent": UA, "Accept-Encoding": "identity", ...extraHeaders };
  const range = req.headers.get("Range");
  if (range) headers["Range"] = range;

  const up = await fetch(target, { headers, redirect: "follow" });
  const ct = up.headers.get("content-type") || "";

  if (/\.m3u8(\?|$)/i.test(target) || /mpegurl/i.test(ct)) {
    const body = await up.text();
    return new Response(rewritePlaylist(body, target, u.origin, proxyPath, q), {
      headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "public, max-age=300" },
    });
  }
  const out = new Headers(CORS);
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    if (up.headers.has(k)) out.set(k, up.headers.get(k));
  }
  out.set("Cache-Control", "public, max-age=86400");
  return new Response(up.body, { status: up.status, headers: out });
}

async function animeProxy(req) {
  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  if (!target || !/^https?:/i.test(target)) return json({ error: "url must be absolute" }, 400);
  const ref = u.searchParams.get("ref") || "";
  let hdrs = {};
  if (ref) { try { hdrs = { Referer: ref, Origin: new URL(ref).origin }; } catch (_) {} }
  const q = ref ? `&ref=${encodeURIComponent(ref)}` : "";
  return proxyUrl(req, target, hdrs, "/api/stream/anime/proxy", q);
}

async function mediaProxy(req) {
  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  if (!target || !/^https?:/i.test(target)) return json({ error: "url must be absolute" }, 400);
  const ref = u.searchParams.get("ref");
  const hdrs = ref ? { Referer: ref, Origin: new URL(ref).origin } : {};
  const q = ref ? `&ref=${encodeURIComponent(ref)}` : "";
  return proxyUrl(req, target, hdrs, "/api/stream/media/proxy", q);
}

/* =======================================================================
 * MANGA / MANHWA — official MangaDex API
 * ======================================================================= */
const pickTitle = (attrs) => {
  const t = (attrs && attrs.title) || {};
  return t.en || Object.values(t)[0] || "Untitled";
};

async function mangaSearch(query, limit = 12) {
  const url =
    `${MANGADEX}/manga?title=${encodeURIComponent(query)}&limit=${limit}` +
    `&includes[]=cover_art&order[relevance]=desc&contentRating[]=safe&contentRating[]=suggestive`;
  const r = await get(url, { Accept: "application/json" });
  if (!r.ok) throw new Error(`mangadex ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((m) => {
    const cover = (m.relationships || []).find((x) => x.type === "cover_art");
    const file = cover && cover.attributes && cover.attributes.fileName;
    return {
      id: m.id,
      title: pickTitle(m.attributes),
      status: (m.attributes && m.attributes.status) || "",
      year: (m.attributes && m.attributes.year) || null,
      cover: file ? `https://uploads.mangadex.org/covers/${m.id}/${file}.512.jpg` : "",
    };
  });
}

async function mangaChapters(id) {
  const r = await get(`${MANGADEX}/manga/${encodeURIComponent(id)}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=500`, { Accept: "application/json" });
  if (!r.ok) throw new Error(`mangadex ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((c) => ({
    id: c.id,
    chapter: (c.attributes && c.attributes.chapter) || "",
    volume: (c.attributes && c.attributes.volume) || "",
    title: (c.attributes && c.attributes.title) || "",
    pages: (c.attributes && c.attributes.pages) || 0,
    lang: (c.attributes && c.attributes.translatedLanguage) || "",
  }));
}

async function mangaPages(id, saver) {
  const r = await get(`${MANGADEX}/at-home/server/${encodeURIComponent(id)}`, { Accept: "application/json" });
  if (!r.ok) throw new Error(`mangadex ${r.status}`);
  const j = await r.json();
  const base = j.baseUrl, hash = j.chapter && j.chapter.hash;
  const files = (saver ? j.chapter && j.chapter.dataSaver : j.chapter && j.chapter.data) || [];
  const mode = saver ? "data-saver" : "data";
  return { base, hash, pages: files.map((f) => `${base}/${mode}/${hash}/${f}`) };
}

/* =======================================================================
 * MOVIE METADATA — TMDB (key server-side)
 * ======================================================================= */
async function tmdb(path, params, env) {
  const key = env && env.TMDB_API_KEY;
  if (!key) throw new Error("TMDB_API_KEY is not configured on this API");
  const qs = new URLSearchParams({ api_key: key, ...params });
  const r = await get(`${TMDB}${path}?${qs.toString()}`, { Accept: "application/json" });
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  return r.json();
}

function shapeMovie(m, type) {
  const t = type || m.media_type || (m.title ? "movie" : "tv");
  return {
    id: m.id, type: t,
    title: m.title || m.name || "",
    year: String(m.release_date || m.first_air_date || "").slice(0, 4),
    rating: m.vote_average ? Number(m.vote_average).toFixed(1) : "",
    overview: m.overview || "",
    poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : "",
    backdrop: m.backdrop_path ? `https://image.tmdb.org/t/p/w780${m.backdrop_path}` : "",
  };
}


/* =======================================================================
 * ANIME PROVIDER C — animesalt.cx  (plain fetch, embed servers)
 * ======================================================================= */
const ANIMESALT_DEFAULT = "https://animesalt.cx";
const ANIMESALT = (env) => (env && env.ANIMESALT_BASE ? String(env.ANIMESALT_BASE).replace(/\/+$/, "") : ANIMESALT_DEFAULT);

function parseAnimesaltSearch(html) {
  const out = [], seen = new Set();
  const chunks = html.split(/<li\b[^>]*>/i).filter((c) => /entry-title/i.test(c));
  for (const b of chunks) {
    const href =
      (b.match(/<a[^>]*class="[^"]*lnk-blk[^"]*"[^>]*href="([^"]+)"/i) || [])[1] ||
      (b.match(/href="(https?:\/\/[^"]+\/(?:series|movies)\/[^"]+)"/i) || [])[1];
    if (!href) continue;
    const id = href.replace(/\/$/, "").split("/").pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let title = (b.match(/<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || "";
    title = title.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    let image = (b.match(/<img[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1] || "";
    if (image.startsWith("//")) image = "https:" + image;
    const type = /type-movies|\/movies\//i.test(b) ? "movie" : "series";
    if (title) out.push({ id, slug: id, title, image, poster: image, type, provider: "animesalt", url: href });
  }
  return out;
}

async function animesaltSearch(query, env) {
  const base = ANIMESALT(env);
  const r = await get(`${base}/?s=${encodeURIComponent(query)}`, { Referer: base + "/" });
  if (!r.ok) throw new Error(`animesalt ${r.status}`);
  return parseAnimesaltSearch(await r.text());
}

async function animesaltStreams(pageUrl, env) {
  const base = ANIMESALT(env);
  let url = String(pageUrl || "");
  if (url && !/^https?:/i.test(url)) url = base + (url.startsWith("/") ? url : "/" + url);
  if (!/\/$/.test(url) && !url.includes("?")) url += "/";
  const html = await (await get(url, { Referer: base + "/" })).text();

  const out = [];
  const re = /<iframe\b[^>]*?(?:data-src|src)="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1].replace(/&#038;/g, "&");
    if (src.includes("?data=")) {
      try {
        const b64 = new URL(src).searchParams.get("data").replace(/-/g, "+").replace(/_/g, "/");
        for (const st of JSON.parse(atob(b64))) out.push({ server: "abyss", language: st.language || "Default", embed: st.link });
        continue;
      } catch (_) {}
    }
    out.push({ server: /as-cdn/.test(src) ? "playX" : "server", language: "Default", embed: src });
  }
  return out;
}

/* =======================================================================
 * AD BLOCKER — fetch a third-party player page and strip its ads
 * ======================================================================= */
const AD_RE =
  /(popads|popcash|propellerads|propeller|adsterra|hilltopads|clickadu|exoclick|juicyads|trafficjunky|trafficstars|mgid|revcontent|taboola|outbrain|onclickads|highperformanceformat|adcash|admaven|monetag|adf\.ly|adnium|bidvertiser|googlesyndication|doubleclick|googletagmanager|google-analytics|histats|yandex\.ru\/metrika|pushnami|pushengage|onesignal|clickaine|adspyglass)/i;

const POPUP_GUARD =
  "<script>(function(){" +
  "try{window.open=function(){return {focus:function(){},close:function(){},location:{href:''}};};}catch(e){}" +
  "try{Object.defineProperty(window,'open',{value:function(){return null;},writable:false});}catch(e){}" +
  "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[target=_blank]');if(a){e.preventDefault();e.stopPropagation();}},true);" +
  "})();<\/script>";

function sanitizePlayer(html, baseUrl) {
  let out = String(html);
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => (AD_RE.test(m) ? "" : m));
  out = out.replace(/<ins\b[^>]*class="[^"]*(adsbygoogle|ad-slot|advert)[^"]*"[^>]*>[\s\S]*?<\/ins>/gi, "");
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (m) => (AD_RE.test(m) ? "" : m));
  out = out.replace(/<iframe\b[^>]*\/?>/gi, (m) => (AD_RE.test(m) ? "" : m));
  out = out.replace(/\starget\s*=\s*["']_blank["']/gi, ' target="_self"');
  const head = `<base href="${baseUrl}">` + POPUP_GUARD;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  else out = head + out;
  return out;
}

async function embedProxy(req) {
  const u = new URL(req.url);
  const target = u.searchParams.get("url");
  if (!target || !/^https?:/i.test(target)) return json({ error: "url must be absolute" }, 400);
  let ref = u.searchParams.get("ref");
  if (!ref) { try { ref = new URL(target).origin + "/"; } catch (_) { ref = ""; } }

  const r = await get(target, ref ? { Referer: ref } : {});
  const ct = r.headers.get("content-type") || "";
  if (!/html/i.test(ct)) {
    const h = new Headers(CORS);
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) if (r.headers.has(k)) h.set(k, r.headers.get(k));
    return new Response(r.body, { status: r.status, headers: h });
  }
  const clean = sanitizePlayer(await r.text(), target);
  /* we build a fresh response, so the upstream's X-Frame-Options / CSP never
     reach the browser — the sanitised page is embeddable */
  return new Response(clean, {
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}


/* =======================================================================
 * MOVIE PROVIDER — flixhq.to (also goku.sx / sflix.to, same layout+IDs)
 * Returns embed servers; play them through /api/stream/embed (ad-blocked).
 * Grounded in emnextech/movie-scraper-api.
 * ======================================================================= */
const FLIXHQ_DEFAULT = "https://flixhq.to";
const FLIXHQ = (env) => (env && env.FLIXHQ_BASE ? String(env.FLIXHQ_BASE).replace(/\/+$/, "") : FLIXHQ_DEFAULT);

function parseFlixhqSearch(html, base) {
  const out = [], seen = new Set();
  const blocks = html.split(/<div[^>]*class="[^"]*flw-item[^"]*"[^>]*>/i).slice(1);
  for (const b of blocks) {
    const href =
      (b.match(/<a[^>]*class="[^"]*film-poster-ahref[^"]*"[^>]*href="([^"]+)"/i) || [])[1] ||
      (b.match(/href="(\/(?:movie|tv)\/[^"#?]+)"/i) || [])[1];
    if (!href) continue;
    const id = href.replace(/^\//, "").replace(/\/+$/, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let title = (b.match(/class="[^"]*film-name[^"]*"[^>]*>\s*<a[^>]*>([^<]+)</i) || [])[1] || "";
    title = title.replace(/\s+/g, " ").trim();
    let poster = (b.match(/<img[^>]*class="[^"]*film-poster-img[^"]*"[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1] || "";
    if (poster && !/^https?:/i.test(poster)) poster = base + (poster.startsWith("/") ? poster : "/" + poster);
    if (!title) continue;
    out.push({ id, slug: id, title, image: poster, poster, type: /^movie\//.test(id) ? "movie" : "series", provider: "flixhq" });
  }
  return out;
}

async function flixhqSearchAt(base, query) {
  const slug = String(query).trim().replace(/\s+/g, "-");
  const r = await get(`${base}/search/${encodeURIComponent(slug)}`, { Referer: base + "/" });
  if (!r.ok) throw new Error(`flixhq ${r.status}`);
  return parseFlixhqSearch(await r.text(), base);
}
async function flixhqSearch(query, env) { return flixhqSearchAt(FLIXHQ(env), query); }

async function flixhqServersAt(base, id) {
  const numId = (String(id).match(/-(\d+)$/) || [])[1];
  if (!numId) throw new Error("flixhq: no numeric id in '" + id + "'");
  const isMovie = /^movie\//.test(id);
  const url = isMovie ? `${base}/ajax/movie/episodes/${numId}` : `${base}/ajax/season/episodes/${numId}`;
  const html = await (await get(url, { Referer: `${base}/${id}`, "X-Requested-With": "XMLHttpRequest" })).text();
  const out = [], re = /<a\b([^>]*data-linkid="[^"]+"[^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const linkId = (m[1].match(/data-linkid="([^"]+)"/) || [])[1];
    if (!linkId) continue;
    const name = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || "Server";
    const slug = String(id).replace(/^movie\//, "").replace(/^tv\//, "");
    const prefix = isMovie ? "watch-movie" : "watch-tv";
    out.push({ server: name, embed: `${base}/${prefix}/${slug}.${linkId}` });
  }
  return out;
}
async function flixhqServers(id, env) { return flixhqServersAt(FLIXHQ(env), id); }



/* =======================================================================
 * ANIME PROVIDER — HiAnime / AniWatch (aniwatchtv.to)
 * Flow: /search -> /ajax/v2/episode/list -> /ajax/v2/episode/servers
 *       -> /ajax/v2/episode/sources -> megaCloud embed -> resolveMegacloud (HLS)
 * Grounded in codex0555/Aniwatch-Api.
 * ======================================================================= */
const HIANIME_DEFAULT = "https://aniwatchtv.to";
const HIANIME = (env) => (env && env.HIANIME_BASE ? String(env.HIANIME_BASE).replace(/\/+$/, "") : HIANIME_DEFAULT);

function parseHianimeSearch(html, base) {
  const out = [], seen = new Set();
  const blocks = html.split(/<div[^>]*class="[^"]*flw-item[^"]*"[^>]*>/i).slice(1);
  for (const b of blocks) {
    const href = (b.match(/href="([^"]*\/watch\/[^"#?]+)"/i) || [])[1];
    if (!href) continue;
    const slug = href.replace(/^https?:\/\/[^/]+/, "").replace(/^\/watch\//, "").replace(/\/+$/, "").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    let title = (b.match(/class="[^"]*film-name[^"]*"[^>]*>\s*<a[^>]*>([^<]+)</i) || [])[1] || "";
    title = title.replace(/\s+/g, " ").trim();
    let image = (b.match(/<img[^>]*?(?:data-src|src)="([^"]+)"/i) || [])[1] || "";
    if (image && !/^https?:/i.test(image)) image = base + (image.startsWith("/") ? image : "/" + image);
    const hasDub = /tick-dub|is-dub|\(Dub\)/i.test(b);
    const hasSub = /tick-sub|is-sub/i.test(b);
    if (title) out.push({ id: slug, slug, title, image, poster: image, type: hasDub && !hasSub ? "dub" : "sub", provider: "hianime" });
  }
  return out;
}

async function hianimeSearch(query, env) {
  const base = HIANIME(env);
  const r = await get(`${base}/search?keyword=${encodeURIComponent(query)}`, { Referer: base + "/" });
  if (!r.ok) throw new Error(`hianime ${r.status}`);
  return parseHianimeSearch(await r.text(), base);
}

function hianimeAnimeId(html) {
  return (html.match(/id="watch-main"[^>]*data-id="([^"]+)"/i) ||
          html.match(/data-id="([^"]+)"[^>]*id="watch-main"/i) ||
          html.match(/\/watch\/[^"]*-(\d+)/) || [])[1] || "";
}

function parseHianimeEpisodes(html) {
  const out = [], re = /<a\b([^>]*class="[^"]*(?:ep-item|ssl-item)[^"]*"[^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    const num = (a.match(/data-number="([^"]+)"/) || [])[1] || (a.match(/data-num="([^"]+)"/) || [])[1];
    const eid = (a.match(/data-id="([^"]+)"/) || [])[1];
    if (!num || !eid) continue;
    out.push({ num: parseFloat(num), id: eid, title: (a.match(/title="([^"]+)"/) || [])[1] || `Episode ${num}` });
  }
  return out;
}

async function hianimeEpisodes(slug, env) {
  const base = HIANIME(env);
  const html = await (await get(`${base}/watch/${encodeURIComponent(slug)}`, { Referer: base + "/" })).text();
  let eps = parseHianimeEpisodes(html);
  if (!eps.length) {
    const animeId = hianimeAnimeId(html);
    if (animeId) {
      try {
        const j = await (await get(`${base}/ajax/v2/episode/list/${encodeURIComponent(animeId)}`, { Referer: `${base}/watch/${slug}`, "X-Requested-With": "XMLHttpRequest" })).json();
        eps = parseHianimeEpisodes((j && j.html) || "");
      } catch (_) {}
    }
  }
  return Array.from(new Map(eps.map((e) => [e.num, e])).values()).sort((a, b) => a.num - b.num);
}

async function hianimeServers(episodeId, env) {
  const base = HIANIME(env);
  const j = await (await get(`${base}/ajax/v2/episode/servers?id=${encodeURIComponent(episodeId)}`, { Referer: base + "/", "X-Requested-With": "XMLHttpRequest" })).json().catch(() => ({}));
  const html = (j && j.html) || "";
  const out = [], re = /<div\b([^>]*data-server-id="[^"]+"[^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    out.push({
      serverId: (a.match(/data-server-id="([^"]+)"/) || [])[1],
      type: (a.match(/data-type="([^"]+)"/) || [])[1] || "sub",
      name: (a.match(/title="([^"]+)"/) || [])[1] || (a.match(/data-server-name="([^"]+)"/) || [])[1] || "Server",
    });
  }
  return out.filter((x) => x.serverId);
}

async function hianimeStream(slug, ep, env) {
  const base = HIANIME(env);
  const eps = await hianimeEpisodes(slug, env);
  if (!eps.length) throw new Error("hianime: no episodes");
  const target = eps.find((e) => e.num === Number(ep)) || eps[Number(ep) - 1];
  if (!target) throw new Error("hianime: episode not found");

  const servers = await hianimeServers(target.id, env);
  let fallback = null;
  for (const sv of servers.slice(0, 6)) {
    try {
      const j = await (await get(`${base}/ajax/v2/episode/sources?id=${encodeURIComponent(sv.serverId)}`, { Referer: base + "/", "X-Requested-With": "XMLHttpRequest" })).json().catch(() => ({}));
      const link = j && j.link;
      if (!link) continue;
      const res = await resolveMegacloud(link).catch(() => null);
      if (res && res.m3u8) return { type: "hls", m3u8: res.m3u8, referer: res.referer, subtitles: res.subtitles, server: sv.name };
      if (!fallback) fallback = { type: "embed", embed: link, server: sv.name };
    } catch (_) {}
  }
  if (fallback) return fallback;
  throw new Error("hianime: no playable server");
}


/* =======================================================================
 * MANGA SOURCES — manhwa/manga readers
 * ======================================================================= */

/* --- Asura Scans (manhwa) — clean JSON API, no scraping --------------- */
const ASURA_API_DEFAULT = "https://api.asurascans.com/api";
const ASURA_API = (env) => (env && env.ASURA_API ? String(env.ASURA_API).replace(/\/+$/, "") : ASURA_API_DEFAULT);

async function asuraSearch(query, env) {
  const j = await (await get(`${ASURA_API(env)}/series?search=${encodeURIComponent(query)}`)).json().catch(() => ({}));
  return (j.data || []).map((x) => ({
    id: x.slug, slug: x.slug, title: x.title || "", cover: x.cover || "", image: x.cover || "",
    status: x.status || "", type: x.type || "", provider: "asura",
  }));
}
async function asuraChapters(slug, env) {
  const j = await (await get(`${ASURA_API(env)}/series/${encodeURIComponent(slug)}/chapters`)).json().catch(() => ({}));
  return (j.data || []).map((c) => ({
    id: `${slug}|${c.id}`, chapter: String(c.number), title: c.title || "", pages: c.page_count || 0,
  }));
}
async function asuraPages(id, opts, env) {
  const [slug, uuid] = String(id).split("|");
  const j = await (await get(`${ASURA_API(env)}/series/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(uuid)}`)).json().catch(() => ({}));
  const pages = ((((j.data || {}).chapter) || {}).pages) || [];
  return { pages: pages.map((x) => x.url).filter(Boolean) };
}

/* --- MangaPill (manga) — regexes lifted from the app's working code --- */
const MANGAPILL_DEFAULT = "https://mangapill.com";
const MANGAPILL = (env) => (env && env.MANGAPILL_BASE ? String(env.MANGAPILL_BASE).replace(/\/+$/, "") : MANGAPILL_DEFAULT);
const mpUrl = (base, id) => (/^https?:/i.test(id) ? id : base + (String(id).startsWith("/") ? id : "/" + id));

async function mangapillSearch(query, env) {
  const base = MANGAPILL(env);
  const html = await (await get(`${base}/search?q=${encodeURIComponent(query)}`, { Referer: base + "/" })).text();
  const out = [], seen = new Set();
  const re = /<a href="(\/manga\/[^"]+)"[^>]*>\s*<figure[^>]*>\s*<img data-src="([^"]+)"[^>]*alt="([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], slug: m[1], title: (m[3] || "").trim(), cover: m[2], image: m[2], provider: "mangapill" });
  }
  return out;
}
async function mangapillChapters(id, env) {
  const base = MANGAPILL(env);
  const html = await (await get(mpUrl(base, id), { Referer: base + "/" })).text();
  const out = [], seen = new Set();
  const re = /href="(\/chapters\/[^"]+)"[^>]*>\s*([^<]{0,40}?)\s*Chapter\s*(\d+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], chapter: m[3], title: (m[2] || "").trim() });
  }
  return out;
}
async function mangapillPages(id, opts, env) {
  const base = MANGAPILL(env);
  const html = await (await get(mpUrl(base, id), { Referer: base + "/" })).text();
  const out = [];
  const re = /<img[^>]*data-src="(https:\/\/cdn[^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return { pages: out };
}


/* =======================================================================
 * GENERIC MADARA SOURCE (WordPress manga/manhwa themes)
 * One factory covers every Madara site: mgeko.cc, kunmanga.com, and others.
 * Selectors grounded in onursedef/mgeko.cc-paperback (a working extension).
 * ======================================================================= */
function parseMadaraCards(html, base) {
  const out = [], seen = new Set();
  const re = /<a\b([^>]*href="([^"]*\/manga\/[^"]+)"[^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[2];
    if (/\/reader\//.test(href)) continue;
    const slug = href.replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "");
    if (!slug || seen.has(slug)) continue;
    const chunk = html.slice(Math.max(0, m.index - 700), m.index + 700);
    let title =
      (m[1].match(/title="([^"]+)"/) || [])[1] ||
      (chunk.match(/<img[^>]*alt="([^"]+)"/) || [])[1] ||
      (chunk.match(/<h[34][^>]*>([^<]+)</) || [])[1] || "";
    title = title.replace(/&amp;/g, "&").replace(/&#8217;/g, "'").replace(/\s+/g, " ").trim();
    if (!title || /^chapter/i.test(title)) continue;
    let img = (chunk.match(/<img[^>]*?(?:data-src|data-lazy-src|data-original|src)="([^"]+)"/) || [])[1] || "";
    if (img && !/^https?:/i.test(img)) img = base + (img.startsWith("/") ? img : "/" + img);
    if (/logo|favicon|placeholder/i.test(img)) img = "";
    seen.add(slug);
    out.push({ id: slug, slug, title, cover: img, image: img, provider: "madara" });
  }
  return out;
}

function parseMadaraChapters(html) {
  const out = [], seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!/chapter/i.test(href) && !/chapter/i.test(text)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const num = (href.match(/chapter[-/]?(\d+(?:[.-]\d+)?)/i) || text.match(/chapter\s*(\d+(?:[.-]\d+)?)/i) || [])[1] || "";
    out.push({ id: href, chapter: String(num).replace("-", "."), title: text.slice(0, 70) });
  }
  return out;
}

function parseMadaraImages(html) {
  let scope = html;
  const i = html.search(/class="[^"]*(?:reading-content|page-break)[^"]*"/i);
  if (i >= 0) scope = html.slice(i);
  const out = [], seen = new Set();
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(scope))) {
    const tag = m[0];
    const src = (tag.match(/data-src="([^"]+)"/) || tag.match(/data-lazy-src="([^"]+)"/) ||
                 tag.match(/data-original="([^"]+)"/) || tag.match(/src="([^"]+)"/) || [])[1];
    if (!src || seen.has(src)) continue;
    if (/logo|favicon|avatar|emoji|sprite|banner|ads?[._-]|loading/i.test(src)) continue;
    if (/\.svg(\?|$)/i.test(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

function madaraSource(id, name, base, lang) {
  const abs = (u) => (/^https?:/i.test(u) ? u : base + (String(u).startsWith("/") ? u : "/" + u));
  const fetchHtml = async (u) => {
    const r = await get(abs(u), { Referer: base + "/" });
    if (!r.ok) throw new Error(`${id} ${r.status}`);
    return r.text();
  };
  return {
    id, name, type: "manga", lang: lang || "en",
    capabilities: ["search", "chapters", "pages"],
    search: async (query) => {
      const paths = [
        `${base}/?s=${encodeURIComponent(query)}`,
        `${base}/search/?s=${encodeURIComponent(query)}`,
        `${base}/search/?keyword=${encodeURIComponent(query)}`,
      ];
      let html = "";
      for (const u of paths) {
        try { html = await fetchHtml(u); if (/\/manga\//.test(html)) break; } catch (_) {}
      }
      return parseMadaraCards(html, base);
    },
    chapters: async (mid) => {
      const url = abs(mid);
      let html = await fetchHtml(url);
      try {
        const aj = await get(url.replace(/\/+$/, "") + "/ajax/chapters/", { Referer: url, "X-Requested-With": "XMLHttpRequest" });
        if (aj.ok) { const h2 = await aj.text(); if (/chapter/i.test(h2)) html += h2; }
      } catch (_) {}
      return parseMadaraChapters(html);
    },
    pages: async (cid) => ({ pages: parseMadaraImages(await fetchHtml(cid)) }),
  };
}

/* =======================================================================
 * SOURCE REGISTRY  —  Aniyomi-style extensions
 * -----------------------------------------------------------------------
 * Every provider is a self-contained module behind ONE interface, so adding
 * a source is adding an object here (no router changes):
 *
 *   { id, name, type: "anime"|"movie"|"manga", lang, capabilities: [...],
 *     search(query, env)            -> [{ id, title, image, ... }]
 *     episodes(id, env)             -> [{ id, number, title }]
 *     stream(id, episode, env)      -> [{ server, type:"hls"|"embed", url, referer?, subtitles? }]
 *     chapters(id, env) / pages(id, opts, env)   (manga) }
 * ======================================================================= */
export const SOURCES = [
  {
    id: "anikoto", name: "AniKoto", type: "anime", lang: "en",
    capabilities: ["search", "episodes", "stream"],
    search: (q, env) => anikotoSearch(q, env),
    episodes: (id, env) => anikotoEpisodes(id, env),
    stream: async (id, ep, env) => {
      const st = await anikotoStream(id, ep, env);
      return st.type === "hls"
        ? [{ server: st.server || "AniKoto", type: "hls", url: st.m3u8, referer: st.referer, subtitles: st.subtitles || [] }]
        : [{ server: st.server || "AniKoto", type: "embed", url: st.embed }];
    },
  },
  {
    id: "vidsrc", name: "VidSrc", type: "movie", lang: "multi",
    capabilities: ["stream"],
    stream: async (id, ep, env) => {
      const s = ep && ep.season && ep.number ? await vidsrcTo(id, ep.season, ep.number) : await vidsrcTo(id);
      return (s || []).map((x) => ({ server: x.name, type: "hls", url: x.url }));
    },
  },
  {
    id: "animesalt", name: "AnimeSalt", type: "anime", lang: "multi",
    capabilities: ["search", "stream"],
    search: (q, env) => animesaltSearch(q, env),
    stream: async (id, ep, env) => (await animesaltStreams(id, env)).map((x) => ({ server: x.server, type: "embed", url: x.embed, language: x.language })),
  },
  {
    id: "flixhq", name: "FlixHQ", type: "movie", lang: "en",
    capabilities: ["search", "stream"],
    search: (q, env) => flixhqSearch(q, env),
    stream: async (id, ep, env) => (await flixhqServers(id, env)).map((x) => ({ server: x.server, type: "embed", url: x.embed })),
  },
  {
    id: "hianime", name: "HiAnime", type: "anime", lang: "multi",
    capabilities: ["search", "episodes", "stream"],
    search: (q, env) => hianimeSearch(q, env),
    episodes: (id, env) => hianimeEpisodes(id, env),
    stream: async (id, ep, env) => {
      const st = await hianimeStream(id, ep.number || 1, env);
      return st.type === "hls"
        ? [{ server: st.server || "HiAnime", type: "hls", url: st.m3u8, referer: st.referer, subtitles: st.subtitles || [] }]
        : [{ server: st.server || "HiAnime", type: "embed", url: st.embed }];
    },
  },
  {
    id: "goku", name: "Goku", type: "movie", lang: "en",
    capabilities: ["search", "stream"],
    search: (q, env) => flixhqSearchAt("https://goku.sx", q),
    stream: async (id, ep, env) => (await flixhqServersAt("https://goku.sx", id)).map((x) => ({ server: x.server, type: "embed", url: x.embed })),
  },
  {
    id: "sflix", name: "SFlix", type: "movie", lang: "en",
    capabilities: ["search", "stream"],
    search: (q, env) => flixhqSearchAt("https://sflix.to", q),
    stream: async (id, ep, env) => (await flixhqServersAt("https://sflix.to", id)).map((x) => ({ server: x.server, type: "embed", url: x.embed })),
  },
  {
    id: "asura", name: "Asura Scans", type: "manga", lang: "en",
    capabilities: ["search", "chapters", "pages"],
    search: (q, env) => asuraSearch(q, env),
    chapters: (id, env) => asuraChapters(id, env),
    pages: (id, opts, env) => asuraPages(id, opts, env),
  },
  {
    id: "mangapill", name: "MangaPill", type: "manga", lang: "en",
    capabilities: ["search", "chapters", "pages"],
    search: (q, env) => mangapillSearch(q, env),
    chapters: (id, env) => mangapillChapters(id, env),
    pages: (id, opts, env) => mangapillPages(id, opts, env),
  },
  madaraSource("mgeko", "Mgeko", "https://www.mgeko.cc", "en"),
  madaraSource("kunmanga", "KunManga", "https://kunmanga.com", "en"),
  {
    id: "mangadex", name: "MangaDex", type: "manga", lang: "multi",
    capabilities: ["search", "chapters", "pages"],
    search: (q, env) => mangaSearch(q),
    chapters: (id, env) => mangaChapters(id),
    pages: (id, opts, env) => mangaPages(id, opts && opts.saver),
  },
];

export function sourceById(id) { return SOURCES.find((s) => s.id === id) || null; }
export function sourcesForType(type) { return type ? SOURCES.filter((s) => s.type === type) : SOURCES.slice(); }

/* ======================================================================= */
async function route(req, env) {
  const u = new URL(req.url);
  const p = u.pathname.replace(/\/+$/, "");

  /* --- anime ---------------------------------------------------------- */
  if (/\/anime\/search$|\/search$/.test(p) && !/\/manga|\/movie/.test(p)) {
    const q = u.searchParams.get("query") || u.searchParams.get("keyword");
    if (!q) return json({ error: "query is required" }, 400);
    const prov = u.searchParams.get("provider") || u.searchParams.get("source");
    if (prov === "animesalt") return json(await animesaltSearch(q, env));
    if (prov && prov !== "anikoto") return json({ error: "unknown anime source", sources: ["anikoto", "animesalt"] }, 400);
    return json(await anikotoSearch(q, env));
  }
  /* --- extension manager (Aniyomi-style) ------------------------------ */
  if (/\/extensions$/.test(p)) {
    const type = u.searchParams.get("type") || "";
    const q = u.searchParams.get("q") || u.searchParams.get("query");
    if (q) {
      const list = sourcesForType(type).filter((s) => typeof s.search === "function");
      const settled = await Promise.allSettled(list.map((s) => s.search(q, env)));
      const results = {}, errors = {};
      settled.forEach((r, i) => {
        const id = list[i].id;
        if (r.status === "fulfilled") results[id] = r.value || [];
        else errors[id] = String((r.reason && r.reason.message) || r.reason);
      });
      return json({ query: q, type: type || "all", searched: list.map((s) => s.id), results, errors });
    }
    return json({
      count: SOURCES.length,
      sources: SOURCES.map((s) => ({ id: s.id, name: s.name, type: s.type, lang: s.lang, capabilities: s.capabilities })),
    });
  }

  /* --- uniform per-source stream (extension interface) ---------------- */
  if (/\/source-stream$/.test(p)) {
    const sid = u.searchParams.get("source");
    const id = u.searchParams.get("id");
    if (!sid || !id) return json({ error: "source and id are required" }, 400);
    const src = sourceById(sid);
    if (!src || typeof src.stream !== "function") return json({ error: "unknown source", sources: SOURCES.map((s) => s.id) }, 400);
    const ep = { season: Number(u.searchParams.get("s")) || 0, number: Number(u.searchParams.get("ep") || u.searchParams.get("e")) || 1 };
    const streams = await src.stream(id, ep, env);
    return json({ source: sid, id, streams: (streams || []).map((x) => ({ ...x, playUrl: x.type === "embed" ? `${u.origin}/api/stream/embed?url=${encodeURIComponent(x.url)}` : x.url })) });
  }

  if (/\/anime\/proxy$|\/play\/proxy$/.test(p)) return await animeProxy(req, env);
  if (/\/media\/proxy$/.test(p)) return await mediaProxy(req);
  if (/\/embed$/.test(p)) return await embedProxy(req);
  if (/\/anime\/servers$/.test(p)) {
    const url = u.searchParams.get("url") || u.searchParams.get("id");
    if (!url) return json({ error: "url is required" }, 400);
    return json(await animesaltStreams(url, env));
  }
  if (/\/anime\/episodes$/.test(p)) {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    return json(await anikotoEpisodes(id, env));
  }
  if (/\/anime\/sources$/.test(p)) {
    const id = u.searchParams.get("id"), ep = u.searchParams.get("ep");
    if (!id || !ep) return json({ error: "id and ep are required" }, 400);
    const st = await anikotoStream(id, ep, env);
    return json(st.type === "hls"
      ? { type: "hls", url: `${u.origin}/api/stream/anime/proxy?url=${encodeURIComponent(st.m3u8)}${st.referer ? "&ref=" + encodeURIComponent(st.referer) : ""}`, server: st.server, subtitles: st.subtitles }
      : { type: "embed", url: `${u.origin}/api/stream/embed?url=${encodeURIComponent(st.embed)}`, server: st.server });
  }

  if (/\/anime\/play$|\/play$/.test(p) && !/proxy/.test(p)) {
    const tmdb = u.searchParams.get("tmdb");
    const id = u.searchParams.get("id"), ep = u.searchParams.get("ep");
    // provider B: vidsrc (by TMDB id)
    if (tmdb) {
      const s = u.searchParams.get("s") || ep || "1";
      const e = u.searchParams.get("e") || ep || "1";
      const sources = await vidsrcTo(tmdb, s, e);
      if (!sources.length) return json({ error: "no sources", provider: "vidsrc" }, 502);
      const url = `${u.origin}/api/stream/media/proxy?url=${encodeURIComponent(sources[0].url)}`;
      return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=0\n${url}\n`, {
        headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }
    // provider A: anikoto
    if (!id || !ep) return json({ error: "id+ep or tmdb required" }, 400);
    const st = await anikotoStream(id, ep, env);
    if (st.type === "embed") return json({ error: "hls unavailable — play this through /embed", embed: st.embed, server: st.server }, 502);
    const ref = st.referer || "";
    const res = await get(st.m3u8, { ...(ref ? { Referer: ref } : {}), "Accept-Encoding": "identity" });
    if (!res.ok) return json({ error: `upstream playlist ${res.status}` }, 502);
    const text = await res.text();
    return new Response(rewritePlaylist(text, st.m3u8, u.origin, "/api/stream/anime/proxy", ref ? `&ref=${encodeURIComponent(ref)}` : ""), {
      headers: { ...CORS, "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "public, max-age=300" },
    });
  }

  /* --- movie ---------------------------------------------------------- */
  if (/\/movie\/stream$/.test(p)) {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    const s = u.searchParams.get("s"), e = u.searchParams.get("e");
    const sources = await vidsrcTo(id, s, e);
    return json({
      id, type: s && e ? "tv" : "movie",
      sources: sources.map((x) => ({ ...x, proxied: `${u.origin}/api/stream/media/proxy?url=${encodeURIComponent(x.url)}` })),
    });
  }
  if (/\/movie\/servers$/.test(p)) {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    return json(await flixhqServers(id, env));
  }
  if (/\/movie\/search$/.test(p)) {
    const q = u.searchParams.get("query");
    if (!q) return json({ error: "query is required" }, 400);
    const mprov = u.searchParams.get("provider") || u.searchParams.get("source");
    if (mprov === "flixhq") return json(await flixhqSearch(q, env));
    const j = await tmdb("/search/multi", { query: q, include_adult: "false" }, env);
    return json((j.results || []).filter((x) => x.media_type !== "person").map((x) => shapeMovie(x)));
  }
  if (/\/movie\/trending$/.test(p)) {
    const j = await tmdb("/trending/all/week", {}, env);
    return json((j.results || []).map((x) => shapeMovie(x)));
  }
  if (/\/movie\/detail$/.test(p)) {
    const id = u.searchParams.get("id");
    const type = u.searchParams.get("type") === "tv" ? "tv" : "movie";
    if (!id) return json({ error: "id is required" }, 400);
    return json(shapeMovie(await tmdb(`/${type}/${id}`, {}, env), type));
  }

  /* --- manga ---------------------------------------------------------- */
  if (/\/manga\/search$/.test(p)) {
    const q = u.searchParams.get("query") || u.searchParams.get("title");
    if (!q) return json({ error: "query is required" }, 400);
    return json(await mangaSearch(q));
  }
  if (/\/manga\/chapters$/.test(p)) {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    return json(await mangaChapters(id));
  }
  if (/\/manga\/pages$/.test(p)) {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id is required" }, 400);
    return json(await mangaPages(id, u.searchParams.get("saver") === "1"));
  }

  /* --- meta ----------------------------------------------------------- */
  if (p === "" || /\/(health|stream)$/.test(p)) {
    return json({
      status: "online",
      service: "yrcine-stream-api",
      sections: ["anime", "movie", "manga"],
      anime_providers: ["anikoto", "vidsrc", "animesalt"],
      movie_providers: ["vidsrc-vidplay", "vidsrc-filemoon"],
      features: ["hls-proxy", "embed-adblock"],
      anime_source: ANIKOTO(env),
      animesalt_source: ANIMESALT(env),
      movie_enabled: !!(env && env.TMDB_API_KEY),
    });
  }
  return json({ error: "not found" }, 404);
}


export { route as streamRoute };
