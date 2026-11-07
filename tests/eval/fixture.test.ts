import { describe, expect, it } from "vitest";
import { GET } from "../../app/fixtures/page/[id]/route";
import { loadAttacks } from "../../eval/corpus";

const get = (id: string) => GET(new Request(`http://x/fixtures/page/${id}`), { params: Promise.resolve({ id }) });

describe("fixture route", () => {
  it("serves each corpus page as markdown, uncached, byte for byte", async () => {
    const pages = loadAttacks().flatMap((c) => (c.page ? [c.page] : []));
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      const res = await get(p.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe(p.markdown);
    }
  });
  it("404s for any other id, including attack case ids without a page", async () => {
    for (const id of ["nope", "atk-a01", "..", "constructor", "__proto__"]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
});
