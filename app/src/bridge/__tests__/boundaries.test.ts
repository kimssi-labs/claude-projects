/**
 * The feature boundaries, checked rather than trusted.
 *
 * A feature lives in `src/features/<name>/` and may reach `core/`, `bridge/`, the shell's shared
 * pieces (`main/ipc`, `main/dock`, `main/executables`, `renderer/api`, `renderer/useText`,
 * `renderer/components`) and the platform — never another feature. Anything one feature needs of
 * another is handed to it by main as `deps`, or composed by the shell (`main.ts`, `App.tsx`,
 * `Settings.tsx`, the bridge registry). This reads the imports and says so, so a change to one
 * feature cannot quietly start depending on the insides of the next — which is how "fix the dock"
 * and "break the grip" became the same edit once.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const FEATURES = join(SRC, "features");

const IMPORT = /^\s*import\s[^'"]*from\s+["']([^"']+)["']/gm;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : files(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Which feature a path names, if any — by the `features/<name>/` segment. */
function featureOf(path: string): string | null {
  const m = path.replace(/\\/g, "/").match(/features\/([^/]+)\//);
  return m ? m[1]! : null;
}

/** `spec` as seen from `file`, normalised enough to read a `features/<name>/` segment off it. */
function target(file: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return relative(SRC, join(file, "..", spec)).replace(/\\/g, "/");
}

describe("feature boundaries", () => {
  const features = readdirSync(FEATURES).filter((name) => statSync(join(FEATURES, name)).isDirectory());

  it("has the features it is meant to have", () => {
    expect(features.sort()).toEqual(["clipboard", "dock", "git", "metrics", "projects", "settings", "updates", "usage"]);
  });

  it("lets no feature import another feature", () => {
    const crossings: string[] = [];
    for (const feature of features) {
      for (const file of files(join(FEATURES, feature))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(IMPORT)) {
          const other = featureOf(target(file, match[1]!));
          if (other && other !== feature) crossings.push(`${relative(SRC, file)} -> ${match[1]}`);
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it("keeps the docking geometry (main/dock.ts) free of every feature", () => {
    const text = readFileSync(join(SRC, "main", "dock.ts"), "utf8");
    const into = [...text.matchAll(IMPORT)].map((m) => m[1]!).filter((spec) => /features\//.test(spec));
    expect(into).toEqual([]);
  });

  it("lets the bridge registry import contracts only", () => {
    const text = readFileSync(join(SRC, "bridge", "registry.ts"), "utf8");
    const specs = [...text.matchAll(IMPORT)].map((m) => m[1]!);
    expect(specs.filter((spec) => !/\/contract\.js$/.test(spec))).toEqual([]);
  });
});
