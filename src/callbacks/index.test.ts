import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeHarness, type TestHarness } from "../tools/test_helpers.js";
import { registerStrataCallbacks } from "./index.js";

describe("registerStrataCallbacks", () => {
  let h: TestHarness;
  beforeEach(() => {
    h = makeHarness({ sessionId: "s-reg" });
  });
  afterEach(async () => {
    await h.teardown();
  });

  it("registers exactly one Telegram interactive handler under the 'strata' namespace", () => {
    const registerInteractiveHandler = vi.fn();
    const fakeApi = {
      registerInteractiveHandler,
    } as unknown as Parameters<typeof registerStrataCallbacks>[0];
    const runtime = {
      rawEventsRepo: h.rawEventsRepo,
      pendingBuffer: h.pendingBuffer,
      logger: h.logger,
    } as unknown as Parameters<typeof registerStrataCallbacks>[1];

    registerStrataCallbacks(fakeApi, runtime);
    expect(registerInteractiveHandler).toHaveBeenCalledTimes(1);
    const call = registerInteractiveHandler.mock.calls[0]?.[0] as {
      channel: string;
      namespace: string;
      handler: unknown;
    };
    expect(call.channel).toBe("telegram");
    expect(call.namespace).toBe("strata");
    expect(typeof call.handler).toBe("function");
  });
});
