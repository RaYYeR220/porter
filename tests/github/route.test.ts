import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maxDuration, POST } from "../../app/api/github/webhook/route";

const SECRET = "route-secret";
const sign = (b: string) => `sha256=${createHmac("sha256", SECRET).update(b).digest("hex")}`;
const req = (body: string, headers: Record<string, string>) =>
  new Request("http://localhost/api/github/webhook", { method: "POST", body, headers });

describe("webhook route", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    process.env.GITHUB_APP_SLUG = "porter-front-desk";
  });
  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_APP_SLUG;
  });

  it("runs up to five minutes", () => {
    expect(maxDuration).toBe(300);
  });

  it("401 on a bad signature", async () => {
    const res = await POST(req("{}", { "x-hub-signature-256": "sha256=00", "x-github-event": "issues", "x-github-delivery": "d" }));
    expect(res.status).toBe(401);
  });

  it("401 when the body was altered after signing", async () => {
    const res = await POST(req('{"a":2}', { "x-hub-signature-256": sign('{"a":1}'), "x-github-event": "issues", "x-github-delivery": "d" }));
    expect(res.status).toBe(401);
  });

  it("answers a signed ping without touching storage", async () => {
    const body = '{"zen":"hi"}';
    const res = await POST(req(body, { "x-hub-signature-256": sign(body), "x-github-event": "ping", "x-github-delivery": "d" }));
    expect(res.status).toBe(200);
  });

  it("400 on a signed delivery without an id", async () => {
    const body = "{}";
    const res = await POST(req(body, { "x-hub-signature-256": sign(body), "x-github-event": "issues" }));
    expect(res.status).toBe(400);
  });
});
