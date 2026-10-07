// Read-only `statusTileExamples` resource provider. It offers the tile
// set in status-tiles-examples.json to the Status Tiles plugin, with the
// same semantics as Status Tiles' own provider: the set is listed only
// while this plugin runs, and writes are rejected.

import { readFileSync } from "node:fs";
import type { ServerAPI } from "@signalk/server-api";

export const EXAMPLES_RESOURCE_TYPE = "statusTileExamples";

export interface TilesProvider {
  /** Mark the plugin running and register the provider (once). */
  start(): void;
  /** Mark the plugin stopped; the provider then lists nothing. */
  stop(): void;
}

export interface TilesProviderOptions {
  /** Key the set is listed under; the plugin id. */
  pluginId: string;
  /** Override the shipped examples (tests). */
  examples?: unknown;
}

/** Reads the shipped status-tiles-examples.json (package root). */
export function loadExamples(): unknown {
  return JSON.parse(
    readFileSync(
      new URL("../status-tiles-examples.json", import.meta.url),
      "utf8",
    ),
  );
}

interface ResourceProviderRegistry {
  registerResourceProvider?: (provider: unknown) => void;
}

export function createTilesProvider(
  app: ServerAPI,
  options: TilesProviderOptions,
): TilesProvider {
  const { pluginId } = options;
  let running = false;
  let registered = false;
  let examples: unknown = options.examples;

  const readOnly = async (): Promise<never> => {
    throw new Error(`${pluginId} is a read-only provider`);
  };

  function register(): void {
    if (registered) return;
    const registry = app as unknown as ResourceProviderRegistry;
    if (typeof registry.registerResourceProvider !== "function") {
      // Older servers have no registry; that is normal, not a fault.
      app.debug(
        `[${pluginId}] server has no resource provider registry; Status Tiles examples disabled`,
      );
      return;
    }
    try {
      examples ??= loadExamples();
      registry.registerResourceProvider({
        type: EXAMPLES_RESOURCE_TYPE,
        methods: {
          listResources: async () => (running ? { [pluginId]: examples } : {}),
          getResource: async (id: string) => {
            if (!running || id !== pluginId) {
              throw new Error(
                `No such ${EXAMPLES_RESOURCE_TYPE} resource: ${id}`,
              );
            }
            return examples;
          },
          setResource: readOnly,
          deleteResource: readOnly,
        },
      });
      registered = true;
    } catch (err) {
      app.error(
        `[${pluginId}] could not register Status Tiles examples: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    start() {
      running = true;
      register();
    },
    stop() {
      running = false;
    },
  };
}
