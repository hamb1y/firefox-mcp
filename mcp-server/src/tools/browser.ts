/**
 * Browser-data tools: bookmarks, history, downloads, per-tab cookies,
 * and recently-closed session restore.
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

function refusal(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

export function registerBrowserTools(
  server: McpServer,
  bridge: ExtensionBridge,
  config: ServerConfig,
): void {
  server.registerTool(
    "bookmarks_search",
    {
      description: "Search bookmarks by title/URL query.",
      inputSchema: {
        query: z.string().describe("Search text matched against bookmark titles and URLs"),
      },
    },
    async (args) => text(await callBridge(bridge, "bookmarks.search", { query: args.query })),
  );

  server.registerTool(
    "bookmarks_create",
    {
      description: "Create a bookmark.",
      inputSchema: {
        title: z.string().describe("Bookmark title"),
        url: z.string().describe("Bookmark URL"),
        parentId: z.string().optional().describe("Parent folder id (defaults to bookmarks bar/other)"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "bookmarks.create", {
          title: args.title,
          url: args.url,
          parentId: args.parentId,
        }),
      ),
  );

  server.registerTool(
    "bookmarks_remove",
    {
      description: "Delete a bookmark by id. Destructive: needs confirm:true unless the guard is disabled.",
      inputSchema: {
        id: z.string().describe("Bookmark id to delete"),
        confirm: z.boolean().optional().describe("Pass true to confirm"),
      },
    },
    async (args) => {
      const denied = requireConfirm(config, args.confirm, "bookmarks_remove");
      if (denied) return refusal(denied);
      return text(await callBridge(bridge, "bookmarks.remove", { id: args.id }));
    },
  );

  server.registerTool(
    "history_search",
    {
      description: "Search browsing history.",
      inputSchema: {
        query: z.string().describe("Search text matched against history titles and URLs"),
        maxResults: z.number().int().positive().optional().describe("Max results (default 20)"),
        startTime: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only entries visited after this ms-epoch timestamp"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "history.search", {
          query: args.query,
          maxResults: args.maxResults ?? 20,
          startTime: args.startTime,
        }),
      ),
  );

  server.registerTool(
    "downloads_list",
    {
      description: "List recent downloads (filename, state, progress).",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max entries (default 20)"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "downloads.list", { limit: args.limit ?? 20 })),
  );

  server.registerTool(
    "cookies_for_tab",
    {
      description: "Read cookies visible to a tab's page (read-only; no modification).",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "cookies.forTab", { tabId: args.tabId })),
  );

  server.registerTool(
    "sessions_recently_closed",
    {
      description: "List recently closed tabs/windows available for restore.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Max entries (default 10)"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "sessions.recentlyClosed", { limit: args.limit ?? 10 })),
  );

  server.registerTool(
    "sessions_restore",
    {
      description: "Restore a recently closed tab/window by session id.",
      inputSchema: {
        sessionId: z.string().describe("Session id from sessions_recently_closed"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "sessions.restore", { sessionId: args.sessionId })),
  );
}
