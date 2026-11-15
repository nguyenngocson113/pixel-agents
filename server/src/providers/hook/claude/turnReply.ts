/**
 * The reply a Claude session wrote after a point in its transcript: the text of
 * its last main-chain assistant message (Claude Code writes one record per
 * content block, all sharing the message id, so the blocks are joined back).
 * Sidechain records are sub-agents' turns, not the session's own reply.
 */

import * as fs from 'fs';

import { isRecord } from '../../../../../core/src/isRecord.js';

/** Longest reply handed back (characters); a longer one keeps its end. */
export const TURN_REPLY_MAX_CHARS = 20_000;

export function claudeTurnReply(transcript: string, fromOffset: number): string | undefined {
  let text: string;
  try {
    const buf = fs.readFileSync(transcript);
    text = buf.subarray(Math.min(Math.max(0, fromOffset), buf.length)).toString('utf-8');
  } catch {
    return undefined;
  }
  let lastId: string | undefined;
  let blocks: string[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a partial first line (mid-record offset) or a torn last one
    }
    if (!isRecord(record) || record.type !== 'assistant' || record.isSidechain === true) continue;
    const message = record.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    const texts = message.content
      .filter((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text')
      .map((b) => (typeof b.text === 'string' ? b.text : ''))
      .filter((t) => t.trim());
    if (texts.length === 0) continue;
    const id = typeof message.id === 'string' ? message.id : undefined;
    if (id !== undefined && id === lastId) blocks.push(...texts);
    else blocks = texts;
    lastId = id;
  }
  const reply = blocks.join('\n\n').trim();
  if (!reply) return undefined;
  return reply.length > TURN_REPLY_MAX_CHARS
    ? `…${reply.slice(reply.length - TURN_REPLY_MAX_CHARS)}`
    : reply;
}
