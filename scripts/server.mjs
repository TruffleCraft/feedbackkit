import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openStorage } from "./server-storage.mjs";
import { OAUTH_PATH_RE, app, createMcpFetch } from "../dist-server/app.mjs";
import { sweepExpiredAssets } from "../dist-server/r2.mjs";
import { pruneExpiredRecords } from "../dist-server/retention.mjs";
import { codeDeliveryCapability } from "./code-capability.mjs";
import { canonicalUrl, clientAddress, readTrustedHops } from "./server-http.mjs";
import { appEnvironment } from "./server-env.mjs";
import { createUpdateCheck, readSwitch } from "./server-update-check.mjs";
import { createKv } from "./server-kv.mjs";
import { MCP_OFF_BODY, planMcp } from "./server-mcp.mjs";

process.umask(0o077);
const trustedHops = readTrustedHops(process.env);
let warnedForwarded = false;
// Two layouts. A release tarball puts this file next to bundle.json (release,
// channel, schema, capability), the assets and the migrations. A checkout runs it
// from scripts/ and reads the capability from the source.
const here = dirname(fileURLToPath(import.meta.url));
const bundle = (() => { try { return JSON.parse(readFileSync(join(here, "bundle.json"), "utf8")); } catch { return null; } })();
const root = bundle ? here : join(here, "..");
if ((process.env.ADMIN_TOKEN ?? "").length < 32) throw new Error("Set ADMIN_TOKEN to a random secret of at least 32 characters before starting.");
const origin = new URL(process.env.FK_PUBLIC_URL || "http://localhost:8787");
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error("FK_PUBLIC_URL must be an http(s) origin, without credentials, path, query or fragment.");
// MCP (ADR-015): decided before anything is opened, so an unsafe combination stops the start.
const mcp = planMcp({ origin, setting: process.env.FK_MCP, host: process.env.HOST || "127.0.0.1" });
const storage = openStorage(join(process.env.FK_DATA_DIR || join(root, "data"), "feedbackkit.sqlite"), join(root, "migrations"));
// The capability only ever rises. A database that a newer release raised past
// this release holds settings this release cannot honor, and serving them could
// send a report to a public issue that a newer release would have kept private.
const supported = bundle ? bundle.deliveryCapability : codeDeliveryCapability();
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
// The admin notice for a newer release exists on tarball installs only (a bundle.json next to this
// file), and FK_UPDATE_CHECK=off removes it. The browser never calls GitHub; the gateway does.
const updateCheckOn = readSwitch(process.env.FK_UPDATE_CHECK);
const updateCheck = bundle && updateCheckOn ? createUpdateCheck({ release: bundle.release, channel: bundle.channel, api: process.env.FK_UPDATE_API }) : null;
const env = { ...appEnvironment(process.env), ...(updateCheck ? { UPDATE_CHECK: updateCheck } : {}), DB: storage.DB, UPLOADS: storage.UPLOADS, ASSETS: { fetch: (r) => asset(new URL(typeof r === 'string' ? r : r.url).pathname) }, FK_ENV: "production", FK_CHANNEL: bundle?.channel ?? "local", ...(bundle ? { FK_RELEASE: bundle.release } : {}), WIDGET_VERSION: (await readFile(join(root,"dist/widget.ver"),"utf8")).trim() };
// Cloudflare Access is deployment-specific; never trust its headers or bind accidental
// process-environment strings as runtime objects. OAUTH_KV is the one binding the
// server sets itself: the OAuth provider's storage, in the same SQLite file. The table
// is made and swept even with MCP off, so grants from an earlier run expire either way.
delete env.OAUTH_KV; delete env.OAUTH_PROVIDER; delete env.FK_ACCESS_TEAM_DOMAIN; delete env.FK_ACCESS_AUD;
const kv = createKv(storage.sqlite);
const mcpFetch = mcp.enabled ? createMcpFetch(origin.origin) : null;
if (mcpFetch) env.OAUTH_KV = kv;
const pending = new Set();
const context = { waitUntil(p) { const task=Promise.resolve(p).catch((e)=>console.error("Background task failed:",e.message));pending.add(task);task.finally(()=>pending.delete(task)); }, passThroughOnException() {} };
async function sweep() { await Promise.all([sweepExpiredAssets(env),pruneExpiredRecords(env)]); kv.sweepExpired(); storage.compact(); }
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
  const oauthPath = OAUTH_PATH_RE.test(url.pathname);
  if (oauthPath && !mcpFetch) return Response.json(MCP_OFF_BODY,{status:404,headers:{'Cache-Control':'no-store'}});
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
  const forwarded=new Request(target,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,duplex:'half'});
  return oauthPath?mcpFetch(forwarded,env,context):app.fetch(forwarded,env,context);
} }, () => console.log(`FeedbackKit listening on ${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 8787}; public URL ${origin.origin}; MCP ${mcp.note}`));
async function close() { clearInterval(timer);server.close(async()=>{await Promise.allSettled([...pending]);storage.close();process.exit(0)}); }
process.once('SIGTERM',close);process.once('SIGINT',close);
