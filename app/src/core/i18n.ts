/**
 * Saying the same thing in more than one language.
 *
 * English is the source: every key exists there, and a translation that is missing a key falls back
 * to the English rather than showing the key itself — a half-translated screen reads better than
 * one with `settings.dock.title` in the middle of it.
 *
 * The dictionaries are plain objects rather than a library. There are two languages and a few
 * hundred strings; an i18n framework would bring a runtime, a loader and a plural engine to a
 * problem that is a lookup and one substitution.
 */
import { en } from "./locales/en.js";
import { ko } from "./locales/ko.js";

/** A language the app can be read in. `system` follows the machine. */
export type Language = "system" | "en" | "ko";

export const LANGUAGES: { key: Language; label: string }[] = [
  // Each in its own language: someone who has landed in the wrong one still recognises theirs.
  { key: "system", label: "System" },
  { key: "en", label: "English" },
  { key: "ko", label: "한국어" },
];

/** The keys English defines — every other dictionary is checked against these. */
export type MessageKey = keyof typeof en;
export type Dictionary = Partial<Record<MessageKey, string>>;

const DICTIONARIES: Record<Exclude<Language, "system">, Dictionary> = { en, ko };

/**
 * Which language to actually use, given the setting and what the machine says.
 *
 * The locale arrives as a BCP 47 tag (`ko-KR`, `en-GB`), and only the language part decides; a
 * machine set to a language this app does not have reads it in English.
 */
export function resolveLanguage(setting: Language, systemLocale: string): Exclude<Language, "system"> {
  if (setting === "en" || setting === "ko") return setting;
  const base = systemLocale.toLowerCase().split(/[-_]/)[0] ?? "";
  return base === "ko" ? "ko" : "en";
}

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/**
 * A lookup for one language.
 *
 * `{name}` in a message is replaced from `vars`. A placeholder with nothing to fill it is left
 * as it is: a visible `{count}` says a caller forgot something, where an empty space hides it.
 */
export function translator(language: Exclude<Language, "system">): Translate {
  const dictionary = DICTIONARIES[language] ?? en;
  return (key, vars) => {
    const template = dictionary[key] ?? en[key] ?? String(key);
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      (name in vars ? String(vars[name]) : whole));
  };
}

/** Keys a translation is missing, so a test can say which rather than that some are. */
export function missingKeys(language: Exclude<Language, "system">): MessageKey[] {
  const dictionary = DICTIONARIES[language] ?? {};
  return (Object.keys(en) as MessageKey[]).filter((key) => !(key in dictionary));
}

/** Keys a translation has that English does not — a rename left behind, or a typo. */
export function strayKeys(language: Exclude<Language, "system">): string[] {
  const dictionary = DICTIONARIES[language] ?? {};
  return Object.keys(dictionary).filter((key) => !(key in en));
}
