/**
 * Tab / window management tools.
 * Thin wrappers: validate input, enforce the destructive-action guard,
 * then forward to the extension over the bridge.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, requireConfirm, tabIdField } from "./helpers.js";

function text(t: string) {
  const res: { content: { type: "text"; text: string }[]; isError?: boolean } = {
    content: [{ type: "text" as const, text: t }],
  };
  if (t.startsWith("ERROR")) res.isError = true;
  return res;
}

const waitForLoadField = z
  .boolean()
  .optional()
  .describe("Wait for the page load to complete before returning (default true)");

const loadTimeoutField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max ms to wait for load (default 20000, max 60000)");

function loadTimeout(ms: number | undefined): number {
  return Math.min(Math.max(ms ?? 20000, 1000), 60000);
}

function refusal(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

const windowIdField = z.number().int().positive().describe("Firefox window id");
const confirmField = z
  .boolean()
  .optional()
  .describe("Pass true to confirm a destructive action (required unless the user turned the guard off)");

export function registerTabTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  server.registerTool(
    "tabs_list",
    {
      description: "List all open tabs (id, url, title, active/pinned/audible state).",
      inputSchema: {
        includeDiscarded: z.boolean().optional().describe("Include discarded (unloaded) tabs"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "tabs.list", { includeDiscarded: args.includeDiscarded })),
  );

  server.registerTool(
    "tabs_query",
    {
      description: "Find tabs by URL/title pattern and state flags.",
      inputSchema: {
        urlPattern: z.string().optional().describe("Substring or regex matched against tab URLs"),
        titlePattern: z.string().optional().describe("Substring or regex matched against tab titles"),
        audible: z.boolean().optional().describe("Only tabs currently producing sound"),
        pinned: z.boolean().optional().describe("Only pinned (or only unpinned) tabs"),
        active: z.boolean().optional().describe("Only the active tab(s)"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "tabs.query", {
          urlPattern: args.urlPattern,
          titlePattern: args.titlePattern,
          audible: args.audible,
          pinned: args.pinned,
          active: args.active,
        }),
      ),
  );

  server.registerTool(
    "active_tab",
    {
      description: "Get the currently active tab (id, url, title, window).",
      inputSchema: {},
    },
    async () => text(await callBridge(bridge, "active.tab")),
  );

  server.registerTool(
    "tab_create",
    {
      description: "Open a new tab, optionally with a URL. Waits for the page to load by default. Returns the new tab info.",
      inputSchema: {
        url: z.string().optional().describe("URL to open (defaults to new-tab page)"),
        active: z.boolean().optional().describe("Focus the new tab (default true)"),
        waitForLoad: waitForLoadField,
        timeoutMs: loadTimeoutField,
      },
    },
    async (args) => {
      const wait = args.url !== undefined && args.waitForLoad !== false;
      const t = loadTimeout(args.timeoutMs);
      return text(
        await callBridge(
          bridge,
          "tab.create",
          { url: args.url, active: args.active, waitForLoad: wait, timeoutMs: t },
          { timeoutMs: t + 10000 },
        ),
      );
    },
  );

  server.registerTool(
    "tab_navigate",
    {
      description:
        "Navigate a tab to a URL (defaults to the active tab). Waits for the page to load by default; " +
        "result.loadComplete=false means it timed out but navigation is still in progress.",
      inputSchema: {
        tabId: tabIdField,
        url: z.string().describe("URL to navigate to"),
        waitForLoad: waitForLoadField,
        timeoutMs: loadTimeoutField,
      },
    },
    async (args) => {
      const t = loadTimeout(args.timeoutMs);
      return text(
        await callBridge(
          bridge,
          "tab.update",
          { tabId: args.tabId, url: args.url, waitForLoad: args.waitForLoad !== false, timeoutMs: t },
          { timeoutMs: t + 10000 },
        ),
      );
    },
  );

  server.registerTool(
    "tab_close",
    {
      description: "Close one or more tabs. Destructive: needs confirm:true unless the guard is disabled.",
      inputSchema: {
        tabIds: z.array(z.number().int().positive()).min(1).describe("Tab ids to close"),
        confirm: confirmField,
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "tab_close");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "tab.close", { tabIds: args.tabIds }));
    },
  );

  server.registerTool(
    "tab_duplicate",
    {
      description: "Duplicate a tab (defaults to the active tab).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "tab.duplicate", { tabId: args.tabId })),
  );

  server.registerTool(
    "tab_move",
    {
      description: "Move a tab to a new index, optionally to another window.",
      inputSchema: {
        tabId: tabIdField,
        index: z.number().int().min(0).describe("Target 0-based index in the tab strip"),
        windowId: z.number().int().positive().optional().describe("Move to this window"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "tab.move", {
          tabId: args.tabId,
          index: args.index,
          windowId: args.windowId,
        }),
      ),
  );

  server.registerTool(
    "tab_pin",
    {
      description: "Pin a tab (defaults to the active tab).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "tab.pin", { tabId: args.tabId })),
  );

  server.registerTool(
    "tab_unpin",
    {
      description: "Unpin a tab (defaults to the active tab).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "tab.unpin", { tabId: args.tabId })),
  );

  server.registerTool(
    "tab_mute",
    {
      description: "Mute or unmute a tab (defaults to the active tab).",
      inputSchema: {
        tabId: tabIdField,
        muted: z.boolean().optional().describe("True to mute, false to unmute (default true)"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "tab.mute", { tabId: args.tabId, muted: args.muted ?? true }),
      ),
  );

  server.registerTool(
    "window_list",
    {
      description: "List open Firefox windows (id, focused, tab count).",
      inputSchema: {},
    },
    async () => text(await callBridge(bridge, "windows.list")),
  );

  server.registerTool(
    "window_create",
    {
      description: "Open a new window, optionally with a URL.",
      inputSchema: {
        url: z.string().optional().describe("URL to open in the new window"),
      },
    },
    async (args) => text(await callBridge(bridge, "window.create", { url: args.url })),
  );

  server.registerTool(
    "window_focus",
    {
      description: "Bring a window to the front.",
      inputSchema: { windowId: windowIdField },
    },
    async (args) => text(await callBridge(bridge, "window.focus", { windowId: args.windowId })),
  );

  server.registerTool(
    "window_close",
    {
      description: "Close a window and all its tabs. Destructive: needs confirm:true unless the guard is disabled.",
      inputSchema: {
        windowId: windowIdField,
        confirm: confirmField,
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "window_close");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "window.remove", { windowId: args.windowId }));
    },
  );

  server.registerTool(
    "nav_back",
    {
      description: "Go back in a tab's history (defaults to the active tab).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "nav.back", { tabId: args.tabId })),
  );

  server.registerTool(
    "nav_forward",
    {
      description: "Go forward in a tab's history (defaults to the active tab).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "nav.forward", { tabId: args.tabId })),
  );

  server.registerTool(
    "nav_reload",
    {
      description: "Reload a tab (defaults to the active tab).",
      inputSchema: {
        tabId: tabIdField,
        bypassCache: z.boolean().optional().describe("Hard reload, bypassing the cache"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "nav.reload", {
          tabId: args.tabId,
          bypassCache: args.bypassCache,
        }),
      ),
  );

  server.registerTool(
    "focus_tab",
    {
      description: "Activate (focus) a tab by id.",
      inputSchema: {
        tabId: z.number().int().positive().describe("Firefox tab id to activate"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "tab.update", { tabId: args.tabId, active: true })),
  );
}
