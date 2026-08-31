// The feature as it is actually used: an image on the clipboard, Ctrl+Alt+V pressed in Notepad.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { _electron as electron } from "@playwright/test";

const koffi = (await import("koffi")).default;
const user32 = koffi.load("user32.dll");
const keybd_event = user32.func("__stdcall", "keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr"]);

const VK = { ctrl: 0x11, alt: 0x12, v: 0x56, a: 0x41, c: 0x43 };
const UP = 2;
const press = (...keys) => {
  for (const k of keys) keybd_event(k, 0, 0, 0);
  for (const k of [...keys].reverse()) keybd_event(k, 0, UP, 0);
};

const app = await electron.launch({ args: ["."], cwd: process.cwd() });
let page;
for (;;) { page = app.windows().find((w) => w.url().includes("index.html")); if (page) break; await app.waitForEvent("window"); }
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(2500);

const hotkey = await app.evaluate(({ globalShortcut }) => ({
  registered: globalShortcut.isRegistered("CommandOrControl+Alt+V"),
}));
console.log("shortcut registered:", hotkey.registered);

// A real image on the clipboard, the way a screenshot tool leaves one.
const b64 = execFileSync("python", ["-c",
  "import base64,io;from PIL import Image;b=io.BytesIO();Image.new('RGB',(20,20),(217,119,87)).save(b,format='PNG');print(base64.b64encode(b.getvalue()).decode())",
], { encoding: "utf8" }).trim();
await app.evaluate(({ clipboard, nativeImage }, data) =>
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, "base64"))), b64);
console.log("clipboard has an image:", await app.evaluate(({ clipboard }) => !clipboard.readImage().isEmpty()));

// Somewhere to paste into, focused, exactly like a terminal would be.
const target = "C:\\Users\\TerryTaegyunKim\\AppData\\Local\\Temp\\hotkey-target.txt";
if (existsSync(target)) unlinkSync(target);
writeFileSync(target, "");
const np = spawn("notepad.exe", [target], { detached: true, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));

press(VK.ctrl, VK.alt, VK.v);                       // the shortcut, pressed where the user presses it
await new Promise((r) => setTimeout(r, 1500));

press(VK.ctrl, VK.a);
await new Promise((r) => setTimeout(r, 200));
press(VK.ctrl, VK.c);
await new Promise((r) => setTimeout(r, 500));
const pasted = execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard"], { encoding: "utf8" }).trim();
console.log("what landed in the window:", JSON.stringify(pasted));

process.kill(np.pid);
await app.close();
