/**
 * What a transcript says about itself.
 *
 * `history.jsonl` looked like the cheap way to title a session — one file, every prompt, keyed by
 * session id — but it is not per-session reliable. Measured here: the first prompt a person typed
 * in one session is filed in that history under a *different* session id, one that has no
 * transcript at all. Titles taken from it drift to whatever prompt happens to be listed first.
 *
 * The transcript itself carries the truth, in entries Claude Code writes but never advertises:
 *
 *   {"type":"ai-title","aiTitle":"apiFuncGetStatus vs apiFuncGetSegmentStatus 차이", ...}
 *   {"type":"user","message":{...},"origin":{"kind":"human"},"promptSource":"typed"}
 *
 * `ai-title` is the name the terminal tab shows, refined as the conversation grows — 14 of 15
 * transcripts sampled had one. `origin.kind` separates a person typing from the caveats,
 * slash-command echoes, tool results and skill injections that are all also `type: "user"`.
 */

/** Everything one transcript can answer that the history file cannot. */
export interface TranscriptFacts {
  /** The title Claude Code generated. The last one wins: it improves as the session goes on. */
  aiTitle: string | null;
  /** The first thing a person actually typed, past the caveats and command echoes. */
  firstPrompt: string | null;
  /**
   * Whether anyone ever spoke here.
   *
   * False only for the title-carrying stubs Claude Code leaves behind — files of a few hundred
   * bytes holding an `ai-title` and an `agent-name` and nothing else, whose conversation lives in
   * another file. There is nothing in one to read or resume.
   */
  conversation: boolean;
}

const AI_TITLE = "ai-title";
const USER = "user";
const ASSISTANT = "assistant";
const HUMAN = "human";

interface Entry {
  type?: string;
  aiTitle?: string;
  origin?: { kind?: string };
  message?: { content?: unknown };
}

/** Parsed objects from `text`, silently dropping the lines a byte window cuts in half. */
function entries(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      continue;                       // the cut-off first or last line, or one half-written right now
    }
  }
  return out;
}

/** The first line of a prompt, which is what a one-line row can show. */
function firstLine(content: unknown): string | null {
  if (typeof content !== "string") return null;    // tool results and attachments arrive as arrays
  const line = content.trim().split("\n")[0]?.trim();
  return line ? line : null;
}

/**
 * Read the facts out of two windows of one transcript.
 *
 * Two windows because the two answers live at opposite ends: the first human prompt is near the
 * start, the newest `ai-title` near the end, and these files reach tens of megabytes. Pass the same
 * text as `head` and an empty `tail` when the whole file fits in one read.
 *
 * `complete` says whether `head` is the entire file. It only ever makes `conversation` more
 * cautious: a file too big to have been read whole is assumed to hold a conversation, so a long
 * session can never be mistaken for a stub and hidden.
 */
export function factsFrom(head: string, tail: string, complete: boolean): TranscriptFacts {
  const early = entries(head);
  const late = tail ? entries(tail) : [];

  let aiTitle: string | null = null;
  for (const entry of [...early, ...late]) {
    if (entry.type === AI_TITLE && entry.aiTitle?.trim()) aiTitle = entry.aiTitle.trim();
  }

  let firstPrompt: string | null = null;
  let conversation = !complete;
  for (const entry of early) {
    if (entry.type !== USER && entry.type !== ASSISTANT) continue;
    conversation = true;
    if (firstPrompt || entry.type !== USER || entry.origin?.kind !== HUMAN) continue;
    firstPrompt = firstLine(entry.message?.content);
  }

  return { aiTitle, firstPrompt, conversation };
}
