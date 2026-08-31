/**
 * Pressing Ctrl+V into whatever window has the keyboard.
 *
 * The point of the paste shortcut is that it works IN the terminal: the user presses one key there
 * and the path appears. Sending the paste ourselves is what removes the second step — and it only
 * ever happens in response to a shortcut the user pressed a moment earlier.
 *
 * That last part is the trap. The shortcut is Ctrl+Alt+V, and a person holds those modifiers for a
 * couple of hundred milliseconds; a Ctrl+V sent while Alt is still physically down arrives at the
 * terminal as Ctrl+Alt+V, which is not paste, so nothing happens. So we wait for the user's hand to
 * come off the keys before sending anything.
 */
const VK_SHIFT = 0x10;
const VK_MENU = 0x12;            // Alt
const VK_LWIN = 0x5b;
const VK_RWIN = 0x5c;
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;

/** Modifiers that change what Ctrl+V means; Ctrl itself is what we are sending anyway. */
const BLOCKING_MODIFIERS = [VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN];

/** How long to wait for the user's hand. Past this, send it regardless rather than swallow the paste. */
export const MODIFIER_WAIT_CAP_MS = 1200;
const POLL_MS = 15;

type KeyEvent = (vk: number, scan: number, flags: number, extra: number) => void;
type KeyState = (vk: number) => number;

let sendKey: KeyEvent | null | undefined;
let keyState: KeyState | null = null;

function loadKeyboard(): KeyEvent | null {
  if (sendKey !== undefined) return sendKey;
  if (process.platform !== "win32") return (sendKey = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    sendKey = user32.func("__stdcall", "keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr"]);
    keyState = user32.func("__stdcall", "GetAsyncKeyState", "int16", ["int"]);
    return sendKey;
  } catch (error) {
    console.error("[hangar] keyboard unavailable:", (error as Error).message);
    return (sendKey = null);
  }
}

/** True while any modifier that would corrupt the paste is physically held down. */
function modifiersHeld(): boolean {
  if (!keyState) return false;
  // The high bit is "down now"; the low bit is "pressed since last asked", which we do not want.
  return BLOCKING_MODIFIERS.some((vk) => (keyState!(vk) & 0x8000) !== 0);
}

/**
 * Resolves once nothing is holding the keyboard, or when the cap runs out.
 *
 * Split out from the sending so it can be tested without a keyboard: `held` stands in for the
 * hardware, `delay` for the clock.
 */
export async function whenModifiersReleased(
  held: () => boolean,
  delay: (ms: number) => Promise<void>,
  capMs = MODIFIER_WAIT_CAP_MS,
): Promise<boolean> {
  for (let waited = 0; waited < capMs; waited += POLL_MS) {
    if (!held()) return true;
    await delay(POLL_MS);
  }
  return !held();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send Ctrl+V to the foreground window, once the user's own keys are out of the way. */
export async function sendPaste(): Promise<boolean> {
  const key = loadKeyboard();
  if (!key) return false;
  await whenModifiersReleased(modifiersHeld, sleep);
  key(VK_CONTROL, 0, 0, 0);
  key(VK_V, 0, 0, 0);
  key(VK_V, 0, KEYEVENTF_KEYUP, 0);
  key(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  return true;
}
