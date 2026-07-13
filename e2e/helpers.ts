import type { Page } from "@playwright/test";

// Public config the mocked gateway returns (a bug template with two required fields).
export const CONFIG = {
  v: 1,
  enabled: true,
  locale: "en",
  askType: false,
  configVersion: 1,
  types: [
    {
      type: "bug",
      label: "Bug",
      fields: [
        { key: "repro", label: "Steps", kind: "longtext", required: true },
        { key: "expected", label: "Expected", kind: "longtext", required: true },
      ],
    },
  ],
};

type Res = Record<string, unknown>;

// Intercept every gateway call the widget makes; POST-2 is detected by the
// presence of `fields` in the body (matches the server's own POST-1/POST-2 split).
export async function installMocks(page: Page, opts: { config?: Res; post1: Res; post2?: Res }) {
  const config = opts.config ?? CONFIG;
  await page.route("**/api/config**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(config) }));
  await page.route("**/api/upload**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ v: 1, key: "fk_test/shot.webp" }) }));
  await page.route("**/api/events**", (r) => r.fulfill({ status: 204, body: "" }));
  await page.route("**/api/feedback**", (r) => {
    let body: Record<string, unknown> = {};
    try {
      body = r.request().postDataJSON() as Record<string, unknown>;
    } catch {
      /* no body */
    }
    const isPost2 = body && typeof body === "object" && body["fields"] !== undefined;
    const res = isPost2 ? (opts.post2 ?? { v: 1, status: "created", id: "2", issueUrl: "https://github.com/acme/site/issues/2" }) : opts.post1;
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
  });
}
