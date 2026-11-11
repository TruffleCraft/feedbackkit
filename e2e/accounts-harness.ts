import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared by the Gate 2 specs that run against the real standalone server: a child
// process runs scripts/server.mjs on a fresh data directory, the host command
// prints the links, and Chromium's WebAuthn virtual authenticator (Chrome
// DevTools protocol) does the passkey ceremonies.

export interface Server {
  origin: string;
  dir: string;
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
  host: (...args: string[]) => string;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

export async function startServer(extra: Record<string, string> = {}): Promise<Server> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "fk-e2e-accounts-"));
  const origin = `http://localhost:${port}`;
  const env = { PATH: process.env["PATH"] ?? "", HOME: dir, HOST: "127.0.0.1", PORT: String(port), FK_PUBLIC_URL: origin, FK_DATA_DIR: dir, FK_ENV_FILE: "/nonexistent", ...extra };
  const child = spawn(process.execPath, ["scripts/server.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`${origin}/diag`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    origin,
    dir,
    child,
    output: () => out,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
    host: (...args) => {
      const r = spawnSync(process.execPath, ["scripts/server.mjs", "admin", ...args], { env, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`feedbackkit-admin ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    },
  };
}

export const tokenOf = (url: string) => new URL(url).hash.slice(1);

export interface Device {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  authenticatorId: string;
}

const AUTHENTICATOR = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } as const;

/** A browser context with a virtual authenticator that behaves like a platform passkey with user verification. */
export async function newDevice(browser: Browser, options: BrowserContextOptions = {}): Promise<Device> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR });
  return { context, page, cdp, authenticatorId };
}

/** Swaps the device's authenticator for a new one: the old device is gone, and a passkey can be created on the new one. */
export async function replaceAuthenticator(device: Device): Promise<void> {
  await device.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: device.authenticatorId });
  device.authenticatorId = (await device.cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTHENTICATOR })).authenticatorId;
}

/** Copies every passkey from one device to another, so that a second browser can sign in as the same person. */
export async function copyPasskeys(from: Device, to: Device): Promise<void> {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", { authenticatorId: from.authenticatorId });
  for (const credential of credentials) await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.authenticatorId, credential });
}

/**
 * Makes `to` hold exactly the passkeys of `from`, with their current sign counters. A device that signed in moves the
 * server's counter on, and the server refuses a counter that goes backwards (a cloned authenticator), so a device that
 * did not take part needs the newer copy before it signs in again, as a synced passkey would.
 */
export async function syncPasskeys(from: Device, to: Device): Promise<void> {
  await to.cdp.send("WebAuthn.clearCredentials", { authenticatorId: to.authenticatorId });
  await copyPasskeys(from, to);
}

/** One API call from inside the page, so that the session cookie goes along. */
export const api = (page: Page, method: string, path: string, csrf?: string, body?: unknown) =>
  page.evaluate(
    async ({ method, path, csrf, body }) => {
      const res = await fetch(path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { method, path, csrf, body },
  );
