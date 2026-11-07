import { describe, expect, it } from "vitest";
import { createOtariClient } from "../../lib/otari/client";

describe.skipIf(process.env.OTARI_LIVE !== "1")("otari live", () => {
  it("answers one tiny chat and reports request id and cost", async () => {
    const client = createOtariClient({
      apiKey: process.env.OTARI_KEY_OPS ?? "",
      baseUrl: process.env.OTARI_BASE_URL,
    });
    const { meta } = await client.chat(
      { model: "openai/gpt-oss-20b", messages: [{ role: "user", content: "Say ok." }], max_tokens: 16 },
      { conversationId: "run-live-test", tags: { app: "porter", role: "livetest" } },
    );
    expect(meta.requestId).not.toBeNull();
    expect(meta.costUsd ?? 0).toBeGreaterThanOrEqual(0);
  });
});
