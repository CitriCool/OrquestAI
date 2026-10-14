import { describe, expect, it } from 'vitest';
import { buildContext } from '../../src/server/chat/chatService.js';
import type { Message } from '../../src/shared/schemas.js';

const msg = (i: number, over: Partial<Message> = {}): Message => ({
  id: String(i),
  conversationId: 'c',
  role: i % 2 ? 'assistant' : 'user',
  content: `mensaje ${i}`,
  providerId: null,
  modelId: null,
  status: 'complete',
  errorKind: null,
  errorMessage: null,
  usage: null,
  createdAt: '',
  ...over,
});

describe('construcción del contexto', () => {
  it('limita el número de mensajes enviados y antepone las instrucciones del sistema', () => {
    const ctx = buildContext(Array.from({ length: 50 }, (_, i) => msg(i)));
    expect(ctx[0]!.role).toBe('system');
    expect(ctx.length).toBe(21);
    expect(ctx.at(-1)!.content).toBe('mensaje 49');
  });

  it('excluye respuestas con error o vacías', () => {
    const ctx = buildContext([msg(0), msg(1, { status: 'error', content: 'parcial' }), msg(2, { content: '' })]);
    expect(ctx.map((t) => t.content)).toEqual([expect.any(String), 'mensaje 0']);
  });
});
