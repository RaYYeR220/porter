import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { routeEvent, verifySignature } from "../../lib/github/webhook";
import type { RouteDeps } from "../../lib/github/webhook";
import { REPO, SLUG, botUser, issueComment, issuesOpened, user } from "../fixtures/github/payloads";

const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
  const seen = new Set<string>();
  return {
    slug: SLUG,
    claimDelivery: async (id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    isDemoRepo: async (repo) => repo === REPO,
    ...over,
  };
}

describe("verifySignature", () => {
  const body = JSON.stringify(issuesOpened());
  it("accepts a valid HMAC", async () => {
    expect(await verifySignature(body, sign(body, "s3cret"), "s3cret")).toBe(true);
  });
  it("rejects a tampered body", async () => {
    expect(await verifySignature(body + " ", sign(body, "s3cret"), "s3cret")).toBe(false);
  });
  it("rejects a wrong secret, a missing header and garbage", async () => {
    expect(await verifySignature(body, sign(body, "other"), "s3cret")).toBe(false);
    expect(await verifySignature(body, null, "s3cret")).toBe(false);
    expect(await verifySignature(body, "sha256=zz", "s3cret")).toBe(false);
  });
});

describe("routeEvent", () => {
  it("issues.opened runs", async () => {
    const r = await routeEvent("issues", "d1", issuesOpened(), deps());
    expect(r.action).toBe("run");
    expect(r.job).toMatchObject({
      kind: "run",
      input: { source: "github", arm: "porter", repo: REPO, number: 12, authorExternalId: "gh:alice", deliveryId: "d1" },
    });
  });

  it("a redelivered delivery id is ignored the second time", async () => {
    const d = deps();
    expect((await routeEvent("issues", "d1", issuesOpened(), d)).action).toBe("run");
    const again = await routeEvent("issues", "d1", issuesOpened(), d);
    expect(again).toMatchObject({ action: "ignore", reason: "duplicate_delivery" });
  });

  it("issues.edited and other actions are ignored", async () => {
    const r = await routeEvent("issues", "d2", { ...issuesOpened(), action: "edited" }, deps());
    expect(r.action).toBe("ignore");
  });

  it("an issue opened by a bot is ignored", async () => {
    const r = await routeEvent("issues", "d3", issuesOpened({ author: botUser("dependabot[bot]") }), deps());
    expect(r).toMatchObject({ action: "ignore", reason: "bot_author" });
  });

  it("Porter's own comment is ignored, even when it mentions itself", async () => {
    const p = issueComment({ body: `thanks @${SLUG}`, commenter: botUser() });
    expect(await routeEvent("issue_comment", "d4", p, deps())).toMatchObject({ action: "ignore", reason: "bot_author" });
  });

  it("a bot-typed account with another login is ignored too", async () => {
    const p = issueComment({ body: `@${SLUG} hi`, commenter: botUser("some-app[bot]") });
    expect((await routeEvent("issue_comment", "d4b", p, deps())).action).toBe("ignore");
  });

  it("a human mention is a follow-up run with the comment as body and the issue title", async () => {
    const p = issueComment({ body: `@${SLUG} can you check the docs?`, commenter: user("carol"), title: "Docs question" });
    const r = await routeEvent("issue_comment", "d5", p, deps());
    expect(r.action).toBe("run");
    expect(r.job).toMatchObject({
      kind: "run",
      input: { arm: "porter", title: "Docs question", body: `@${SLUG} can you check the docs?`, authorExternalId: "gh:carol", number: 12 },
    });
  });

  it("the run's end-user id is lower-cased, matching /porter block", async () => {
    const r = await routeEvent("issues", "dc", issuesOpened({ author: user("Mallory") }), deps());
    expect(r.job).toMatchObject({ input: { authorExternalId: "gh:mallory" } });
  });

  it("a mention of a different app is not a mention", async () => {
    const p = issueComment({ body: `@${SLUG}-other hi` });
    expect((await routeEvent("issue_comment", "d6", p, deps())).action).toBe("ignore");
  });

  it("/porter approve from CONTRIBUTOR is ignored, from OWNER it is a command", async () => {
    const asContributor = issueComment({ body: "/porter approve 12", association: "CONTRIBUTOR" });
    expect(await routeEvent("issue_comment", "d7", asContributor, deps())).toMatchObject({ action: "ignore" });
    const asOwner = issueComment({ body: "/porter approve 12", association: "OWNER" });
    const r = await routeEvent("issue_comment", "d8", asOwner, deps());
    expect(r.action).toBe("command");
    expect(r.job).toMatchObject({ kind: "command", repo: REPO, issueNumber: 12, actor: "bob", command: { cmd: "approve", arg: "12" } });
  });

  it("MEMBER and COLLABORATOR may command", async () => {
    for (const [i, a] of ["MEMBER", "COLLABORATOR"].entries()) {
      const r = await routeEvent("issue_comment", `dm${i}`, issueComment({ body: "/porter block @mallory", association: a }), deps());
      expect(r.action).toBe("command");
    }
  });

  it("an unparseable /porter from an owner is ignored with a reason", async () => {
    const r = await routeEvent("issue_comment", "d9", issueComment({ body: "/porter dance", association: "OWNER" }), deps());
    expect(r).toMatchObject({ action: "ignore", reason: "unknown_command" });
  });

  it("comments on pull requests, plain comments and other events are ignored", async () => {
    expect((await routeEvent("issue_comment", "d10", issueComment({ body: `@${SLUG}`, pullRequest: true }), deps())).action).toBe("ignore");
    expect((await routeEvent("issue_comment", "d11", issueComment({ body: "just chatting" }), deps())).action).toBe("ignore");
    expect((await routeEvent("push", "d12", {}, deps())).action).toBe("ignore");
  });

  it("repos that are not the demo repo with an installation are ignored", async () => {
    const r = await routeEvent("issues", "d13", issuesOpened({ repo: "someone/else" }), deps());
    expect(r).toMatchObject({ action: "ignore", reason: "unknown_repo" });
  });

  it("malformed payloads are ignored, not thrown", async () => {
    expect((await routeEvent("issues", "d14", null, deps())).action).toBe("ignore");
    expect((await routeEvent("issues", "d15", { action: "opened" }, deps())).action).toBe("ignore");
  });
});
