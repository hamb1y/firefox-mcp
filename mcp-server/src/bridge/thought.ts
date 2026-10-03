/**
 * The model's "thought": an optional one-liner every browser tool accepts,
 * shown to the user beside the AI cursor in Firefox. Carried through the
 * tool handler in AsyncLocalStorage so each tool's bridge.call() picks it up
 * without every tool having to pass it along by hand.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

export const currentThought = (): string | undefined => store.getStore();

export function withThought<T>(thought: string | undefined, fn: () => T): T {
  return thought ? store.run(thought, fn) : fn();
}
