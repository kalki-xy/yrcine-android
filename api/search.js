/**
 * GET /api/search?q=<query> — one query across every section, in parallel.
 *   { query, anime: [...], movie: [...], manga: [...] }
 *
 * Each section is fetched from this same deployment (own origin), so a slow or
 * broken section degrades to an empty list + an `errors` entry instead of
 * failing the whole search.
 */
export const config = { runtime: "edge" };

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "*" };

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error("status " + r.status);
    return Array.isArray(j) ? j : (j && j.results) || [];
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") || u.searchParams.get("query") || "").trim();
  if (!q) {
    return new Response(JSON.stringify({ error: "query parameter 'q' is required" }), {
      status: 400, headers: { ...CORS, "content-type": "application/json" },
    });
  }
  const o = u.origin;
  const qe = encodeURIComponent(q);

  const [anime, movie, manga] = await Promise.allSettled([
    getJSON(`${o}/api/stream/anime/search?query=${qe}`),
    getJSON(`${o}/api/tmdb/search/multi?query=${qe}&include_adult=false`),
    getJSON(`${o}/api/stream/manga/search?query=${qe}`),
  ]);

  const val = (r) => (r.status === "fulfilled" ? r.value : []);
  const errors = {};
  if (anime.status === "rejected") errors.anime = String(anime.reason && anime.reason.message || anime.reason);
  if (movie.status === "rejected") errors.movie = String(movie.reason && movie.reason.message || movie.reason);
  if (manga.status === "rejected") errors.manga = String(manga.reason && manga.reason.message || manga.reason);

  // movies: drop people, keep movie/tv
  const movies = val(movie).filter((x) => x && x.media_type !== "person");

  const body = {
    query: q,
    counts: { anime: val(anime).length, movie: movies.length, manga: val(manga).length },
    anime: val(anime),
    movie: movies,
    manga: val(manga),
  };
  if (Object.keys(errors).length) body.errors = errors;

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}
