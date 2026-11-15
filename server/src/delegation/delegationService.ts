/**
 * Delegation: an agent in the office hands a task to a CHARACTER — the agent
 * wearing it in the same Directory, idle, or a fresh launch of it — and later
 * collects that agent's reply. This is what lets a lead run a pipeline through
 * the office's own characters (their sessions, their role, model and Figma
 * link) instead of anonymous sub-agents.
 *
 * Standalone only: a task is typed into the target's PTY (bracketed paste,
 * then Enter), or, for a launch, given as the session's first prompt. A turn
 * is read off the store's broadcasts — the target's first activity after the
 * task starts it, its next `agentStatus: waiting` ends it — and the reply is
 * the provider's reading of the transcript written since (`turnReply`).
 *
 * Results are returned as values (`{ error }` for anything the caller should
 * be told), never thrown: they go back to a coding agent as tool output.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { CharacterProfile } from '../../../core/src/characterProfiles.js';
import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  DELEGATION_REPLY_RETRY_MS,
  DELEGATION_SUBMIT_DELAY_MS,
  DELEGATION_TASK_MAX_CHARS,
  DELEGATION_TASK_TTL_MS,
  DELEGATION_WAIT_DEFAULT_MS,
  DELEGATION_WAIT_MAX_MS,
} from '../constants.js';
import type { TerminalSessions } from '../terminal/terminalSessions.js';
import type { AgentState } from '../types.js';

export interface DelegationDeps {
  store: AgentStateStore;
  ptyManager: TerminalSessions;
  provider: HookProvider;
  /** The character list (palette = index). */
  profiles(): readonly CharacterProfile[];
  /** Launch `palette` into `directoryPath` with `prompt` as its first prompt;
   *  the new agent's id, or null when the launch failed. */
  launch(opts: { directoryPath: string; palette: number; prompt: string }): number | null;
}

export type DelegationResult<T> = T | { error: string };

export type TaskStatus = 'starting' | 'working' | 'done' | 'gone';

/** What wait_for_task reports. */
export interface TaskReport {
  taskId: string;
  character: string;
  agentId: number;
  status: TaskStatus;
  /** The target is stopped on a permission prompt the user must answer in its terminal. */
  needsPermission: boolean;
  /** The target's last reply (status 'done'); absent when it wrote none. */
  reply?: string;
}

interface DelegatedTask {
  id: string;
  fromAgentId: number;
  toAgentId: number;
  character: string;
  status: TaskStatus;
  /** The transcript the turn is written to, and where the task began in it. */
  transcript: string;
  offset: number;
  reply?: string;
  finishedAt?: number;
  waiters: Set<() => void>;
}

/** A character as list_characters shows it. */
export interface CharacterListing {
  name: string;
  role?: string;
  model?: string;
  hasFigmaLink: boolean;
  inOffice: { agentId: number; status: 'idle' | 'working' | 'needs_permission' | 'has_task' }[];
}

// Everything but tab and newline below 0x20, and DEL: nothing a terminal would
// read as a key press or an escape sequence (a paste end marker included).

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** A task's text as it may reach a terminal. */
export function cleanTaskText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_RE, '').trim();
}

const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

export function characterLabel(profiles: readonly CharacterProfile[], index: number): string {
  return profiles[index]?.name?.trim() || `Character ${index + 1}`;
}

/**
 * The character a caller means: an exact name (any case), else a role that
 * exactly one character launches as. Ambiguity and misses are errors that list
 * the names, so the caller can pick.
 */
export function resolveCharacter(
  profiles: readonly CharacterProfile[],
  wanted: string,
): DelegationResult<number> {
  const w = wanted.trim().toLowerCase();
  if (!w) return { error: 'Name the character to delegate to.' };
  const names = profiles.map((_, i) => characterLabel(profiles, i));
  const byName = names.flatMap((n, i) => (n.toLowerCase() === w ? [i] : []));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    return {
      error: `Several characters are named "${wanted}"; rename one in the Characters view.`,
    };
  }
  const byRole = profiles.flatMap((p, i) => (p.launch?.agent?.toLowerCase() === w ? [i] : []));
  if (byRole.length === 1) return byRole[0];
  const known = names.join(', ');
  if (byRole.length > 1) {
    const which = byRole.map((i) => names[i]).join(', ');
    return { error: `Several characters have the role "${wanted}" (${which}); name one.` };
  }
  return { error: `No character is named "${wanted}". Characters: ${known}.` };
}

export class DelegationService {
  private readonly tasks = new Map<string, DelegatedTask>();

