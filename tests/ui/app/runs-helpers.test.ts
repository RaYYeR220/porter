import { describe, expect, it } from "vitest";
import { watchFrom } from "../../../app/try/watch";
import { noticeFor } from "../../../components/app/api";
import { authorName } from "../../../components/app/format";
import { isTierDown, matchesFilter } from "../../../components/app/runs";
import { RUN_ID } from "./fixtures";

describe("run helpers", () => {
  it("spots the tier-down model however the gateway prefixes it", () => {
    expect(isTierDown("openai/gpt-oss-20b")).toBe(true);
    expect(isTierDown("gpt-oss-20b")).toBe(true);
    expect(isTierDown("openai/gpt-oss-120b")).toBe(false);
    expect(isTierDown(null)).toBe(false);
  });

  it("groups statuses into the console filters", () => {
    const f = (status: string) => ["answered", "held", "refused", "failed"].filter((x) => matchesFilter({ status }, x as never));
    expect(f("answered")).toEqual(["answered"]);
    expect(f("held_guardrail")).toEqual(["held"]);
    expect(f("refused_budget")).toEqual(["refused"]);
    expect(f("blocked_author")).toEqual(["refused"]);
    expect(f("refused_funds")).toEqual(["refused"]);
    expect(f("failed")).toEqual(["failed"]);
    expect(f("running")).toEqual([]);
    expect(matchesFilter({ status: "running" }, "all")).toBe(true);
  });

  it("names authors the way the server does", () => {
    expect(authorName("gh:octocat")).toBe("octocat");
    expect(authorName("web:5eed000000000001")).toBe("visitor 5eed…");
    expect(authorName("eval:inj-03")).toBe("eval:inj-03");
    expect(authorName(null)).toBe("—");
  });

  it("reopens a watched run or wave from the address bar and ignores anything else", () => {
    expect(watchFrom({ run: RUN_ID.toUpperCase() })).toEqual({ kind: "run", id: RUN_ID });
    expect(watchFrom({ wave: `${RUN_ID},nope,${RUN_ID}` })).toEqual({ kind: "wave", ids: [RUN_ID] });
    expect(watchFrom({ run: "../../etc" })).toBeNull();
    expect(watchFrom({})).toBeNull();
  });

  it("turns API failures into calm copy, never a raw error", () => {
    expect(noticeFor({ ok: false, status: 503, error: "paused", reason: "funds_low" }, "try").title).toBe("Paused while the balance is low");
    expect(noticeFor({ ok: false, status: 503, error: "unavailable", reason: "The demo repository is not configured yet." }, "try").body).toBe(
      "The demo repository is not configured yet. The console still shows past runs.",
    );
    expect(noticeFor({ ok: false, status: 429, error: "rate_limited", reason: null }, "try").title).toBe("That’s the limit for this hour");
    expect(noticeFor({ ok: false, status: 400, error: "invalid_request", reason: "title must be 1-200 characters" }, "try").body).toBe(
      "Title must be 1-200 characters.",
    );
    const internal = noticeFor({ ok: false, status: 500, error: "internal", reason: null }, "author");
    expect(`${internal.title} ${internal.body}`).not.toMatch(/internal|500|error/i);
  });
});
