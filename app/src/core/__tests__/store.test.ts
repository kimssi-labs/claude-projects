import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { encodeProjectPath } from "../paths.js";
import { Store } from "../store.js";

/** A throwaway ~/.claude with one project, one transcript and a history entry. */
function makeHome(): { home: string; cwd: string; dir: string; sessionId: string } {
  const root = mkdtempSync(join(tmpdir(), "cp-store-"));
  const home = join(root, ".claude");
  const cwd = join(root, "Work", "Demo");
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const dir = encodeProjectPath(cwd);
  mkdirSync(join(home, "projects", dir), { recursive: true });
  mkdirSync(join(home, "projects", dir, "memory"));
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(home, "projects", dir, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", cwd, sessionId })}\n`,
  );
  writeFileSync(
    join(home, "history.jsonl"),
    `${JSON.stringify({ display: "첫 프롬프트\n둘째 줄", sessionId })}\n`,
  );
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ projects: { [cwd]: {} } }));
  return { home, cwd, dir, sessionId };
}

describe("path encoding", () => {
  it("matches Claude Code's own scheme", () => {
    expect(encodeProjectPath("C:\\Users\\Terry")).toBe("C--Users-Terry");
    expect(encodeProjectPath("C:/Local/OneDrive - Movensys/문서/99. Archive"))
      .toBe("C--Local-OneDrive---Movensys----99--Archive");
  });
});

describe("Store.scan", () => {
  let fixture: ReturnType<typeof makeHome>;
  let store: Store;

  beforeEach(() => {
    fixture = makeHome();
    store = new Store(fixture.home, { isAlive: () => false, folderExists: () => true });
  });

  it("reads the project, its folder and its session", () => {
    const [project] = store.scan();
    expect(project?.dir).toBe(fixture.dir);
    expect(project?.cwd).toBe(fixture.cwd);
    expect(project?.hasMemory).toBe(true);
    expect(project?.sessions).toHaveLength(1);
    expect(project?.sessions[0]?.title).toBe("첫 프롬프트");   // first line of the first prompt
    expect(project?.sessions[0]?.named).toBe(false);
    expect(project?.sessions[0]?.live).toBe(false);
  });

  it("marks a session live only while its pid exists", () => {
    writeFileSync(
      join(fixture.home, "sessions", "4242.json"),
      JSON.stringify({ pid: 4242, sessionId: fixture.sessionId }),
    );
    const dead = new Store(fixture.home, { isAlive: () => false, folderExists: () => true });
    expect(dead.scan()[0]?.sessions[0]?.live).toBe(false);
    const alive = new Store(fixture.home, { isAlive: (pid) => pid === 4242, folderExists: () => true });
    expect(alive.scan()[0]?.sessions[0]).toMatchObject({ live: true, pid: 4242 });
  });

  it("recovers the folder from .claude.json once the transcripts are gone", () => {
    const [project] = store.scan();
    store.deleteSession(project!.sessions[0]!);
    const after = store.scan()[0];
    expect(after?.sessions).toHaveLength(0);
    expect(after?.cwd).toBe(fixture.cwd);
  });

  it("renames a session the way /rename does, so /resume shows it too", () => {
    const session = store.scan()[0]!.sessions[0]!;
    store.renameSession(session, "새 제목");
    const sidecar = join(fixture.home, "projects", fixture.dir, fixture.sessionId, "custom-title.json");
    expect(JSON.parse(readFileSync(sidecar, "utf8")).customTitle).toBe("새 제목");
    const lines = readFileSync(session.file, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1] as string)).toEqual({
      type: "custom-title", customTitle: "새 제목", sessionId: fixture.sessionId,
    });
    const renamed = store.scan()[0]!.sessions[0]!;
    expect(renamed.title).toBe("새 제목");
    expect(renamed.named).toBe(true);
    expect(renamed.prompt).toBe("첫 프롬프트");            // the original prompt is still known
  });

  it("aliases a project and clears the alias again", () => {
    const project = store.scan()[0]!;
    store.renameProject(project, "데모");
    expect(store.scan()[0]?.name).toBe("데모");
    store.renameProject(store.scan()[0]!, "");
    expect(store.scan()[0]?.name).toBe("Demo");
  });

  it("deletes a project with everything under it", () => {
    store.deleteProject(store.scan()[0]!);
    expect(store.scan()).toHaveLength(0);
    expect(existsSync(join(fixture.home, "projects", fixture.dir))).toBe(false);
  });

  it("re-reads history.jsonl only when it changed", () => {
    const first = store.historyTitles();
    expect(store.historyTitles()).toBe(first);                       // cache hit: same object
    writeFileSync(
      join(fixture.home, "history.jsonl"),
      `${JSON.stringify({ display: "다른 프롬프트", sessionId: fixture.sessionId })}\n`,
    );
    expect(store.historyTitles()).not.toBe(first);
    expect(store.historyTitles().get(fixture.sessionId)).toBe("다른 프롬프트");
  });

  it("reports a project whose folder is gone", () => {
    const missing = new Store(fixture.home, { isAlive: () => false, folderExists: () => false });
    expect(missing.scan()[0]?.exists).toBe(false);
  });
});

describe("reading transcripts", () => {
  it("finds the cwd without reading the whole file", () => {
    const { home } = makeHome();
    const dir = join(home, "projects", "C--big");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "11111111-2222-3333-4444-555555555555.jsonl");
    // A first line with the cwd, then far more than any head-read would cover.
    const filler = `${JSON.stringify({ type: "assistant", text: "x".repeat(2000) })}
`;
    writeFileSync(file, `${JSON.stringify({ type: "user", cwd: "C:\big" })}
${filler.repeat(4000)}`);

    const store = new Store(home, { isAlive: () => false, folderExists: () => true });
    const started = Date.now();
    expect(store.transcriptCwd(file)).toBe("C:\big");
    // Generous, but a full read of an 8 MB file cannot make it: this is about the shape, not speed.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
