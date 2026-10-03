/**
 * Page-interaction tools. Elements are addressed either by snapshot `ref`
 * (preferred, from snapshot_ax) or by CSS `selector`; one of the two is required.
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

function refusal(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

const refField = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Element ref from snapshot_ax (preferred)");

const selectorField = z.string().optional().describe("CSS selector (alternative to ref)");

/** Guard for tools that need exactly one element target. Returns an error string or null. */
function requireTarget(args: { ref?: number; selector?: string }, tool: string): string | null {
  if (args.ref === undefined && args.selector === undefined) {
    return `ERROR: ${tool} requires either ref (from snapshot_ax) or selector.`;
  }
  return null;
}

export function registerActTools(
  server: McpServer,
  bridge: ExtensionBridge,
  _config: ServerConfig,
): void {
  server.registerTool(
    "act_click",
    {
      description: "Click an element by snapshot ref or CSS selector.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        button: z.enum(["left", "middle", "right"]).optional().describe("Mouse button (default left)"),
      },
    },
    async (args) => {
      const denied = requireTarget(args, "act_click");
      if (denied) return refusal(denied);
      return text(
        await callBridge(bridge, "act.click", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
          button: args.button,
        }),
      );
    },
  );

  server.registerTool(
    "act_type",
    {
      description: "Type text into an element (focuses it first). Optionally submit with Enter.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        text: z.string().describe("Text to type"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
    },
    async (args) => {
      const denied = requireTarget(args, "act_type");
      if (denied) return refusal(denied);
      return text(
        await callBridge(bridge, "act.type", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
          text: args.text,
          submit: args.submit,
        }),
      );
    },
  );

  server.registerTool(
    "act_fill_form",
    {
      description: "Fill multiple form fields in one call. Each field targets a ref or selector.",
      inputSchema: {
        tabId: tabIdField,
        fields: z
          .array(
            z.object({
              ref: z.number().int().positive().optional().describe("Element ref from snapshot_ax"),
              selector: z.string().optional().describe("CSS selector (alternative to ref)"),
              value: z.string().describe("Value to fill"),
            }),
          )
          .min(1)
          .describe("Fields to fill (at least one)"),
        submit: z.boolean().optional().describe("Submit the form after filling"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "act.fillForm", {
          tabId: args.tabId,
          fields: args.fields,
          submit: args.submit,
        }),
      ),
  );

  server.registerTool(
    "act_select",
    {
      description: "Select option(s) in a <select> element by value.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        values: z.array(z.string()).min(1).describe("Option value(s) to select"),
      },
    },
    async (args) => {
      const denied = requireTarget(args, "act_select");
      if (denied) return refusal(denied);
      return text(
        await callBridge(bridge, "act.select", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
          values: args.values,
        }),
      );
    },
  );

  server.registerTool(
    "act_hover",
    {
      description: "Hover over an element (reveals tooltips, menus).",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
      },
    },
    async (args) => {
      const denied = requireTarget(args, "act_hover");
      if (denied) return refusal(denied);
      return text(
        await callBridge(bridge, "act.hover", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
        }),
      );
    },
  );

  server.registerTool(
    "act_scroll",
    {
      description: "Scroll the page or an element (direction/pixels, or jump to top/bottom).",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
        pixels: z.number().int().positive().optional().describe("Pixels to scroll"),
        to: z.enum(["top", "bottom"]).optional().describe("Jump to top or bottom instead"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "act.scroll", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
          direction: args.direction,
          pixels: args.pixels,
          to: args.to,
        }),
      ),
  );

  server.registerTool(
    "act_key",
    {
      description: "Press a key, optionally with modifiers (e.g. key 'Enter', or 'a' + Ctrl).",
      inputSchema: {
        tabId: tabIdField,
        key: z.string().describe("Key to press, e.g. 'Enter', 'Escape', 'Tab', 'a'"),
        modifiers: z
          .array(z.enum(["Ctrl", "Alt", "Shift", "Meta"]))
          .optional()
          .describe("Modifier keys held while pressing"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "act.key", {
          tabId: args.tabId,
          key: args.key,
          modifiers: args.modifiers,
        }),
      ),
  );

  server.registerTool(
    "act_wait",
    {
      description: "Wait for text or a selector to appear (or just a fixed condition poll).",
      inputSchema: {
        tabId: tabIdField,
        text: z.string().optional().describe("Text to wait for on the page"),
        selector: z.string().optional().describe("CSS selector to wait for"),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .optional()
          .describe("Max wait in ms (default 10000, max 60000)"),
      },
    },
    async (args) => {
      const waitMs = Math.min(Math.max(args.timeoutMs ?? 10000, 1000), 60000);
      try {
        const result = await bridge.call(
          "act.wait",
          {
            tabId: args.tabId,
            text: args.text,
            selector: args.selector,
            timeoutMs: waitMs,
          },
          { timeoutMs: waitMs + 15000 },
        );
        return text(fmt(result));
      } catch (e) {
        const { code, message } = toBridgeError(e);
        return text(`ERROR [${code}]: ${message}`);
      }
    },
  );

  server.registerTool(
    "act_find",
    {
      description: "Find text on the page (returns match locations/count).",
      inputSchema: {
        tabId: tabIdField,
        query: z.string().describe("Text to find"),
      },
    },
    async (args) =>
      text(await callBridge(bridge, "act.find", { tabId: args.tabId, query: args.query })),
  );
}