  constructor(private readonly deps: DelegationDeps) {
    deps.store.on('broadcast', this.onBroadcast);
    deps.store.on('agentRemoved', this.onAgentRemoved);
  }

  dispose(): void {
    this.deps.store.off('broadcast', this.onBroadcast);
    this.deps.store.off('agentRemoved', this.onAgentRemoved);
    for (const task of this.tasks.values()) this.wake(task);
    this.tasks.clear();
  }

  // ── Queries ──────────────────────────────────────────────────

  /** Every character, and which agents wear it in the caller's Directory. */
  listCharacters(callerId: number): DelegationResult<{
    directory: string;
    characters: CharacterListing[];
  }> {
    const caller = this.caller(callerId);
    if ('error' in caller) return caller;
    const profiles = this.deps.profiles();
    const characters = profiles.map((p, index): CharacterListing => ({
      name: characterLabel(profiles, index),
      ...(p.launch?.agent ? { role: p.launch.agent } : {}),
      ...(p.launch?.model ? { model: p.launch.model } : {}),
      hasFigmaLink: !!p.launch?.figma,
      inOffice: this.wearers(index, caller.cwd, callerId).map((a) => ({
        agentId: a.id,
        status: this.openTaskTo(a.id)
          ? 'has_task'
          : a.permissionSent
            ? 'needs_permission'
            : a.turnActive
              ? 'working'
              : 'idle',
      })),
    }));
    return { directory: caller.cwd, characters };
  }

  // ── Delegate ─────────────────────────────────────────────────

  /**
   * Hand `taskText` to `character`: typed into an idle agent wearing it in the
   * caller's Directory, else a fresh launch of it there. A character whose
   * agents are all busy is refused (the caller waits, or picks another).
   */
  delegate(
    callerId: number,
    character: string,
    taskText: string,
  ): DelegationResult<{ taskId: string; agentId: number; character: string; launched: boolean }> {
    this.prune();
    const caller = this.caller(callerId);
    if ('error' in caller) return caller;
    const text = cleanTaskText(taskText);
    if (!text) return { error: 'The task is empty.' };
    if (text.length > DELEGATION_TASK_MAX_CHARS) {
      return {
        error: `The task is too long (${text.length} characters, at most ${DELEGATION_TASK_MAX_CHARS}); put the details in a file and point to it.`,
      };
    }
    const profiles = this.deps.profiles();
    const index = resolveCharacter(profiles, character);
    if (typeof index !== 'number') return index;
    const name = characterLabel(profiles, index);
    // The caller is never one of the wearers: a lead wearing the character it
    // names gets another agent of it, never its own terminal typed into.
    const wearers = this.wearers(index, caller.cwd, callerId);
    const idle = wearers.find((a) => !a.turnActive && !a.permissionSent && !this.openTaskTo(a.id));
    if (idle) {
      const session = this.deps.ptyManager.get(idle.id);
      if (!session || session.hasExited) return { error: `${name}'s terminal is gone.` };
      const task = this.open(callerId, idle, name);
      session.write(`\x1b[200~${text}\x1b[201~`);
      setTimeout(() => {
        if (!session.hasExited) session.write('\r');
      }, DELEGATION_SUBMIT_DELAY_MS);
      console.log(`[Pixel Agents] Delegation: agent ${callerId} → ${name} (agent ${idle.id})`);
      return { taskId: task.id, agentId: idle.id, character: name, launched: false };
    }
    if (wearers.length > 0) {
      return {
        error: `${name} is busy (agent ${wearers.map((a) => a.id).join(', ')}). Wait for its current work, or delegate to another character.`,
      };
    }

    const launchedId = this.deps.launch({
      directoryPath: caller.cwd,
      palette: index,
      prompt: text,
    });
    const launched = launchedId === null ? undefined : this.deps.store.get(launchedId);
    if (!launched) return { error: `Could not launch ${name} (see the office server's log).` };
    const task = this.open(callerId, launched, name, 0);
    console.log(
      `[Pixel Agents] Delegation: agent ${callerId} → ${name} (launched agent ${launched.id})`,
    );
    return { taskId: task.id, agentId: launched.id, character: name, launched: true };
  }

  // ── Wait ─────────────────────────────────────────────────────

