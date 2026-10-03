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

const generationField = z
  .string()
  .optional()
  .describe("The `generation` of the snapshot_ax the ref came from. If the page has since navigated, the call fails with REF_STALE instead of acting on the wrong element.");

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
      description: "Click an element by snapshot ref or CSS selector. Fails with ELEMENT_DISABLED on a disabled element.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        generation: generationField,
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
          generation: args.generation,
          button: args.button,
        }),
      );
    },
  );

  server.registerTool(
    "act_type",
    {
      description:
        "Replace the value of a text field, textarea, contenteditable, <select> (by option value or label) or checkbox/radio (\"true\"/\"false\"). " +
        "Fails with NOT_EDITABLE on buttons and read-only fields. Optionally submit afterwards.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        generation: generationField,
        text: z.string().describe("Text to type"),
        submit: z.boolean().optional().describe("Submit after typing, once: in a form, clicks its submit button (or submits it); outside a form (chat boxes), presses Enter and only if the page ignores it clicks the box's own Send button. Result says how (`submitted`), or `submitted:false` with a note."),
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
          generation: args.generation,
          text: args.text,
          submit: args.submit,
        }),
      );
    },
  );

  server.registerTool(
    "act_fill_form",
    {
      description:
        "Fill several fields in one call (same value rules as act_type). Every field is checked before anything changes, " +
        "so a bad ref or value fails the whole call without partial edits.",
      inputSchema: {
        tabId: tabIdField,
        fields: z
          .array(
            z
              .object({
                ref: z.number().int().positive().optional().describe("Element ref from snapshot_ax"),
                selector: z.string().optional().describe("CSS selector (alternative to ref)"),
                value: z.string().describe("Value to fill; \"true\"/\"false\" for checkboxes, option value or label for selects"),
              })
              .refine((f) => f.ref !== undefined || f.selector !== undefined, {
                message: "each field needs a ref or selector",
              }),
          )
          .min(1)
          .describe("Fields to fill (at least one)"),
        generation: generationField,
        submit: z.boolean().optional().describe("Submit the form after filling (same rules as act_type)"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "act.fillForm", {
          tabId: args.tabId,
          fields: args.fields,
          generation: args.generation,
          submit: args.submit,
        }),
      ),
  );

  server.registerTool(
    "act_select",
    {
      description:
        "Select option(s) in a native <select>. Each value matches an option's value exactly, then its visible label, then either ignoring case. " +
        "Fails with NO_MATCH (listing the options) if one doesn't match. For custom dropdowns, use act_click.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        generation: generationField,
        values: z.array(z.string()).min(1).describe("Option value(s) or label(s) to select; more than one only for multi-selects"),
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
          generation: args.generation,
          values: args.values,
        }),
      );
    },
  );

  server.registerTool(
    "act_hover",
    {
      description:
        "Hover over an element by sending pointer/mouse hover events. Opens menus and tooltips driven by JavaScript; " +
        "CSS-only :hover effects can't be triggered by an extension.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        generation: generationField,
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
          generation: args.generation,
        }),
      );
    },
  );

  server.registerTool(
    "act_scroll",
    {
      description:
        "Scroll the page (direction + pixels, default ~80% of the viewport), jump to top/bottom, or scroll ref/selector into view. Falls back to the page's main inner scroller (chat apps etc.) when the window itself can't scroll. Returns atEnd when there's nothing further.",
      inputSchema: {
        tabId: tabIdField,
        ref: refField,
        selector: selectorField,
        generation: generationField,
        direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
        pixels: z.number().int().positive().optional().describe("Pixels to scroll (default ~80% of the viewport)"),
        amount: z.number().int().positive().optional().describe("Alias for pixels"),
        to: z.enum(["top", "bottom"]).optional().describe("Jump to top or bottom instead"),
      },
    },
    async (args) =>
      text(
        await callBridge(bridge, "act.scroll", {
          tabId: args.tabId,
          ref: args.ref,
          selector: args.selector,
          generation: args.generation,
          direction: args.direction,
          pixels: args.pixels ?? args.amount,
          to: args.to,
        }),
      ),
  );

  server.registerTool(
    "act_key",
    {
      description:
        "Press a key on the focused element, optionally with modifiers. The page's key handlers always run; since extension key events are " +
        "untrusted, the add-on itself performs common default actions the page didn't cancel: Tab/Shift+Tab move focus, Enter activates " +
        "buttons/links or submits a form field, Space toggles/activates, printable keys and Backspace/Delete edit text fields, " +
        "arrows/PageUp/PageDown/Home/End scroll, Ctrl+A selects all. Browser shortcuts (Ctrl+T, Ctrl+L…) aren't possible. Result `effect` says what happened.",
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
