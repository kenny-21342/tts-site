import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RewriteError, rewriteForShanghai } from '../lib/shanghai-rewrite.ts';

test('sends the complete text to the configured chat model and returns its wording', async () => {
  let input: Record<string, unknown> = {};
  const result = await rewriteForShanghai('我去学校。', 4000, {
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://opencode.ai/zen/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
      input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: '我去学堂。' } }] });
    },
  });
  assert.equal(input.model, 'test-model');
  assert.deepEqual((input.messages as Array<{ content: string }>)[1], {
    role: 'user', content: '我去学校。',
  });
  assert.equal(result, '我去学堂。');
});

test('rejects empty or oversized model output', async () => {
  for (const content of ['', '123456']) {
    await assert.rejects(
      rewriteForShanghai('学校', 5, {
        apiKey: 'test-key',
        fetchImpl: async () => Response.json({ choices: [{ message: { content } }] }),
      }),
      RewriteError,
    );
  }
});

test('reports upstream throttling without echoing upstream response text', async () => {
  await assert.rejects(
    rewriteForShanghai('学校', 4000, {
      apiKey: 'test-key',
      fetchImpl: async () => new Response('private upstream detail', { status: 429 }),
    }),
    (error: unknown) => error instanceof RewriteError && error.status === 429 &&
      !error.message.includes('private upstream detail'),
  );
});

test('uses OpenRouter free-model API when selected', async () => {
  const result = await rewriteForShanghai('学校', 4000, {
    provider: 'openrouter',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      const body = JSON.parse(String(init?.body)) as { model: string };
      assert.equal(body.model, 'openrouter/free');
      return Response.json({ choices: [{ message: { content: '学堂' } }] });
    },
  });
  assert.equal(result, '学堂');
});

test('explains why an OpenCode free-tier key fails on the site', async () => {
  await assert.rejects(
    rewriteForShanghai('学校', 4000, {
      provider: 'opencode',
      apiKey: 'test-key',
      fetchImpl: async () => Response.json({
        error: { message: "OpenCode's free tier can only be used from within OpenCode" },
      }, { status: 403 }),
    }),
    (error: unknown) => error instanceof RewriteError && error.message.includes('OPENROUTER_API_KEY'),
  );
});

test('calls a configured OpenAI-compatible endpoint with the selected model', async () => {
  for (const baseUrl of ['https://example.test/v1', 'https://example.test/v1/chat/completions']) {
    const result = await rewriteForShanghai('我去学校。', 4000, {
      provider: 'custom',
      baseUrl,
      apiKey: 'test-key',
      model: 'gpt-5.6-sol',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://example.test/v1/chat/completions');
        const body = JSON.parse(String(init?.body)) as { model: string };
        assert.equal(body.model, 'gpt-5.6-sol');
        return Response.json({ choices: [{ message: { content: '我去学堂。' } }] });
      },
    });
    assert.equal(result, '我去学堂。');
  }
});
