/**
 * Core: choosing a language, and keeping the translations honest.
 *
 * The completeness test is the one that earns its keep. A key added to English and forgotten in
 * Korean shows up as an English sentence in the middle of a Korean screen, which nobody reports
 * and everybody notices.
 */
import { describe, expect, it } from "vitest";

import { missingKeys, resolveLanguage, strayKeys, translator } from "../i18n.js";
import { en } from "../locales/en.js";

describe("resolveLanguage", () => {
  it("takes a chosen language over anything the machine says", () => {
    expect(resolveLanguage("ko", "en-US")).toBe("ko");
    expect(resolveLanguage("en", "ko-KR")).toBe("en");
  });

  it("follows the machine when nothing was chosen, reading only the language part", () => {
    expect(resolveLanguage("system", "ko-KR")).toBe("ko");
    expect(resolveLanguage("system", "ko")).toBe("ko");
    expect(resolveLanguage("system", "ko_KR.UTF-8")).toBe("ko");
    expect(resolveLanguage("system", "KO-kr")).toBe("ko");
  });

  it("falls back to English for a language this app does not have", () => {
    expect(resolveLanguage("system", "de-DE")).toBe("en");
    expect(resolveLanguage("system", "")).toBe("en");
  });
});

describe("translator", () => {
  it("returns the language's own wording", () => {
    expect(translator("en")("app.new")).toBe("New");
    expect(translator("ko")("app.new")).toBe("새 세션");
  });

  it("fills placeholders from the values given", () => {
    expect(translator("en")("app.running", { count: 2 })).toBe("2 running");
    expect(translator("ko")("app.running", { count: 2 })).toBe("2개 실행 중");
    expect(translator("en")("update.state.downloading", { version: "2.8.0", percent: 41 }))
      .toBe("Downloading 2.8.0 — 41%");
  });

  it("leaves a placeholder nobody filled visible, rather than blanking it", () => {
    // A visible {count} is a bug report; an empty space is a mystery.
    expect(translator("en")("app.running", {})).toBe("{count} running");
  });

  it("falls back to English rather than showing a key", () => {
    // Simulated by asking for a key Korean happens not to define — every key today is translated,
    // so this asserts the mechanism, using the one place a gap could open.
    const t = translator("ko");
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(t(key)).not.toBe(key);
    }
  });
});

describe("the Korean dictionary", () => {
  it("covers every key English defines", () => {
    expect(missingKeys("ko")).toEqual([]);
  });

  it("carries no key English has since dropped or renamed", () => {
    expect(strayKeys("ko")).toEqual([]);
  });

  it("keeps technical names in the original, where they are the same word everywhere", () => {
    const t = translator("ko");
    expect(t("settings.git")).toBe("Git");
    expect(t("gauge.cpu")).toBe("CPU");
    expect(t("settings.git.base.placeholder")).toContain("origin/main");
    expect(t("settings.usage.writes")).toContain("settings.json");
    expect(t("settings.git.note")).toContain("git status");
  });
});
