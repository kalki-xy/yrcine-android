/**
 * GET /api/health — service + provider diagnostics.
 * Probes each upstream in parallel with a short timeout and reports status,
 * so a "streams are broken" report can be traced to a specific provider.
 */
export const config = { runtime: "edge" };

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "*" };

async function probe(name, url, ms = 6000, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, ms);
  const started = Date.now();
  try {
    const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: ctl.signal, redirect: "follow" });
    clearTimeout(t);
    return { provider: name, up: r.ok, status: r.status, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(t);
    return { provider: name, up: false, status: 0, ms: Date.now() - started, error: String((e && e.message) || e) };
  }
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const env = process.env || {};
  const hasTmdb = !!env.TMDB_API_KEY;

  const jobs = [
    probe("anikoto", "https://anikoto.net/"),
    probe("animesalt", "https://animesalt.cx/"),
    probe("mangadex", "https://api.mangadex.org/manga?limit=1"),
    probe("vidsrc", "https://vidsrc.to/"),
  ];
  if (hasTmdb) jobs.push(probe("tmdb", "https://api.themoviedb.org/3/configuration?api_key=" + env.TMDB_API_KEY));

  const providers = await Promise.all(jobs);
  const upCount = providers.filter((p) => p.up).length;

  const body = {
    status: upCount > 0 ? "online" : "degraded",
    service: "yrcine-api",
    runtime: "vercel-edge",
    sections: ["anime", "movie", "manga"],
    anime_providers: ["anikoto", "vidsrc", "animesalt"],
    movie_providers: ["vidsrc-vidplay", "vidsrc-filemoon"],
    features: ["hls-proxy", "embed-adblock", "metadata-cache", "unified-search"],
    config: {
      tmdb_key: hasTmdb ? "set" : "MISSING — /api/tmdb and /api/movie/search will 500",
      anikoto_base: env.ANIKOTO_BASE || "https://anikoto.net",
      animesalt_base: env.ANIMESALT_BASE || "https://animesalt.cx",
    },
    providers,
    routes: [
      "/api/health", "/api/search",
      "/api/tmdb", "/api/catalog", "/api/proxy", "/api/embed", "/api/image",
      "/api/stream/anime/search", "/api/stream/anime/play", "/api/stream/anime/sources", "/api/stream/anime/episodes",
      "/api/stream/movie/search", "/api/stream/movie/stream",
      "/api/stream/manga/search", "/api/stream/manga/chapters", "/api/stream/manga/pages",
    ],
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
