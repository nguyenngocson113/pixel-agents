/**
 * Delegation: an office agent hands a task to a character and collects its
 * reply (server/src/delegation/). The service against a real store with fake
 * terminals, the transcript reply reader, the MCP endpoint's JSON-RPC, the
 * per-agent MCP config and the launch flags they become.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CharacterProfile } from '../../core/src/characterProfiles.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  delegationMcpServerFor,
  localAddressFor,
  removeDelegationMcpConfig,
  setDelegationEndpoint,
} from '../src/delegation/delegationMcpConfig.js';
import {
  cleanTaskText,
  DelegationService,
  resolveCharacter,
} from '../src/delegation/delegationService.js';
import { answerMcp } from '../src/delegation/mcpRoute.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTurnReply } from '../src/providers/hook/claude/turnReply.js';
import type { TerminalSession, TerminalSessions } from '../src/terminal/terminalSessions.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-deleg-'));
});

afterEach(() => {
  vi.useRealTimers();
  setDelegationEndpoint(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const assistant = (id: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  }) + '\n';

describe('claudeTurnReply', () => {
  it('reads the last main-chain message after the offset, its blocks joined', () => {
    const file = path.join(tmp, 's.jsonl');
    fs.writeFileSync(file, assistant('m0', 'old reply'));
    const offset = fs.statSync(file).size;
    fs.appendFileSync(
      file,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'do it' } }) +
        '\n' +
        assistant('m1', 'working on it') +
        assistant('s1', 'a sub-agent talking', { isSidechain: true }) +
        assistant('m2', 'Spec written:') +
        assistant('m2', 'docs/design/x.md') +
        '{"torn',
    );
    expect(claudeTurnReply(file, offset)).toBe('Spec written:\n\ndocs/design/x.md');
    expect(claudeTurnReply(file, fs.statSync(file).size)).toBeUndefined();
    expect(claudeTurnReply(path.join(tmp, 'missing.jsonl'), 0)).toBeUndefined();
  });
});

describe('resolveCharacter', () => {
  const profiles = [
    { body: 'flat', name: 'Dress', launch: { agent: 'ux-designer' } },
    { body: 'flat', name: 'Spike', launch: { agent: 'shopify-dev' } },
    { body: 'flat', name: 'Saffron', launch: { agent: 'qc' } },
    { body: 'flat', name: 'Rex', launch: { agent: 'qc' } },
  ] as CharacterProfile[];

  it('takes a name in any case, else a role exactly one character has', () => {
    expect(resolveCharacter(profiles, 'dress')).toBe(0);
    expect(resolveCharacter(profiles, 'shopify-dev')).toBe(1);
    expect(resolveCharacter(profiles, 'qc')).toEqual({
      error: expect.stringContaining('Saffron, Rex'),
    });
    expect(resolveCharacter(profiles, 'Bob')).toEqual({
      error: expect.stringContaining('Characters: Dress, Spike, Saffron, Rex'),
    });
  });
});

describe('cleanTaskText', () => {
  it('drops what a terminal would read as keys, a paste end marker included', () => {
    expect(cleanTaskText('a\r\nb\x1b[201~\x03c\t ')).toBe('a\nb[201~c');
  });
});

// ── The service ────────────────────────────────────────────────

interface FakeSession extends TerminalSession {
  written: string[];
}

function fakeTerminals() {
  const sessions = new Map<number, FakeSession>();
  const add = (agentId: number) => {
    const written: string[] = [];
    const s = {
      agentId,
      pid: 1,
      cols: 80,
      rows: 24,
      hasExited: false,
      written,
      write: (data: string) => void written.push(data),
    } as unknown as FakeSession;
    sessions.set(agentId, s);
    return s;
  };
  const manager = { get: (id: number) => sessions.get(id) } as unknown as TerminalSessions;
  return { manager, add, sessions };
}

const PROFILES = [
  { body: 'flat', name: 'Lead', launch: { agent: 'feature-lead' } },
  { body: 'flat', name: 'Dress', launch: { agent: 'ux-designer' } },
] as CharacterProfile[];

function setup() {
  const store = new AgentStateStore();
  const terms = fakeTerminals();
  const cwd = path.join(tmp, 'project');
  const addAgent = (id: number, palette: number, opts: { cwd?: string } = {}) => {
    const agent = createAgentState({
      id,
      sessionId: `s${id}`,
      isExternal: false,
      projectDir: tmp,
      jsonlFile: path.join(tmp, `s${id}.jsonl`),
    });
    agent.palette = palette;
    agent.cwd = opts.cwd ?? cwd;
    store.set(id, agent);
    terms.add(id);
    return agent;
  };
  const launches: { directoryPath: string; palette: number; prompt: string }[] = [];
  const service = new DelegationService({
    store,
    ptyManager: terms.manager,
    provider: claudeProvider,
    profiles: () => PROFILES,
    launch: (opts) => {
      launches.push(opts);
      addAgent(50, opts.palette, { cwd: opts.directoryPath });
      return 50;
    },
  });
  return { store, terms, cwd, addAgent, launches, service };
}

describe('DelegationService', () => {
  it('types the task into an idle agent of the character, then reports its reply', async () => {
    vi.useFakeTimers();
    const { store, terms, addAgent, service } = setup();
    addAgent(1, 0);
    const dress = addAgent(2, 1);
    fs.writeFileSync(dress.jsonlFile, assistant('m0', 'an earlier turn'));

    const result = service.delegate(1, 'Dress', 'Write the spec.');
    expect(result).toMatchObject({ agentId: 2, character: 'Dress', launched: false });
    if ('error' in result) throw new Error(result.error);
    expect(terms.sessions.get(2)!.written).toEqual(['\x1b[200~Write the spec.\x1b[201~']);
    vi.advanceTimersByTime(200);
    expect(terms.sessions.get(2)!.written[1]).toBe('\r');

    // Busy while the task is open.
    expect(service.delegate(1, 'Dress', 'again')).toEqual({
      error: expect.stringContaining('busy'),
    });

    const waiting = service.wait(1, result.taskId, 60_000);
    store.broadcast({ type: 'agentStatus', id: 2, status: 'active' });
    fs.appendFileSync(dress.jsonlFile, assistant('m1', 'Done: docs/design/x.md'));
    store.broadcast({ type: 'agentStatus', id: 2, status: 'waiting' });
    await expect(waiting).resolves.toMatchObject({
      status: 'done',
      reply: 'Done: docs/design/x.md',
      needsPermission: false,
    });
    // Another agent can't read someone else's task.
    expect(await service.wait(2, result.taskId, 0)).toEqual({ error: expect.any(String) });
  });

  it('a turn end that beats the prompt poll still finishes the task', async () => {
    const { store, addAgent, service } = setup();
    addAgent(1, 0);
    const dress = addAgent(2, 1);
    const r = service.delegate(1, 'Dress', 'Quick question');
    if ('error' in r) throw new Error(r.error);
    fs.writeFileSync(dress.jsonlFile, assistant('m1', 'Yes.'));
    store.broadcast({ type: 'agentStatus', id: 2, status: 'waiting' });
    expect(await service.wait(1, r.taskId, 0)).toMatchObject({ status: 'done', reply: 'Yes.' });
  });

  it('a stale turn end with nothing written leaves the task starting', async () => {
    vi.useFakeTimers();
    const { store, addAgent, service } = setup();
    addAgent(1, 0);
    addAgent(2, 1);
    const r = service.delegate(1, 'Dress', 'x');
    if ('error' in r) throw new Error(r.error);
    store.broadcast({ type: 'agentStatus', id: 2, status: 'waiting' });
    vi.advanceTimersByTime(1_000);
    expect(await service.wait(1, r.taskId, 0)).toMatchObject({ status: 'starting' });
  });

  it('launches the character in the caller’s Directory when none is there', () => {
    const { cwd, addAgent, launches, service } = setup();
    addAgent(1, 0);
    addAgent(9, 1, { cwd: path.join(tmp, 'elsewhere') }); // a Dress in another Directory
    expect(service.delegate(1, 'ux-designer', 'Spec it')).toMatchObject({
      agentId: 50,
      launched: true,
    });
    expect(launches).toEqual([{ directoryPath: cwd, palette: 1, prompt: 'Spec it' }]);
  });

  it('refuses busy characters, unknown callers and agents the office didn’t launch', () => {
    const { addAgent, service, store } = setup();
    addAgent(1, 0);
    addAgent(2, 1).turnActive = true;
    expect(service.delegate(1, 'Dress', 'x')).toEqual({ error: expect.stringContaining('busy') });
    expect(service.delegate(77, 'Dress', 'x')).toEqual({ error: expect.any(String) });
    store.get(1)!.cwd = undefined;
    expect(service.delegate(1, 'Dress', 'x')).toEqual({
      error: expect.stringContaining('not launched from the office'),
    });
  });

  it('a task whose agent leaves is gone', async () => {
    const { store, addAgent, service } = setup();
    addAgent(1, 0);
    addAgent(2, 1);
    const r = service.delegate(1, 'Dress', 'x');
    if ('error' in r) throw new Error(r.error);
    const waiting = service.wait(1, r.taskId, 60_000);
    store.delete(2);
    await expect(waiting).resolves.toMatchObject({ status: 'gone' });
  });

  it('lists characters with who wears them here', () => {
    const { addAgent, service } = setup();
    addAgent(1, 0);
    addAgent(2, 1).permissionSent = true;
    const list = service.listCharacters(1);
    if ('error' in list) throw new Error(list.error);
    expect(list.characters).toEqual([
      { name: 'Lead', role: 'feature-lead', hasFigmaLink: false, inOffice: [] },
      {
        name: 'Dress',
        role: 'ux-designer',
        hasFigmaLink: false,
        inOffice: [{ agentId: 2, status: 'needs_permission' }],
      },
    ]);
  });
});

// ── The MCP endpoint ───────────────────────────────────────────

describe('answerMcp', () => {
  it('initializes, lists the three tools and calls them', async () => {
    const { addAgent, service } = setup();
    addAgent(1, 0);
    const init = await answerMcp(service, 1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect(init).toMatchObject({
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
    });
    expect(
      await answerMcp(service, 1, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeNull();
    const list = (await answerMcp(service, 1, { jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'list_characters',
      'delegate_task',
      'wait_for_task',
    ]);
    const call = await answerMcp(service, 1, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'delegate_task', arguments: { character: 'Nobody', task: 'x' } },
    });
    expect(call).toMatchObject({ result: { isError: true } });
    expect(await answerMcp(service, 1, { jsonrpc: '2.0', id: 4, method: 'nope' })).toMatchObject({
      error: { code: -32601 },
    });
    expect(await answerMcp(service, 1, { hello: 1 })).toMatchObject({ error: { code: -32600 } });
  });
});

// ── Launch: config file + flags ────────────────────────────────

describe('the delegation MCP config and launch flags', () => {
  it('writes a private per-agent config only once the endpoint is known', () => {
    expect(delegationMcpServerFor(3)).toBeUndefined();
    setDelegationEndpoint({ host: localAddressFor('0.0.0.0'), port: 4321, token: 'tok' });
    const mcp = delegationMcpServerFor(3)!;
    expect(mcp.name).toBe('pixel-agents');
    const config = JSON.parse(fs.readFileSync(mcp.configPath, 'utf-8'));
    expect(config.mcpServers['pixel-agents']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4321/api/mcp/3',
      headers: { Authorization: 'Bearer tok' },
    });
    if (process.platform !== 'win32') expect(fs.statSync(mcp.configPath).mode & 0o777).toBe(0o600);
    removeDelegationMcpConfig(3);
    expect(fs.existsSync(mcp.configPath)).toBe(false);
  });

  it('puts the prompt right after the session flag and the MCP flags last', () => {
    const args = claudeProvider.buildLaunchCommand!('sid', '/w', {
      agent: 'qc',
      prompt: '-v check it',
      mcpServer: { configPath: '/c.json', name: 'pixel-agents' },
    }).args;
    expect(args).toEqual([
      '--session-id',
      'sid',
      'Task: -v check it',
      '--agent',
      'qc',
      '--mcp-config',
      '/c.json',
      '--allowedTools',
      'mcp__pixel-agents',
    ]);
  });
});
