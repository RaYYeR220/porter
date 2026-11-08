import { describe, expect, it } from "vitest";
import { databaseHost, writeConsent } from "../../scripts/ui-demo-core";

const URL_ = "postgresql://user:pw@ep-quiet-sea-123456-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const HOST = "ep-quiet-sea-123456-pooler.eu-central-1.aws.neon.tech";

describe("seed and cleanup write consent", () => {
  it("reads the host from DATABASE_URL", () => {
    expect(databaseHost(URL_)).toBe(HOST);
    expect(databaseHost(undefined)).toBeNull();
    expect(databaseHost("not a url")).toBeNull();
  });

  it("runs only when the caller names the same host", () => {
    expect(writeConsent(["--yes-write-to", HOST], URL_)).toEqual({ ok: true, host: HOST });
    expect(writeConsent(["--yes-write-to", HOST.toUpperCase()], URL_)).toEqual({ ok: true, host: HOST });
  });

  it("refuses without the flag, with another host, with an empty value or without DATABASE_URL", () => {
    const none = writeConsent([], URL_);
    expect(none).toMatchObject({ ok: false, host: HOST });
    expect(!none.ok && none.reason).toBe(`refusing to write: pass --yes-write-to ${HOST} to confirm the target`);
    expect(writeConsent(["--yes-write-to", "localhost"], URL_)).toMatchObject({ ok: false, host: HOST });
    expect(writeConsent(["--yes-write-to"], URL_)).toMatchObject({ ok: false });
    expect(writeConsent(["--yes-write-to", "--other"], URL_)).toMatchObject({ ok: false });
    expect(writeConsent(["--yes-write-to", HOST], undefined)).toMatchObject({ ok: false, host: null });
  });
});
