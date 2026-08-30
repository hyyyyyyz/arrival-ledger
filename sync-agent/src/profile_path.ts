import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";

export interface ProfilePathInspection {
  requested_path: string;
  canonical_path: string;
  existing_ancestor: string;
  target_exists: boolean;
  target_is_directory: boolean;
  target_mode: number | null;
  unsafe_components: string[];
}

function normalizedPath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve a profile path without trusting lexical path equality.
 *
 * The nearest existing ancestor is resolved through the operating system's
 * native realpath implementation, so Windows junction/reparse aliases and
 * POSIX symlink aliases converge on the same eventual path. Every existing
 * component is also inspected with lstat; callers must reject a non-empty
 * unsafe_components list.
 */
export function inspectProfilePath(path: string): ProfilePathInspection {
  const requestedPath = resolve(path);
  const suffix: string[] = [];
  let existingAncestor = requestedPath;
  let existingStat = lstatOrNull(existingAncestor);

  while (existingStat === null) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`cannot find an existing ancestor for profile path ${requestedPath}`);
    }
    suffix.unshift(basename(existingAncestor));
    existingAncestor = parent;
    existingStat = lstatOrNull(existingAncestor);
  }

  const unsafeComponents: string[] = [];
  let component = existingAncestor;
  while (true) {
    const stat = lstatSync(component);
    if (stat.isSymbolicLink()) unsafeComponents.push(component);
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }

  // realpathSync.native detects Windows junctions/reparse aliases even when a
  // platform-specific lstat implementation does not label one as a symlink.
  const realAncestor = realpathSync.native(existingAncestor);
  if (normalizedPath(realAncestor) !== normalizedPath(existingAncestor)) {
    unsafeComponents.push(existingAncestor);
  }
  const canonicalPath = resolve(realAncestor, ...suffix);
  const targetStat = lstatOrNull(requestedPath);

  return {
    requested_path: requestedPath,
    canonical_path: canonicalPath,
    existing_ancestor: existingAncestor,
    target_exists: targetStat !== null,
    target_is_directory: targetStat?.isDirectory() ?? false,
    target_mode: targetStat == null ? null : Number(targetStat.mode),
    unsafe_components: [...new Set(unsafeComponents)],
  };
}

/**
 * Last-moment browser launch guard. It creates only the final requested
 * profile directory, then re-inspects the complete path so a parent swapped
 * to a symlink/junction after config parsing cannot reach Chromium.
 */
export function prepareProfileDirForBrowser(path: string): string {
  const before = inspectProfilePath(path);
  if (before.unsafe_components.length > 0) {
    throw new Error(`profile path contains a symbolic link or junction component: ${before.unsafe_components[0]}`);
  }
  if (normalizedPath(before.canonical_path) === normalizedPath(parse(before.canonical_path).root)) {
    throw new Error("profile path must not be a filesystem root");
  }
  if (before.target_exists && !before.target_is_directory) {
    throw new Error("profile path exists but is not a directory");
  }

  mkdirSync(before.canonical_path, { recursive: true, mode: 0o700 });
  const after = inspectProfilePath(path);
  if (after.unsafe_components.length > 0) {
    throw new Error(`profile path changed to a symbolic link or junction component: ${after.unsafe_components[0]}`);
  }
  if (normalizedPath(after.canonical_path) !== normalizedPath(before.canonical_path)) {
    throw new Error("profile path changed while being prepared; refusing browser launch");
  }
  if (!after.target_exists || !after.target_is_directory) {
    throw new Error("profile path is unavailable after creation");
  }
  if (process.platform !== "win32" && after.target_mode !== null) {
    if ((after.target_mode & 0o022) !== 0) {
      throw new Error("profile directory must not be writable by group or other users (use chmod 700)");
    }
    // mkdir's mode is affected by the caller's umask. Tighten newly-created
    // directories explicitly; existing read-only group access remains a
    // config warning for backwards compatibility.
    if (!before.target_exists) chmodSync(after.canonical_path, 0o700);
  }
  return after.canonical_path;
}
