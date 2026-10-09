/**
 * Page-understanding tools: accessibility snapshot, text/HTML extraction,
 * screenshots, and basic page metadata.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExtensionBridge } from "../bridge/bridge.js";
import type { ServerConfig } from "../config.js";
import { callBridge, fmt, tabIdField, toBridgeError } from "./helpers.js";

function text(t: string) {
  const res: { content: { type: "text"; text: string }[]; isError?: boolean } = {
    content: [{ type: "text" as const, text: t }],
  };
  if (t.startsWith("ERROR")) res.isError = true;
  return res;
}

function errText(e: unknown) {
  const { code, message } = toBridgeError(e);
  return text(`ERROR [${code}]: ${message}`);
}

const REF_HINT =
  "Note: a [ref=N] keeps pointing at the same element until the page navigates, and is never reused for a different one. " +
  "Pass this generation with act_* calls so a ref from an older page load is refused instead of guessed. " +
  "If an action fails with REF_STALE/REF_NOT_FOUND, take a fresh snapshot.";

const maxCharsField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Truncate output to this many chars");

export function registerUnderstandTools(
  server: McpServer,
  bridge: ExtensionBridge,
  _config: ServerConfig,
): void {
  server.registerTool(
    "snapshot_ax",
    {
      description: "Accessibility snapshot of the page for grounding act_* refs ([ref=N] nodes).",
      inputSchema: {
        tabId: tabIdField,
        maxChars: z.number().int().positive().optional().describe("Max snapshot chars (default 50000)"),
        compact: z.boolean().optional().describe("Compact rendering (default true)"),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        result = await bridge.call("page.snapshot", {
          tabId: args.tabId,
          maxChars: args.maxChars ?? 50000,
          compact: args.compact ?? true,
        });
      } catch (e) {
        return errText(e);
      }
      const r = (result ?? {}) as Record<string, unknown>;
      if (typeof r["text"] !== "string") return text(`${fmt(result, args.maxChars ?? 50000)}\n\n${REF_HINT}`);
      const header = [
        `url: ${String(r["url"] ?? "")}`,
        `title: ${String(r["title"] ?? "")}`,
        `generation: ${String(r["generation"] ?? "")}${r["truncated"] ? "  (TRUNCATED - raise maxChars or scroll)" : ""}`,
      ].join("\n");
      return text(`${header}\n\n${r["text"]}\n\n${REF_HINT}`);
    },
  );

  server.registerTool(
    "page_text",
    {
      description: "Extract the visible text of the page.",
      inputSchema: {
        tabId: tabIdField,
        maxChars: maxCharsField,
      },
    },
    async (args) => {
      try {
        const result = await bridge.call("page.text", { tabId: args.tabId, maxChars: args.maxChars });
        const r = (result ?? {}) as Record<string, unknown>;
        if (typeof r["text"] !== "string") return text(fmt(result, args.maxChars ?? 50000));
        const header = `url: ${String(r["url"] ?? "")}\ntitle: ${String(r["title"] ?? "")}${r["truncated"] ? "\n(TRUNCATED)" : ""}`;
        return text(`${header}\n\n${r["text"]}`);
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "page_html",
    {
      description: "Extract page HTML, optionally limited to a CSS selector subtree.",
      inputSchema: {
        tabId: tabIdField,
        selector: z.string().optional().describe("CSS selector to limit extraction to"),
        maxChars: maxCharsField,
      },
    },
    async (args) => {
      try {
        const result = await bridge.call("page.html", {
          tabId: args.tabId,
          selector: args.selector,
          maxChars: args.maxChars,
        });
        // The page already cut the HTML to maxChars: show it whole, with the page info first, not re-sliced as JSON.
        const r = result as { html?: unknown; url?: unknown; title?: unknown; truncated?: unknown } | null;
        if (r && typeof r.html === "string") {
          const head = [`URL: ${String(r.url ?? "")}`, `Title: ${String(r.title ?? "")}`];
          if (r.truncated) {
            head.push(`Truncated to ${args.maxChars ?? 50000} chars. Pass a selector or a larger maxChars for more.`);
          }
          return text(`${head.join("\n")}\n\n${r.html}`);
        }
        return text(fmt(result, args.maxChars ?? 50000));
      } catch (e) {
        return errText(e);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      description:
        "Capture a screenshot of the tab's visible area (returned as an image). Background tabs are " +
        "captured without switching where supported; otherwise the tab is briefly activated and the " +
        "previous tab restored.",
      inputSchema: {
        tabId: tabIdField,
        format: z.enum(["png", "jpeg"]).optional().describe("Image format (default png)"),
        keepActive: z.boolean().optional().describe("Leave the captured tab focused afterwards"),
      },
    },
    async (args) => {
      let result: unknown;
      try {
        result = await bridge.call("page.shot", {
          tabId: args.tabId,
          format: args.format,
          keepActive: args.keepActive,
        });
      } catch (e) {
        const { code, message } = toBridgeError(e);
        return text(`ERROR [${code}]: ${message}`);
      }
      const obj = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
      const dataUrl =
        (obj?.["image"] as unknown) ?? (obj?.["dataUrl"] as unknown) ?? (obj?.["dataURL"] as unknown);
      const m = typeof dataUrl === "string" ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl) : null;
      if (m) {
        const [, mimeType, data] = m as unknown as [string, string, string];
        const meta = { ...(obj ?? {}), image: "[omitted base64]" };
        return {
          content: [
            { type: "image" as const, data, mimeType },
            { type: "text" as const, text: fmt(meta) },
          ],
        };
      }
      return text(fmt(result));
    },
  );

  server.registerTool(
    "page_info",
    {
      description: "Basic page metadata: URL, title, load state.",
      inputSchema: { tabId: tabIdField },
    },
    async (args) => text(await callBridge(bridge, "page.info", { tabId: args.tabId })),
  );
}
