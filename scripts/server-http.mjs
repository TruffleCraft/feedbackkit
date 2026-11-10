import { isIP } from "node:net";

/**
 * The canonical URL for a request: the public origin followed by the request's
 * path and query. The path is appended as text, never resolved against the
 * origin, because a path such as `//host/x` or `/\host/x` would otherwise
 * replace the host. Returns null for such a path (the caller answers 400).
 */
export function canonicalUrl(origin, pathname, search) {
  if (pathname.startsWith("//") || pathname.startsWith("/\\")) return null;
  return new URL(origin.origin + pathname + search);
}

/** Turns "::ffff:203.0.113.7" into "203.0.113.7" and leaves other addresses alone. */
function plain(address) {
  return typeof address === "string" && address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

/**
 * The address of the client that made the request.
 *
 * `hops` is the number of trusted proxies between the client and this server.
 * With 0 the socket peer is the client and every forwarding header is ignored.
 * With N the chain is `X-Forwarded-For` plus the socket peer, and the client is
 * the entry N places from the right. A client can add entries on the left of
 * the chain but cannot change what the trusted proxies appended on the right.
 * A chain that is too short, or an entry that is not an IP address, falls back
 * to the socket peer so that a wrong setting never lets a client choose its
 * own address.
 */
export function clientAddress({ forwardedFor, peer, hops }) {
  const socket = plain(peer) || "unknown";
  if (!(hops > 0)) return socket;
  const chain = [...(forwardedFor ?? "").split(","), socket].map((part) => plain(part.trim()));
  const candidate = chain[chain.length - 1 - hops];
  return candidate && isIP(candidate) ? candidate : socket;
}

/** FK_TRUSTED_PROXY_HOPS as a non-negative integer. Throws on anything else. */
export function readTrustedHops(env) {
  if (env.FK_TRUST_PROXY === "true") throw new Error("FK_TRUST_PROXY was replaced by FK_TRUSTED_PROXY_HOPS, the number of proxies in front of this server (for example 1). It reads X-Forwarded-For from the right, so a client cannot choose its address.");
  const raw = env.FK_TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw === "") return 0;
  if (!/^\d{1,2}$/.test(raw)) throw new Error("FK_TRUSTED_PROXY_HOPS must be a whole number from 0 to 99.");
  return Number(raw);
}