  /** Wait until the task's turn ends (or `timeoutMs`, capped), then report it. */
  async wait(
    callerId: number,
    taskId: string,
    timeoutMs: number = DELEGATION_WAIT_DEFAULT_MS,
  ): Promise<DelegationResult<TaskReport>> {
    this.prune();
    const task = this.tasks.get(taskId);
    if (!task || task.fromAgentId !== callerId) return { error: `No task ${taskId} of yours.` };
    const limit = Math.min(Math.max(0, timeoutMs), DELEGATION_WAIT_MAX_MS);
    if (!this.finished(task) && limit > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          task.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, limit);
        task.waiters.add(done);
      });
    }
    return this.report(task);
  }

  // ── Internals ────────────────────────────────────────────────

  private caller(callerId: number): DelegationResult<{ cwd: string }> {
    const agent = this.deps.store.get(callerId);
    if (!agent) return { error: 'This session is not an agent in the office.' };
    if (!agent.cwd) {
      return {
        error: 'This agent was not launched from the office; launch it from there to delegate.',
      };
    }
    return { cwd: agent.cwd };
  }

  /** Agents wearing `palette` in `cwd` that the office can type into, the caller excepted. */
  private wearers(palette: number, cwd: string, callerId: number): AgentState[] {
    const out: AgentState[] = [];
    for (const agent of this.deps.store.values()) {
      if (agent.id === callerId || agent.palette !== palette) continue;
      if (!agent.cwd || !samePath(agent.cwd, cwd)) continue;
      const session = this.deps.ptyManager.get(agent.id);
      if (!session || session.hasExited) continue;
      out.push(agent);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  private openTaskTo(agentId: number): DelegatedTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.toAgentId === agentId && !this.finished(task)) return task;
    }
    return undefined;
  }

  private open(
    fromAgentId: number,
    to: AgentState,
    character: string,
    offset?: number,
  ): DelegatedTask {
    const task: DelegatedTask = {
      id: `task-${crypto.randomUUID().slice(0, 8)}`,
      fromAgentId,
      toAgentId: to.id,
      character,
      status: 'starting',
      transcript: to.jsonlFile,
      offset: offset ?? fileSize(to.jsonlFile),
      waiters: new Set(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private finished(task: DelegatedTask): boolean {
    return task.status === 'done' || task.status === 'gone';
  }

  private report(task: DelegatedTask): TaskReport {
    const agent = this.deps.store.get(task.toAgentId);
    return {
      taskId: task.id,
      character: task.character,
      agentId: task.toAgentId,
      status: task.status,
      needsPermission: !this.finished(task) && !!agent?.permissionSent,
      ...(task.reply !== undefined ? { reply: task.reply } : {}),
    };
  }

  private wake(task: DelegatedTask): void {
    for (const waiter of [...task.waiters]) waiter();
  }

  private readonly onBroadcast = (message: Record<string, unknown>): void => {
    const id = message.id;
    if (typeof id !== 'number') return;
    const task = this.openTaskTo(id);
    if (!task) return;
    const type = message.type;
    if (type === 'agentToolStart' || (type === 'agentStatus' && message.status === 'active')) {
      task.status = 'working';
    } else if (type === 'agentToolPermission') {
      this.wake(task); // a waiter learns it needs the user, then waits again
    } else if (type === 'agentStatus' && message.status === 'waiting') {
      // Even while 'starting': with hooks, the turn's end can arrive before the
      // transcript poll has seen the task's prompt (a quick reply). The reply
      // written past the task's start is what tells a real end from a stale one.
      this.finish(task, true);
    }
  };

  private readonly onAgentRemoved = (id: number): void => {
    for (const [taskId, task] of this.tasks) {
      if (task.fromAgentId === id) {
        this.wake(task);
        this.tasks.delete(taskId);
      } else if (task.toAgentId === id && !this.finished(task)) {
        task.status = 'gone';
        task.finishedAt = Date.now();
        this.wake(task);
      }
    }
  };

  /** The turn (may have) ended: read its reply (once more shortly, if the transcript lags). */
  private finish(task: DelegatedTask, retry: boolean): void {
    const agent = this.deps.store.get(task.toAgentId);
    // A /clear moved the agent to a new transcript: the turn is all in that one.
    const transcript = agent?.jsonlFile ?? task.transcript;
    const offset = transcript === task.transcript ? task.offset : 0;
    const reply = this.deps.provider.turnReply?.(transcript, offset);
    if (reply === undefined) {
      if (retry) {
        setTimeout(() => {
          if (!this.finished(task) && this.tasks.has(task.id)) this.finish(task, false);
        }, DELEGATION_REPLY_RETRY_MS);
        return;
      }
      // Nothing written since the task began: a turn that never started ended
      // nothing; one that ran only tools ended without words.
      if (task.status !== 'working') return;
    }
    task.status = 'done';
    task.reply = reply;
    task.finishedAt = Date.now();
    this.wake(task);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (task.finishedAt !== undefined && now - task.finishedAt > DELEGATION_TASK_TTL_MS) {
        this.tasks.delete(id);
      }
    }
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
