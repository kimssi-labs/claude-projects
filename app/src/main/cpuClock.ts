/**
 * What the processor is actually running at, right now.
 *
 * `os.cpus()[i].speed` is not it. On Windows it comes from the registry value written at boot and
 * never moves — measured here at a flat 2995 MHz on all twenty cores while the real clock swung —
 * so the window was showing "3.0 GHz" as though it were a live reading of an idle machine.
 *
 * Task Manager's own figure is the base clock times the `% Processor Performance` counter, and that
 * counter does move: 106.9 % and 119.4 % two seconds apart on an idle machine here. So:
 *
 *   - the base clock comes from `Win32_Processor.MaxClockSpeed`, read ONCE (WMI costs a process),
 *   - the performance percentage comes from PDH, which is a handful of microseconds per sample.
 *
 * Until the base clock arrives, and on any machine where either source is missing, this reports
 * null and the caller falls back to the nominal figure.
 */
import { execFile } from "node:child_process";

/** PDH's "give me a double" format. */
const PDH_FMT_DOUBLE = 0x00000200;
/** The counter is English-named on every locale when added with the English API. */
const PERFORMANCE_COUNTER = "\\Processor Information(_Total)\\% Processor Performance";

interface Pdh {
  open: () => number | null;
  read: () => number | null;
}

let pdh: Pdh | null | undefined;
let query: number | null = null;
let counter: number | null = null;
let baseMhz: number | null = null;
let baseAsked = false;

function loadPdh(): Pdh | null {
  if (pdh !== undefined) return pdh;
  if (process.platform !== "win32") return (pdh = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi") as typeof import("koffi");
    const lib = koffi.load("pdh.dll");
    // The value union is 8-byte aligned, so the status word is followed by four bytes of padding.
    const VALUE = koffi.struct("PDH_FMT_COUNTERVALUE", {
      status: "uint32",
      padding: "uint32",
      value: "double",
    });
    const PdhOpenQueryW = lib.func("__stdcall", "PdhOpenQueryW", "long",
      ["void *", "uintptr", koffi.out(koffi.pointer("uintptr"))]);
    const PdhAddEnglishCounterW = lib.func("__stdcall", "PdhAddEnglishCounterW", "long",
      ["uintptr", "str16", "uintptr", koffi.out(koffi.pointer("uintptr"))]);
    const PdhCollectQueryData = lib.func("__stdcall", "PdhCollectQueryData", "long", ["uintptr"]);
    const PdhGetFormattedCounterValue = lib.func("__stdcall", "PdhGetFormattedCounterValue", "long",
      ["uintptr", "uint32", koffi.out(koffi.pointer("uint32")), koffi.out(koffi.pointer(VALUE))]);

    return (pdh = {
      open: () => {
        const out: number[] = [0];
        if (PdhOpenQueryW(null, 0, out) !== 0) return null;
        const handle = out[0] as number;
        const counterOut: number[] = [0];
        if (PdhAddEnglishCounterW(handle, PERFORMANCE_COUNTER, 0, counterOut) !== 0) return null;
        counter = counterOut[0] as number;
        // A rate counter needs one collection to have something to rate against.
        PdhCollectQueryData(handle);
        return handle;
      },
      read: () => {
        if (query === null || counter === null) return null;
        if (PdhCollectQueryData(query) !== 0) return null;
        const type: number[] = [0];
        const out = [{ status: 0, padding: 0, value: 0 }];
        if (PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, type, out) !== 0) return null;
        const reading = out[0]?.value;
        return typeof reading === "number" && Number.isFinite(reading) ? reading : null;
      },
    });
  } catch (error) {
    console.error("[hangar] live clock unavailable:", (error as Error).message);
    return (pdh = null);
  }
}

/** The processor's nominal clock, asked for once — a WMI query costs a process, a sample must not. */
function askBaseClock(): void {
  if (baseAsked || process.platform !== "win32") return;
  baseAsked = true;
  execFile(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed"],
    { windowsHide: true, timeout: 10_000 },
    (error, stdout) => {
      if (error) return;
      const mhz = Number(String(stdout).trim());
      if (Number.isFinite(mhz) && mhz > 0) baseMhz = mhz;
    },
  );
}

/**
 * The live clock in GHz, or null while it cannot be known.
 *
 * Called once per sample; everything expensive happens on the first call or not at all.
 */
export function liveClockGhz(): number | null {
  const api = loadPdh();
  if (!api) return null;
  askBaseClock();
  if (query === null) query = api.open();
  if (query === null || baseMhz === null) return null;
  const percent = api.read();
  if (percent === null || percent <= 0) return null;
  return (baseMhz * percent) / 100 / 1000;
}
