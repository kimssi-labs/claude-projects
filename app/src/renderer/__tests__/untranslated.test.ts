/**
 * Renderer: no English left sitting in the markup.
 *
 * Three rounds of "there is still English in the settings" is what this replaces. A person reading
 * the screen finds these one at a time; a scan of the source finds all of them at once, and finds
 * the next one the day it is written rather than the day someone notices.
 *
 * It reads the files as text rather than rendering them. Rendering would need a DOM and would only
 * cover the branches that happened to be taken; the literals are in the source either way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = join(__dirname, "..", "components");
const RENDERER = join(__dirname, "..");

/** Attributes a person reads. `placeholder` and `title` are as visible as the text itself. */
const VISIBLE_ATTRIBUTE = /\b(?:placeholder|title|aria-label)="([A-Z][^"]*)"/g;
/** Text between tags: `>Some words<`, but not `>{t("...")}<` and not a lone symbol. */
const VISIBLE_TEXT = />\s*([A-Z][A-Za-z][^<>{}]{2,})\s*</g;

/**
 * What is allowed to stay in English.
 *
 * Names of things, not sentences: a product, an executable, a flag. Translating these would make
 * them harder to find, not easier to read.
 */
const PROPER_NOUNS = /^(Hangar|Claude|Claude Code|Git|CPU|PowerShell|Windows PowerShell|PowerShell 7|bash|cmd\.exe|pwsh|English|System|Auto|Tab|Ctrl|Esc|Enter)\b/;

function sources(): { file: string; text: string }[] {
  const files = [
    ...readdirSync(COMPONENTS).filter((name) => name.endsWith(".tsx")).map((name) => join(COMPONENTS, name)),
    join(RENDERER, "App.tsx"),
  ];
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

function findings(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const phrase = (match[1] ?? "").trim();
    if (!phrase || PROPER_NOUNS.test(phrase)) continue;
    // A phrase is only worth translating if it is words; "PNG", "OK", a unit, are not.
    if (!/[a-z]/.test(phrase)) continue;
    out.push(phrase);
  }
  return out;
}

describe("every string a person reads goes through the dictionary", () => {
  it("has no English left in a visible attribute", () => {
    const left = sources().flatMap(({ file, text }) =>
      findings(VISIBLE_ATTRIBUTE, text).map((phrase) => `${file.split(/[\/]/).pop()}: ${phrase}`));
    expect(left).toEqual([]);
  });

  it("has no English left as element text", () => {
    const left = sources().flatMap(({ file, text }) =>
      findings(VISIBLE_TEXT, text).map((phrase) => `${file.split(/[\/]/).pop()}: ${phrase}`));
    expect(left).toEqual([]);
  });
});
