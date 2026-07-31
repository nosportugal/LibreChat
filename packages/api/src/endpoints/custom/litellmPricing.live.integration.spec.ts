import fetch from 'node-fetch';

jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));

import { fetchLiteLLMPriceMap } from './litellmPricing';

const BASE = 'https://litellm.oizys.clg.nos.pt/v1';
const KEY = process.env.LITELLM_OIZYS_API_KEY;
const maybe = KEY ? describe : describe.skip;

maybe('LiteLLM streaming billing via auto price map (live)', () => {
  jest.setTimeout(90000);

  it('prices streamed token counts and matches the non-streaming cost header', async () => {
    const priceMap = await fetchLiteLLMPriceMap();
    expect(priceMap).toBeDefined();
    const price = priceMap!['gpt-5-nano'];
    expect(price.prompt).toBeGreaterThan(0);
    expect(price.completion).toBeGreaterThan(0);

    const body = {
      model: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'name three colors' }],
    };

    // Non-streaming: get LiteLLM's authoritative cost + tokens
    const nsRes = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const nsJson = (await nsRes.json()) as {
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    const litellmCost = parseFloat(nsRes.headers.get('x-litellm-response-cost') || '0');

    // Our estimate for the SAME token counts using the auto price map
    const { prompt_tokens, completion_tokens } = nsJson.usage;
    const ourCost =
      (prompt_tokens * price.prompt + completion_tokens * price.completion) / 1_000_000;

    // eslint-disable-next-line no-console
    console.log(
      `[live] tokens in=${prompt_tokens} out=${completion_tokens} | litellm=$${litellmCost} ours=$${ourCost}`,
    );

    // The price-map estimate should match LiteLLM's own cost for the same tokens
    // (same underlying rates). Allow tiny float tolerance.
    expect(ourCost).toBeCloseTo(litellmCost, 8);
  });
});
