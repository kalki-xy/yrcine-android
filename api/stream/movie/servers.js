import { streamRoute } from "../../_lib/stream.js";
export const config = { runtime: "edge" };
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  try { return await streamRoute(req, process.env); }
  catch (err) { return new Response(JSON.stringify({ error: String((err && err.message) || err) }), { status: 502, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
}
