/**
 * Every script this package advertises must actually ship.
 *
 * A real failure this catches: `src/build/dataset.ts` matched the `build/`
 * rule in .gitignore, so it was never committed. Every local check passed —
 * the file was on disk — and the only symptom was CI failing with
 * "Cannot find module" on a machine that had only ever seen the repository.
 *
 * Existing on disk is therefore not the property worth asserting. Being
 * tracked by git is.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles(): Set<string> {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: serverDir,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return new Set(output.split("\0").filter(Boolean));
}

/** The .ts entrypoints a script hands to node, ignoring flags and arguments. */
function entrypointsFrom(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((token) => token.endsWith(".ts") && !token.startsWith("-"));
}

/** A shell glob as a regex. `*` stops at a path separator, as the shell does. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\[/g, "[")
    .replace(/\?/g, "[^/]")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`);
}

describe("package scripts", () => {
  const manifest = JSON.parse(
    readFileSync(join(serverDir, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };

  it("point at files that exist and are tracked by git", () => {
    const tracked = [...trackedFiles()];
    const problems: string[] = [];

    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const entry of entrypointsFrom(command)) {
        // Some scripts pass a shell glob (`test/*.test.ts`) rather than one
        // file. For those the question is whether anything matches at all.
        const matches = /[*?[]/.test(entry)
          ? tracked.some((file) => globToRegExp(entry).test(file))
          : tracked.includes(entry);

        if (!matches) {
          problems.push(
            `"${name}" runs ${entry}, which git is not tracking — ` +
              `check .gitignore, it will fail on a fresh clone`,
          );
        }
      }
    }

    assert.deepEqual(problems, []);
  });

  it("covers the scripts the CI workflows invoke", () => {
    // These names are referenced from .github/workflows; renaming one without
    // updating the workflow is a silent break until the schedule fires.
    for (const required of ["build:deals", "test", "typecheck"]) {
      assert.ok(
        required in manifest.scripts,
        `${required} is referenced by a workflow but missing from package.json`,
      );
    }
  });
});
