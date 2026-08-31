/**
 * Pressing Ctrl+V into whatever window has the keyboard.
 *
 * The point of the paste shortcut is that it works IN the terminal: the user presses one key there
 * and the path appears. Sending the paste ourselves is what removes the second step — and it only
 * ever happens in response to a shortcut the user pressed a moment earlier.
 */
const VK_CONTROL = 0x11;
const VK_V = 0x56;
const KEYEVENTF_KEYUP = 0x0002;

type KeyEvent = (vk: number, scan: number, flags: number, extra: number) => void;

let sendKey: KeyEvent | null | undefined;

function loadKeyboard(): KeyEvent | null {
  if (sendKey !== undefined) return sendKey;
  if (process.platform !== "win32") return (sendKey = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const user32 = koffi.load("user32.dll");
    sendKey = user32.func("__stdcall", "keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr"]);
    return sendKey;
  } catch (error) {
    console.error("[hangar] keyboard unavailable:", (error as Error).message);
    return (sendKey = null);
  }
}

/** Send Ctrl+V to the foreground window. Returns false where that cannot be done. */
export function sendPaste(): boolean {
  const key = loadKeyboard();
  if (!key) return false;
  key(VK_CONTROL, 0, 0, 0);
  key(VK_V, 0, 0, 0);
  key(VK_V, 0, KEYEVENTF_KEYUP, 0);
  key(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  return true;
}
