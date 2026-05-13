/**
 * Integration-test harness: boots Strata against a tmp HOME and a recording
 * `api`, then exposes typed lookup helpers so a test can replay lifecycle
 * events through the same handlers the SDK would invoke in production.
 *
 * See `openspec/changes/add-capture-integration-test/specs/capture-integration/spec.md`.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  OpenClawPluginApi,
  AnyAgentTool,
} from "openclaw/plugin-sdk/plugin-entry";

import strataPlugin from "../../src/index.js";
import {
  bootRuntime,
  resetRuntimeForTests,
  type StrataRuntime,
} from "../../src/runtime.js";

const INTEGRATION_SESSION_ID = "int-session";

interface InteractiveRegistration {
  channel: string;
  namespace: string;
  handler: (ctx: unknown) => Promise<unknown> | unknown;
}

export interface IntegrationHarness {
  runtime: StrataRuntime;
  api: OpenClawPluginApi;
  tmp: string;
  /** Look up a registered lifecycle hook handler. Throws on miss. */
  getHook(name: string): (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
  /** Look up a registered strata_* tool. Throws on miss. */
  getTool(name: string): AnyAgentTool;
  /** Look up a registered interactive handler by channel + namespace. */
  getInteractiveHandler(
    channel: string,
    namespace: string,
  ): InteractiveRegistration["handler"];
  /** Close DB, restore HOME, remove tmp dir. */
  teardown(): Promise<void>;
}

export async function bootStrataForIntegration(): Promise<IntegrationHarness> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "strata-integration-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmp;
  await resetRuntimeForTests(); // pristine cache for this boot

  // Recording stub api.
  const hookHandlers = new Map<
    string,
    (event: unknown, ctx: unknown) => Promise<unknown> | unknown
  >();
  const tools: AnyAgentTool[] = [];
  const interactiveHandlers: InteractiveRegistration[] = [];

  const stubLogger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  };

  const recordingApi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
    ) => {
      hookHandlers.set(name, handler);
    },
    registerTool: (
      toolOrFactory:
        | AnyAgentTool
        | ((ctx: { sessionId?: string }) => AnyAgentTool | AnyAgentTool[] | null | undefined),
    ) => {
      if (typeof toolOrFactory === "function") {
        const result = toolOrFactory({ sessionId: INTEGRATION_SESSION_ID });
        if (Array.isArray(result)) tools.push(...result);
        else if (result) tools.push(result);
      } else {
        tools.push(toolOrFactory);
      }
    },
    registerInteractiveHandler: (
      registration: InteractiveRegistration,
    ) => {
      interactiveHandlers.push(registration);
    },
    logger: stubLogger,
  } as unknown as OpenClawPluginApi;

  await strataPlugin.register(recordingApi);
  const runtime = await bootRuntime(recordingApi);

  return {
    runtime,
    api: recordingApi,
    tmp,
    getHook(name) {
      const handler = hookHandlers.get(name);
      if (!handler) throw new Error(`No handler registered for hook '${name}'`);
      return handler;
    },
    getTool(name) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`No tool registered with name '${name}'`);
      return tool;
    },
    getInteractiveHandler(channel, namespace) {
      const reg = interactiveHandlers.find(
        (r) => r.channel === channel && r.namespace === namespace,
      );
      if (!reg)
        throw new Error(
          `No interactive handler for channel='${channel}' namespace='${namespace}'`,
        );
      return reg.handler;
    },
    async teardown() {
      await resetRuntimeForTests();
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      await rm(tmp, { recursive: true, force: true });
    },
  };
}
