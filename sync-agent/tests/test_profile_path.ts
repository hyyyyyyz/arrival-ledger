import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProfilePath, prepareProfileDirForBrowser } from "../src/profile_path.js";

const createdDirs: string[] = [];

function tempDir(): string {
  const lexical = mkdtempSync(join(tmpdir(), "sync-agent-profile-"));
  createdDirs.push(lexical);
  return realpathSync.native(lexical);
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("profile path safety", () => {
  it("canonicalizes an eventual path from its nearest existing ancestor", () => {
    const dir = tempDir();
    const inspected = inspectProfilePath(join(dir, "profiles", "buyer-one"));
    expect(inspected.canonical_path).toBe(join(dir, "profiles", "buyer-one"));
    expect(inspected.target_exists).toBe(false);
    expect(inspected.unsafe_components).toEqual([]);
  });

  it("detects a parent symlink or Windows junction and resolves aliases to one eventual profile", () => {
    const dir = tempDir();
    const realParent = join(dir, "profiles-real");
    const aliasParent = join(dir, "profiles-alias");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");

    const direct = inspectProfilePath(join(realParent, "buyer"));
    const aliased = inspectProfilePath(join(aliasParent, "buyer"));
    expect(aliased.unsafe_components.length).toBeGreaterThan(0);
    expect(aliased.canonical_path).toBe(direct.canonical_path);
  });

  it("creates a new profile as 0700 and rejects a parent swapped to a symlink before launch", () => {
    const dir = tempDir();
    const parent = join(dir, "profiles");
    mkdirSync(parent, { mode: 0o700 });
    const profile = join(parent, "buyer");
    expect(prepareProfileDirForBrowser(profile)).toBe(profile);
    if (process.platform !== "win32") {
      expect(lstatSync(profile).mode & 0o777).toBe(0o700);
    }

    const originalParent = join(dir, "profiles-original");
    const attackerParent = join(dir, "profiles-attacker");
    mkdirSync(attackerParent);
    renameSync(parent, originalParent);
    symlinkSync(attackerParent, parent, process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareProfileDirForBrowser(profile)).toThrow(/symbolic link|junction/);
  });
});
