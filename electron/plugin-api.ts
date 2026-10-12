// Public plugin SDK (v1) — the ONLY module third-party plugins may import.
//
// A plugin's entry file receives a frozen `nexus` object with exactly these
// methods. Plugins MUST NOT import agent-service, store, providers, or any
// other internal file: those paths are unstable and privileged. Everything
// a plugin can do goes through this file + the manifest.
//
// ```js
// // my-plugin/dist/index.js
// nexus.registerTool({
//   name: "greet",
//   description: "Greet someone by name",
//   requiresApproval: false,
// });
// nexus.registerCommand({ name: "hello", description: "Say hello" });
// nexus.on("run:start", () => nexus.log("run started"));
// ```
//
// Version policy: additive changes only within v1. Breaking changes ship a
// new apiVersion ("2") with migration notes; v1 entries keep loading.

import type { PluginMode, PluginPermission } from "./plugin-manifest.js";

export const PLUGIN_SDK_VERSION = "1";

export type SdkToolDefinition = {
  name: string;
  description: string;
  modes?: PluginMode[];
  /** Must be a subset of the manifest's approved permissions. */
  permissions?: PluginPermission[];
  /** Default true: sensitive tools ask the user on every call. */
  requiresApproval?: boolean;
  timeoutMs?: number;
};

export type SdkCommandDefinition = {
  name: string;
  description: string;
  modes?: PluginMode[];
};

export type SdkContextProviderDefinition = {
  name: string;
  description?: string;
  modes?: PluginMode[];
};

export type SdkEventName =
  | "run:start"
  | "run:end"
  | "tool:before"
  | "tool:after"
  | "task:completed"
  | "task:failed";

export type ExtensionAPI = {
  registerTool(def: SdkToolDefinition): void;
  registerCommand(def: SdkCommandDefinition): void;
  registerContextProvider(
    def: SdkContextProviderDefinition,
    handler?: (context: { mode: string; projectRoot?: string }) => Promise<string> | string
  ): void;
  on(event: SdkEventName, handler: (...args: unknown[]) => unknown): void;
  log(message: string): void;
};

/**
 * Type helper for plugin authors (and for in-repo sample plugins):
 * `export default definePlugin((nexus) => { ... })`.
 */
export function definePlugin(setup: (api: ExtensionAPI) => void): (api: ExtensionAPI) => void {
  return setup;
}

export type { PluginMode, PluginPermission };
