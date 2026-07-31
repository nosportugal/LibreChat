jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));

import { fetchProxyModelInfo, resolveLiteLLMPricing } from './litellmPricing';

const BASE = 'https://litellm.oizys.clg.nos.pt/v1';
const KEY = process.env.LITELLM_OIZYS_API_KEY;
const maybe = KEY ? describe : describe.skip;

maybe('LiteLLM proxy pricing source (live)', () => {
  jest.setTimeout(60000);

  it('returns undefined when /model/info is forbidden for the key', async () => {
    const out = await fetchProxyModelInfo(BASE, KEY!);
    // This key is restricted to llm_api_routes -> /model/info is 403
    expect(out).toBeUndefined();
  });

  it('resolveLiteLLMPricing falls back to the public map and covers gpt-5-nano', async () => {
    const out = await resolveLiteLLMPricing(BASE, KEY!);
    expect(out).toBeDefined();
    expect(out!['gpt-5-nano']?.prompt).toBeGreaterThan(0);
  });
});
