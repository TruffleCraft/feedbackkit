import { serve } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStorage } from "./server-storage.mjs";
import { app } from "../dist-server/app.mjs";
import { sweepExpiredAssets } from "../dist-server/r2.mjs";
import { pruneExpiredRecords } from "../dist-server/retention.mjs";
import { codeDeliveryCapability } from "./delivery-capability.mjs";

process.umask(0o077);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if ((process.env.ADMIN_TOKEN ?? "").length < 32) throw new Error("Set ADMIN_TOKEN to a random secret of at least 32 characters before starting.");
const origin = new URL(process.env.FK_PUBLIC_URL || "http://localhost:8787");
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error("FK_PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment.");
const storage = openStorage(join(process.env.FK_DATA_DIR || join(root, "data"), "feedbackkit.sqlite"), join(root, "migrations"));
// This server has one release and one database, unlike the shared Worker channels.
storage.sqlite.prepare("INSERT INTO meta (key,value) VALUES ('delivery_capability',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(codeDeliveryCapability()));
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
async function sweep() { await Promise.all([sweepExpiredAssets(env),pruneExpiredRecords(env)]); }
await sweep();
const timer = setInterval(()=>context.waitUntil(sweep()), 60 * 60 * 1000);
const server = serve({ hostname: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 8787), async fetch(request, bindings) {
  const url = new URL(request.url);
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
  // Canonical external origin makes same-origin write checks and snippets work
  // behind a TLS proxy. The proxy must forward Host, but its IP headers are
  // ignored unless the operator explicitly trusts that private proxy network.
  const target=new URL(url.pathname+url.search,origin);
  const headers=new Headers(request.headers);
  headers.delete('Cf-Access-Jwt-Assertion');
  headers.set('CF-Connecting-IP',process.env.FK_TRUST_PROXY==='true' ? (headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || bindings.incoming.socket.remoteAddress || 'unknown') : bindings.incoming.socket.remoteAddress || 'unknown');
  return app.fetch(new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half'}),env,context);
} }, () => console.log(`FeedbackKit listening on ${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 8787}; public URL ${origin.origin}`));
async function close() { clearInterval(timer);server.close(async()=>{await Promise.allSettled([...pending]);storage.close();process.exit(0)}); }
process.once('SIGTERM',close);process.once('SIGINT',close);
