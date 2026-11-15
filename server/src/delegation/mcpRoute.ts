/**
 * The office's MCP server (Streamable HTTP, JSON responses only, no sessions):
 * POST /api/mcp/:agentId, Bearer-authenticated with the server token. The id
 * in the path is the calling agent — each office-launched agent's config names
 * its own (delegationMcpConfig.ts). Three tools, all DelegationService:
 * list_characters, delegate_task, wait_for_task.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { isRecord } from '../../../core/src/isRecord.js';
import { DELEGATION_MCP_PATH, DELEGATION_MCP_SERVER_NAME } from '../constants.js';
import type { DelegationResult, DelegationService } from './delegationService.js';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'list_characters',
    description:
      'List the office characters you can delegate to: each one’s name, role (the agent definition it launches as), model, whether it carries a Figma link, and the agents wearing it in your Directory right now with their status (idle, working, needs_permission, has_task).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delegate_task',
    description:
      'Hand a task to an office character. It goes to an idle agent wearing that character in your Directory, typed into its terminal, or to a new agent of it launched with the task as its first prompt (with the character’s role, model and Figma link). Refused while all its agents are busy. The character starts with none of your context: write a complete brief (goal, file paths such as the spec, links, what to report back). Returns a taskId for wait_for_task.',
    inputSchema: {
      type: 'object',
      properties: {
        character: {
          type: 'string',
          description: 'The character’s name (or a role exactly one character has).',
        },
        task: { type: 'string', description: 'The complete brief, as you would type it to them.' },
      },
      required: ['character', 'task'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_task',
    description:
      'Wait for a delegated task to finish (the character’s turn ends), up to timeoutSeconds (at most 120); call again while status is starting or working. status done carries the character’s last reply. needsPermission = it is stopped on a permission prompt the user must answer in its terminal: tell the user, then keep waiting. gone = its agent left the office.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: 120 },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
] as const;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === '2.0' && typeof value.method === 'string';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function toolResult<T>(result: DelegationResult<T>): ToolResult {
  if (isRecord(result) && typeof result.error === 'string') {
    return { content: [{ type: 'text', text: result.error }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/** One tools/call, answered as a tool result (a bad argument included). */
export async function callTool(
  service: DelegationService,
  agentId: number,
  name: unknown,
  args: unknown,
): Promise<ToolResult> {
  const a = isRecord(args) ? args : {};
  switch (name) {
    case 'list_characters':
      return toolResult(service.listCharacters(agentId));
    case 'delegate_task':
      if (typeof a.character !== 'string' || typeof a.task !== 'string') {
        return toolResult({ error: 'delegate_task needs character and task (strings).' });
      }
      return toolResult(service.delegate(agentId, a.character, a.task));
    case 'wait_for_task': {
      if (typeof a.taskId !== 'string') return toolResult({ error: 'wait_for_task needs taskId.' });
      const seconds = typeof a.timeoutSeconds === 'number' ? a.timeoutSeconds : undefined;
      return toolResult(
        await service.wait(agentId, a.taskId, seconds === undefined ? undefined : seconds * 1000),
      );
    }
    default:
      return toolResult({ error: `Unknown tool ${String(name)}.` });
  }
}

/** One JSON-RPC message's answer, or null for a notification. */
export async function answerMcp(
  service: DelegationService,
  agentId: number,
  message: unknown,
): Promise<Record<string, unknown> | null> {
  if (!isJsonRpcRequest(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (message.id === undefined || message.id === null) return null; // a notification
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: DELEGATION_MCP_SERVER_NAME,
          version: process.env.PIXEL_AGENTS_VERSION ?? '0.0.0',
        },
        instructions:
          'Delegate work to the characters in this Pixel Agents office: list_characters, then delegate_task, then wait_for_task until done.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      return reply(await callTool(service, agentId, params.name, params.arguments));
    default:
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      };
  }
}

export function registerMcpRoute(
  app: FastifyInstance,
  service: DelegationService,
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const params = {
    type: 'object',
    properties: { agentId: { type: 'string', pattern: '^[0-9]{1,9}$' } },
    required: ['agentId'],
  };
  app.post<{ Params: { agentId: string }; Body: unknown }>(
    `${DELEGATION_MCP_PATH}/:agentId`,
    { preHandler: auth, schema: { params } },
    async (request, reply) => {
      const agentId = Number(request.params.agentId);
      const body = request.body;
      if (Array.isArray(body)) {
        const answers = (await Promise.all(body.map((m) => answerMcp(service, agentId, m)))).filter(
          (a) => a !== null,
        );
        if (answers.length === 0) return reply.code(202).send();
        return reply.type('application/json').send(answers);
      }
      const answer = await answerMcp(service, agentId, body);
      if (answer === null) return reply.code(202).send();
      return reply.type('application/json').send(answer);
    },
  );
  // No server-to-client stream and no sessions to end.
  app.get(`${DELEGATION_MCP_PATH}/:agentId`, { preHandler: auth }, async (_req, reply) =>
    reply.code(405).header('Allow', 'POST').send(),
  );
  app.delete(`${DELEGATION_MCP_PATH}/:agentId`, { preHandler: auth }, async (_req, reply) =>
    reply.code(405).header('Allow', 'POST').send(),
  );
}
