/**
 * Tool aggregation: wires every tool group onto the McpServer, plus the two
 * meta tools owned here (extension_status, wait_for_tab_event).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeEvent } from "@webmcp-controller/shared";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, fmt, tabIdField, toBridgeError } from "./helpers.js";
import { registerTabTools } from "./tabs.js";
import { registerUnderstandTools } from "./understand.js";
import { registerActTools } from "./act.js";
import { registerBrowserTools } from "./browser.js";
import { withThought } from "../bridge/thought.js";

/** Tools that don't touch a page, so a thought has nowhere to show. */
const NO_THOUGHT = new Set(["extension_status", "wait_for_tab_event", "cursor_note"]);

const thoughtField = z
  .string()
  .max(300)
  .optional()
  .describe(
    "Optional: a short first-person note on what you're doing and why (e.g. \"Opening the pricing page to compare plans\"). " +
      "Shown to the user next to the AI cursor in Firefox.",
  );

export const SERVER_INSTRUCTIONS =
  "Controls the user's real Firefox. The user watches an AI cursor move to whatever you act on. " +
  "Pass a short `thought` with each call saying what you're doing, so they can follow along. " +
  "Prefer snapshot_ax refs over CSS selectors when acting on a page.";

/**
 * Give every page-touching tool an optional `thought` and run its handler with
 * that thought in scope, so the bridge forwards it to the extension.
 */
function addThoughts(server: McpServer): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = server.registerTool.bind(server) as (name: string, config: any, cb: any) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, cb: any) => {
    if (NO_THOUGHT.has(name) || !config?.inputSchema || typeof config.inputSchema !== "object") {
      return register(name, config, cb);
    }
    return register(
      name,
      { ...config, inputSchema: { ...config.inputSchema, thought: thoughtField } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any, extra: unknown) => {
        const { thought, ...rest } = args ?? {};
        return withThought(typeof thought === "string" ? thought.trim() : undefined, () => cb(rest, extra));
      },
    );
  };
}

export function registerFirefoxTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  addThoughts(server);
  registerTabTools(server, bridge, config);
  registerUnderstandTools(server, bridge, config);
  registerActTools(server, bridge, config);
  registerBrowserTools(server, bridge, config);

  server.registerTool(
    "extension_status",
    {
      description:
        "Check whether the Firefox WebExtension bridge is connected, plus extension/profile details.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: fmt({ connected: bridge.connected, extension: bridge.extensionInfo }),
        },
      ],
    }),
  );

  server.registerTool(
    "cursor_note",
    {
      description:
        "Show a short note to the user beside the AI cursor in Firefox, without doing anything else. " +
        "Use it to narrate a plan or explain a pause (e.g. while thinking about what to do next). " +
        "Does nothing if the user turned the cursor off.",
      inputSchema: {
        note: z.string().min(1).max(300).describe("What to show, first person, one short sentence"),
        tabId: tabIdField,
      },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: await callBridge(bridge, "cursor.say", { note: args.note, tabId: args.tabId }) }],
    }),
  );

  server.registerTool(
    "wait_for_tab_event",
    {
      description:
        "Wait for an extension-pushed event (tab updated/removed/activated, download done), optionally filtered to one tab.",
      inputSchema: {
        types: z
          .array(z.enum(["tab.updated", "tab.removed", "tab.activated", "download.done"]))
          .min(1)
          .describe("Event types to wait for"),
        tabId: tabIdField,
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(120000)
          .optional()
          .describe("How long to wait in ms (default 15000, max 120000)"),
      },
    },
    async (args) => {
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 15000, 1000), 120000);
      const predicate = (e: BridgeEvent): boolean =>
        args.tabId === undefined || e.data["tabId"] === args.tabId;
      try {
        const evt = await bridge.waitForEvent(args.types, predicate, timeoutMs);
        return { content: [{ type: "text" as const, text: fmt(evt) }] };
      } catch (e) {
        const { code, message } = toBridgeError(e);
        return {
          content: [{ type: "text" as const, text: `ERROR [${code}]: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
