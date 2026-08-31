import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ConfigStore, DEFAULT_PASTE_HOTKEY, DOCK_PERCENT, percentFloor } from "../config.js";

function makeHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), "cp-config-")), ".claude");
  mkdirSync(join(home, "config"), { recursive: true });
  return home;
}

describe("ConfigStore", () => {
  let home: string;
  let config: ConfigStore;

  beforeEach(() => {
    home = makeHome();
    config = new ConfigStore(home);
  });

  it("reads a settings file that was written with a BOM", () => {
    // PowerShell's -Encoding utf8 writes one; without stripping it every setting silently resets.
    config.saveDock({ enabled: true, device: "\\.\DISPLAY2", edge: "top", percent: 20 });
    const file = join(home, "config", "manager.json");
    writeFileSync(file, "﻿" + readFileSync(file, "utf8"), "utf8");
    expect(config.dock()).toMatchObject({ enabled: true, edge: "top", percent: 20 });
  });

  it("keeps every section in one file", () => {
    config.saveDock({ enabled: true, device: "\\\\.\\DISPLAY1", edge: "left", percent: 30 });
    config.saveStatus({ mcp: ["wiki"], outlook: true, ponytail: false, usage: true });
    config.saveLaunch({ shell: "cmd", permission: "bypass", terminal: "", customShell: "", pasteHotkey: "" });
    config.saveUi({ project: "C--Users-Terry", cursor: 4, theme: "dark", monitor: true, layout: "auto", stackBelow: 520, window: null, navWidth: 0, asideWidth: 0, stackTop: 0 });
    const written = JSON.parse(readFileSync(join(home, "config", "manager.json"), "utf8"));
    expect(Object.keys(written).sort()).toEqual(["dock", "launch", "status", "ui"]);
  });

  it("remembers the dock per monitor arrangement, not just per monitor", () => {
    const desk = "0,0 2560x1440 + -1536,706 1536x961";
    const laptop = "0,0 1536x961";
    config.saveDock({ enabled: true, device: "-1536,706 1536x961", edge: "left", percent: 25 }, desk);
    config.saveDock({ enabled: true, device: "0,0 1536x961", edge: "top", percent: 15 }, laptop);

    // Each set of screens brings back the monitor it was docked to, and how.
    expect(config.dock(null, desk)).toMatchObject({ device: "-1536,706 1536x961", edge: "left", percent: 25 });
    expect(config.dock(null, laptop)).toMatchObject({ device: "0,0 1536x961", edge: "top", percent: 15 });
    // An arrangement never seen before falls back to the last thing used.
    expect(config.dock(null, "0,0 1024x768")).toMatchObject({ edge: "top", percent: 15 });
  });

  it("remembers the dock per monitor and keeps the last one used", () => {
    config.saveDock({ enabled: true, device: "\\\\.\\DISPLAY1", edge: "left", percent: 30 });
    config.saveDock({ enabled: false, device: "\\\\.\\DISPLAY2", edge: "top", percent: 15 });
    expect(config.dock("\\\\.\\DISPLAY1")).toMatchObject({ edge: "left", percent: 30, enabled: true });
    expect(config.dock("\\\\.\\DISPLAY2")).toMatchObject({ edge: "top", percent: 15, enabled: false });
    expect(config.dock().device).toBe("\\\\.\\DISPLAY2");
    expect(config.dockDevices().sort()).toEqual(["\\\\.\\DISPLAY1", "\\\\.\\DISPLAY2"]);
    // A monitor never docked on falls back to the last used values rather than to nothing.
    expect(config.dock("\\\\.\\DISPLAY9")).toMatchObject({ edge: "top", percent: 15 });
  });

  it("remembers a measured floor per axis", () => {
    expect(config.dockFloor("left")).toBe(0);
    config.saveDockFloor("left", 580);
    expect(config.dockFloor("left")).toBe(580);
    expect(config.dockFloor("right")).toBe(580);         // same axis
    expect(config.dockFloor("top")).toBe(0);             // the other one is untouched
  });

  it("turns a floor into the smallest usable percentage", () => {
    expect(percentFloor(0, 1920)).toBe(DOCK_PERCENT.min);
    expect(percentFloor(580, 0)).toBe(DOCK_PERCENT.min);
    expect(percentFloor(580, 1920)).toBe(31);
    expect(percentFloor(580, 1000)).toBe(58);
    expect(percentFloor(5000, 1920)).toBe(DOCK_PERCENT.max);
  });

  it("normalises a hand-edited file instead of crashing", () => {
    writeFileSync(join(home, "config", "manager.json"), '{"dock": {"edge": "sideways", "percent": "junk"}}');
    expect(config.dock()).toMatchObject({ enabled: false, edge: "top", percent: DOCK_PERCENT.default });
    writeFileSync(join(home, "config", "manager.json"), "not json at all");
    expect(config.dock().edge).toBe("top");
    expect(config.launch()).toEqual({ shell: "auto", permission: "default", terminal: "", customShell: "", pasteHotkey: DEFAULT_PASTE_HOTKEY });
    expect(config.status()).toEqual({ mcp: null, outlook: true, ponytail: true, usage: true });
    expect(config.ui()).toEqual({ project: null, cursor: 0, theme: "system", monitor: true, layout: "auto", stackBelow: 520, window: null, navWidth: 0, asideWidth: 0, stackTop: 0 });
  });

  it("rejects a launch setting it does not recognise", () => {
    config.saveSection("launch", { shell: "nonsense", permission: "nope" });
    expect(config.launch()).toMatchObject({ shell: "auto", permission: "default" });
  });

  it("stores project aliases next to the settings", () => {
    config.saveAliases({ "C:/src/demo": "Demo" });
    expect(config.aliases()).toEqual({ "C:/src/demo": "Demo" });
  });
});
