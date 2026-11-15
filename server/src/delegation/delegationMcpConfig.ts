/**
 * The MCP config an office-launched agent starts with, so it can reach the
 * office's delegation tools (`--mcp-config`, Claude Code's own format): one
 * file per agent under ~/.pixel-agents/mcp/, 0600 (it carries the server
 * token), written before the launch and removed when the agent's terminal
 * exits. The endpoint is set once the server listens; before that (and on the
 * VS Code surface, which never sets it) launches carry no MCP server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR } from '../../../core/src/constants.js';
import {
  DELEGATION_MCP_DIR,
  DELEGATION_MCP_PATH,
  DELEGATION_MCP_SERVER_NAME,
} from '../constants.js';

interface Endpoint {
  /** The address the server is reachable at from this machine. */
  host: string;
  port: number;
  token: string;
}

let endpoint: Endpoint | null = null;

/** The server is listening: launches from now on carry the delegation tools. */
export function setDelegationEndpoint(next: Endpoint | null): void {
  endpoint = next;
}

/** The address a local client dials for a server bound to `bindHost`. */
export function localAddressFor(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '' ? '127.0.0.1' : bindHost;
}

function configDir(): string {
  return path.join(os.homedir(), SERVER_JSON_DIR, DELEGATION_MCP_DIR);
}

/** One file per server process and agent: two servers never share a name. */
function configPathFor(agentId: number): string {
  return path.join(configDir(), `agent-${process.pid}-${agentId}.json`);
}

/**
 * Write the agent's MCP config and return what the launch command needs, or
 * undefined when there is no endpoint or the file can't be written (the agent
 * then launches without the tools rather than not at all).
 */
export function delegationMcpServerFor(
  agentId: number,
): { configPath: string; name: string } | undefined {
  if (!endpoint) return undefined;
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host;
  const config = {
    mcpServers: {
      [DELEGATION_MCP_SERVER_NAME]: {
        type: 'http',
        url: `http://${host}:${endpoint.port}${DELEGATION_MCP_PATH}/${agentId}`,
        headers: { Authorization: `Bearer ${endpoint.token}` },
      },
    },
  };
  const configPath = configPathFor(agentId);
  try {
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
  } catch (err) {
    console.warn(`[Pixel Agents] Delegation: could not write ${configPath}: ${String(err)}`);
    return undefined;
  }
  return { configPath, name: DELEGATION_MCP_SERVER_NAME };
}

/** The agent's terminal exited: its config file goes with it. */
export function removeDelegationMcpConfig(agentId: number): void {
  try {
    fs.rmSync(configPathFor(agentId), { force: true });
  } catch {
    /* best effort */
  }
}
