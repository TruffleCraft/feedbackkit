#!/usr/bin/env node
// Post-release check: the gateway at <url> answers /diag with the expected
// version and channel, and serves the widget. Retries while the new version
// propagates. Usage: node scripts/smoke-check.mjs <url> <version> <channel>
const [url, version, channel] = process.argv.slice(2);
if (!url || !version || !channel) {
  console.error("usage: smoke-check.mjs <url> <version> <channel>");
  process.exit(2);
}
const base = url.replace(/\/$/, "");
let last = "";
for (let i = 0; i < 12; i++) {
  try {
    const diag = await (await fetch(`${base}/diag`, { headers: { "cache-control": "no-cache" } })).json();
    const widget = await fetch(`${base}/widget.js`);
    if (diag.version === version && diag.channel === channel && widget.ok) {
      console.log(`smoke-check: ${base} serves ${channel} ${version}, schema ok=${diag.schema?.ok}`);
      process.exit(diag.schema?.ok === false ? 1 : 0);
    }
    last = `got ${diag.channel} ${diag.version}, widget ${widget.status}`;
  } catch (e) {
    last = e.message;
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error(`smoke-check: ${base} did not reach ${channel} ${version} (${last})`);
process.exit(1);
