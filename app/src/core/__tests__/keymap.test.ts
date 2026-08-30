import { describe, expect, it } from "vitest";

import { nextIndex, resolveAction, SHORTCUTS } from "../keymap.js";

describe("resolveAction", () => {
  it("keeps the terminal keys doing the terminal things", () => {
    expect(resolveAction({ key: "ArrowDown" }, "projects")).toBe("moveDown");
    expect(resolveAction({ key: "Enter" }, "projects")).toBe("enter");
    expect(resolveAction({ key: "t" }, "sessions")).toBe("openHere");
    expect(resolveAction({ key: "O" }, "sessions")).toBe("openNewWindow");
    expect(resolveAction({ key: "F2" }, "sessions")).toBe("rename");
    expect(resolveAction({ key: "Delete" }, "projects")).toBe("delete");
    expect(resolveAction({ key: "F5" }, "projects")).toBe("refresh");
    expect(resolveAction({ key: "s" }, "projects")).toBe("settings");
  });

  it("uses the arrow keys for depth the way the list does", () => {
    expect(resolveAction({ key: "ArrowRight" }, "projects")).toBe("enter");
    expect(resolveAction({ key: "ArrowRight" }, "sessions")).toBeNull();   // right never launches
    expect(resolveAction({ key: "ArrowLeft" }, "sessions")).toBe("back");
    expect(resolveAction({ key: "Escape" }, "sessions")).toBe("back");
  });

  it("moves between settings sections with Tab", () => {
    expect(resolveAction({ key: "Tab" }, "settings")).toBe("nextSection");
    expect(resolveAction({ key: "Tab", shiftKey: true }, "settings")).toBe("previousSection");
  });

  it("ignores letters while a text field has focus", () => {
    expect(resolveAction({ key: "o" }, "sessions", true)).toBeNull();
    expect(resolveAction({ key: "Delete" }, "sessions", true)).toBeNull();
    expect(resolveAction({ key: "Enter" }, "sessions", true)).toBe("enter");
    expect(resolveAction({ key: "Escape" }, "sessions", true)).toBe("back");
  });

  it("reserves the modifiers for the one shortcut that needs them", () => {
    expect(resolveAction({ key: "q", ctrlKey: true }, "projects")).toBe("quit");
    expect(resolveAction({ key: "s", ctrlKey: true }, "projects")).toBeNull();
    expect(resolveAction({ key: "t", altKey: true }, "projects")).toBeNull();
  });

  it("documents every action it can produce", () => {
    const documented = new Set(SHORTCUTS.flatMap((s) => [s.action]));
    for (const action of ["enter", "openHere", "openNewWindow", "rename", "delete", "refresh", "settings", "quit"]) {
      expect(documented.has(action as never)).toBe(true);
    }
  });
});

describe("nextIndex", () => {
  it("clamps at both ends", () => {
    expect(nextIndex("moveUp", 0, 5, 10)).toBe(0);
    expect(nextIndex("moveDown", 4, 5, 10)).toBe(4);
    expect(nextIndex("pageDown", 0, 50, 10)).toBe(10);
    expect(nextIndex("pageUp", 5, 50, 10)).toBe(0);
    expect(nextIndex("moveLast", 0, 5, 10)).toBe(4);
    expect(nextIndex("moveFirst", 3, 5, 10)).toBe(0);
  });

  it("stays at zero for an empty list", () => {
    expect(nextIndex("moveDown", 0, 0, 10)).toBe(0);
  });
});
