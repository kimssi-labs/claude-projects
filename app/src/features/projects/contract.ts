/** What the page may ask about projects and their sessions: the list, and what is done to a row. */
import { invoke } from "../../bridge/contract.js";
import type { ProjectInfo } from "../../core/types.js";
import type { ActionResult, AddProjectResult } from "../../main/ipc.js";

export interface OpenSessionRequest {
  projectDir: string;
  sessionId: string | null;
  target: "sessionsWindow" | "currentWindow" | "newWindow";
}

export interface RenameRequest {
  projectDir: string;
  sessionId?: string;
  title: string;
}

export interface DeleteRequest {
  /** The window already asked; skip the native box rather than asking twice. */
  confirmed?: boolean;
  projectDir: string;
  sessionId?: string;
}

export interface PinRequest {
  kind: "projects" | "sessions";
  key: string;
}

export const projectsContract = {
  /** Every project with its sessions, read again from disk. */
  scan: invoke<void, ProjectInfo[]>("projects:scan"),
  /** Start or resume a session in a terminal. */
  openSession: invoke<OpenSessionRequest, ActionResult>("session:open"),
  renameSession: invoke<RenameRequest, ActionResult>("session:rename"),
  renameProject: invoke<RenameRequest, ActionResult>("project:rename"),
  deleteSession: invoke<DeleteRequest, ActionResult>("session:delete"),
  deleteProject: invoke<DeleteRequest, ActionResult>("project:delete"),
  /** Show the project's folder in the file manager. */
  revealProject: invoke<string, ActionResult>("project:reveal"),
  /** Opens the folder picker; resolves with the new project's dir, or ok:false when nothing was chosen. */
  addProject: invoke<void, AddProjectResult>("project:add"),
  togglePin: invoke<PinRequest, ActionResult>("pin:toggle"),
} as const;
