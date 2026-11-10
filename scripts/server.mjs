import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStorage } from "./server-storage.mjs";
import { app } from "../dist-server/app.mjs";
import { sweepExpiredAssets } from "../dist-server/r2.mjs";
import { pruneExpiredRecords } from "../dist-server/retention.mjs";
import { codeDeliveryCapability } from "./delivery-capability.mjs";
import { canonicalUrl, clientAddress, readTrustedHops } from "./server-http.mjs";

process.umask(0o077);
const trustedHops = readTrustedHops(process.env);
let warnedForwarded = false;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if ((process.env.ADMIN_TOKEN ?? "").length < 32) throw new Error("Set ADMIN_TOKEN to a random secret of at least 32 characters before starting.");
const origin = new URL(process.env.FK_PUBLIC_URL || "http://localhost:8787");
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error("FK_PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment.");
const storage = openStorage(join(process.env.FK_DATA_DIR || join(root, "data"), "feedbackkit.sqlite"), join(root, "migrations"));
// The capability only ever rises. A database that a newer release raised past
// this release holds settings this release cannot honor, and serving them could
// send a report to a public issue that a newer release would have kept private.
const supported = codeDeliveryCapability();
const recorded = Number(storage.sqlite.prepare("SELECT value FROM meta WHERE key='delivery_capability'").get()?.value ?? 0);
if (recorded > supported) throw new Error(`This database needs delivery capability ${recorded} and this release provides ${supported}. Start the newer release again, or restore the backup taken before the update.`);
storage.sqlite.prepare("INSERT INTO meta (key,value) VALUES ('delivery_capability',?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(meta.value AS INTEGER),CAST(excluded.value AS INTEGER))").run(String(supported));
const files = new Map([
  ["/widget.js", ["widget.js", "application/javascript; charset=utf-8"]],
  ["/admin.js", ["admin.js", "application/javascript; charset=utf-8"]],
  ["/urbanist.woff2", ["urbanist.woff2", "font/woff2"]],
]);
async function asset(path) {
  const file = files.get(path);
  if (!file) return new Response("Not found", { status: 404 });
  try {
    const data = await readFile(join(root,"dist",file[0]));
    return new Response(data, { headers: { "Content-Type": file[1], "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
  } catch { return new Response("Assets not built", { status: 503 }); }
}
const env = { ...process.env, DB: storage.DB, UPLOADS: storage.UPLOADS, ASSETS: { fetch: (r) => asset(new URL(typeof r === 'string' ? r : r.url).pathname) }, FK_ENV: "production", FK_CHANNEL: "local", WIDGET_VERSION: (await readFile(join(root,"dist/widget.ver"),"utf8")).trim() };
// Cloudflare Access and OAuth are deployment-specific; never trust headers or
// bind accidental process-environment strings as runtime objects.
delete env.OAUTH_KV; delete env.OAUTH_PROVIDER; delete env.FK_ACCESS_TEAM_DOMAIN; delete env.FK_ACCESS_AUD;
const pending = new Set();
const context = { waitUntil(p) { const task=Promise.resolve(p).catch((e)=>console.error("Background task failed:",e.message));pending.add(task);task.finally(()=>pending.delete(task)); }, passThroughOnException() {} };
async function sweep() { await Promise.all([sweepExpiredAssets(env),pruneExpiredRecords(env)]); storage.compact(); }
// A failing sweep is logged and retried every hour; it never keeps the service from starting.
await sweep().catch((e)=>console.error("Start sweep failed:",e.message));
const timer = setInterval(()=>context.waitUntil(sweep()), 60 * 60 * 1000);
const server = serve({ hostname: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 8787), async fetch(request, bindings) {
  const url = new URL(request.url);
  const target = canonicalUrl(origin, url.pathname, url.search);
  if (!target) return new Response("Invalid path", { status: 400 });
  if (files.has(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
    const response=await asset(url.pathname);return request.method === "HEAD" ? new Response(null,response) : response;
  }
  if (/^\/(mcp(?:\/|$)|oauth\/|\.well-known\/oauth-)/.test(url.pathname)) return Response.json({error:"not_supported",error_description:"OAuth/MCP is currently available on the Cloudflare installation. The standalone server supports the widget, admin UI and feedback delivery."},{status:404});
  if (url.pathname.startsWith('/attachments/') && request.method==='GET') {
    let key;try{key=decodeURIComponent(url.pathname.slice('/attachments/'.length))}catch{return new Response('Invalid key',{status:400})}
    // Only issue attachments are public. Inbox and Project screenshots stay
    // behind /admin/assets; knowledge of a storage key is not authorization.
    const known=storage.sqlite.prepare("SELECT a.key FROM assets a JOIN feedback f ON f.project_id=a.project_id AND f.client_feedback_id=a.feedback_id WHERE a.key=? AND a.deleted=0 AND f.delivery='issue' LIMIT 1").get(key);
    const obj=known?await storage.UPLOADS.get(key):null;
    return obj?new Response(obj.body,{headers:{"Content-Type":obj.httpMetadata.contentType||'application/octet-stream',"Cache-Control":"public, max-age=300","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"}}):new Response('Not found',{status:404});
  }
  // The canonical external origin makes same-origin write checks and snippets
  // work behind a TLS proxy, whatever Host the proxy sends. The client address
  // comes from the socket, or from X-Forwarded-For read from the right through
  // the configured number of trusted proxies.
  const headers=new Headers(request.headers);
  headers.delete('Cf-Access-Jwt-Assertion');
  const forwardedFor=headers.get('X-Forwarded-For');
  if (forwardedFor && trustedHops===0 && !warnedForwarded) { warnedForwarded=true; console.warn("X-Forwarded-For arrived but FK_TRUSTED_PROXY_HOPS is 0, so every client behind the proxy shares one address and one failed-login limit. Set FK_TRUSTED_PROXY_HOPS to the number of proxies in front of this server."); }
  headers.set('CF-Connecting-IP',clientAddress({forwardedFor,peer:bindings.incoming.socket.remoteAddress,hops:trustedHops}));
  return app.fetch(new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half'}),env,context);
} }, () => console.log(`FeedbackKit listening on ${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 8787}; public URL ${origin.origin}`));
async function close() { clearInterval(timer);server.close(async()=>{await Promise.allSettled([...pending]);storage.close();process.exit(0)}); }
process.once('SIGTERM',close);process.once('SIGINT',close);
