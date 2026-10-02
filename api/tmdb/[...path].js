import { relay } from "../_lib/relay.js";
export const config = { runtime: "edge" };
export default function handler(req) { return relay(req, process.env); }
