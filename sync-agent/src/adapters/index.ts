import { PLATFORMS, type Platform } from "../models.js";
import type { PlatformAdapter } from "./base.js";
import { ali1688Adapter } from "./ali1688.js";
import { pddAdapter } from "./pdd.js";

export function getAdapter(platform: Platform): PlatformAdapter {
  switch (platform) {
    case "1688":
      return ali1688Adapter;
    case "pdd":
      return pddAdapter;
    default: {
      const exhaustive: never = platform;
      throw new Error(`unknown platform ${String(exhaustive)}`);
    }
  }
}

export function availablePlatforms(): readonly Platform[] {
  return PLATFORMS;
}
