import fetch from 'node-fetch';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));

import { fetchProxyModelInfo } from './litellmPricing';

const BASE = 'https://litellm.oizys.clg.nos.pt/v1';
const KEY = process.env.LITELLM_OIZYS_API_KEY;
const maybe = KEY ? describe : describe.skip;

maybe('LiteLLM auto-router pricing (live)', () => {
  jest.setTimeout(90000);

  it('prices a router alias by the routed deployment id from x-litellm-model-id', async () => {
    const config = await fetchProxyModelInfo(BASE, KEY!);
    expect(config).toBeDefined();

    // The auto-router alias is priced 0 in its own model_info
    expect(config!['auto-nos-gpt']?.prompt ?? 0).toBe(0);

    // Fire a real request to the router; capture the routed model id header
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto-nos-gpt',
        messages: [{ role: 'user', content: 'write a haiku about the sea' }],
      }),
    });
    const routedId = res.headers.get('x-litellm-model-id') ?? undefined;
    const litellmCost = parseFloat(res.headers.get('x-litellm-response-cost') || '0');
    const json = (await res.json()) as {
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number };
    };

    // The body reports the ALIAS, not the served model
    expect(json.model).toBe('auto-nos-gpt');
    expect(routedId).toBeTruthy();

    // The routed deployment id IS priced in the config (real model)
    const routedPrice = config![routedId!];
    expect(routedPrice).toBeDefined();
    expect((routedPrice.prompt ?? 0) + (routedPrice.completion ?? 0)).toBeGreaterThan(0);

    // Our estimate using the routed price matches LiteLLM's own cost
    const { prompt_tokens, completion_tokens } = json.usage;
    const ourCost =
      (prompt_tokens * routedPrice.prompt + completion_tokens * routedPrice.completion) / 1_000_000;

    // eslint-disable-next-line no-console
    console.log(
      `[live] router alias=auto-nos-gpt -> routedId=${routedId} | tokens ${prompt_tokens}/${completion_tokens} | litellm=$${litellmCost} ours=$${ourCost}`,
    );
    expect(ourCost).toBeCloseTo(litellmCost, 6);
  });
});
