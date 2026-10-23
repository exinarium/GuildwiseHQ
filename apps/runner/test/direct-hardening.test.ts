import { describe, expect, it } from 'vitest';
import { MODEL_LIST_MAX_BYTES, ModelLister } from '../src/direct/models.ts';
import { validateBaseUrl } from '../src/direct/store.ts';
import { capToolResult, TOOL_RESULT_MAX_CHARS } from '../src/direct/tools.ts';

const cfg = { id: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1/v1', models: [] };

describe('direct-model hardening', () => {
  it('warns about plain http away from this machine, not about loopback or https', () => {
    expect(validateBaseUrl('http://10.0.0.5:11434/v1')).toMatchObject({
      ok: true,
      warning: expect.any(String),
    });
    expect(validateBaseUrl('http://example.com/v1')).toMatchObject({ ok: true, warning: expect.any(String) });
    for (const u of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:1234/v1',
      'https://api.example.com/v1',
    ])
      expect(validateBaseUrl(u)).not.toHaveProperty('warning');
    expect(validateBaseUrl('http://u:p@host/v1').ok).toBe(false);
  });

  it('shares one request between concurrent refreshes', async () => {
    let calls = 0;
    const lister = new ModelLister({
      fetch: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      },
    });
    const [a, b, c] = await Promise.all([
      lister.refresh(cfg, true),
      lister.refresh(cfg, true),
      lister.refresh(cfg),
    ]);
    expect(calls).toBe(1);
    expect(a.ids).toEqual(['m1']);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('does not read an oversized model list', async () => {
    const big = `{"data":[{"id":"${'x'.repeat(MODEL_LIST_MAX_BYTES)}"}]}`;
    const lister = new ModelLister({ fetch: async () => new Response(big, { status: 200 }) });
    const r = await lister.refresh(cfg, true);
    expect(r.ids).toEqual([]);
    expect(r.problem).toMatch(/too large/);
  });

  it('cuts a tool result to a size the model can take and says so', () => {
    const t = capToolResult('y'.repeat(TOOL_RESULT_MAX_CHARS + 500));
    expect(t.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 100);
    expect(t).toContain('500 more characters');
    expect(capToolResult('short')).toBe('short');
  });
});
