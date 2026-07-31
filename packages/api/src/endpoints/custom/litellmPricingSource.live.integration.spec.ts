jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));

import { fetchProxyModelInfo, resolveLiteLLMPricing } from './litellmPricing';

const BASE = 'https://litellm.oizys.clg.nos.pt/v1';
const KEY = process.env.LITELLM_OIZYS_API_KEY;
const maybe = KEY ? describe : describe.skip;

maybe('LiteLLM proxy pricing source (live)', () => {
  jest.setTimeout(60000);

  it('loads CUSTOM prices from the proxy /v1/model/info', async () => {
    const out = await fetchProxyModelInfo(BASE, KEY!);
    expect(out).toBeDefined();
    // Custom-priced models present on the proxy but not in the public map
    expect(out!['gpt-5.6-luna']?.completion).toBeGreaterThan(0);
    expect(out!['gpt-5-nano']?.prompt).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `[live] proxy custom prices: ${Object.keys(out!).length} models; ` +
        `gpt-5.6-luna in=${out!['gpt-5.6-luna']?.prompt}/1M out=${out!['gpt-5.6-luna']?.completion}/1M`,
    );
  });

  it('resolveLiteLLMPricing prefers proxy custom pricing over the public map', async () => {
    const out = await resolveLiteLLMPricing(BASE, KEY!);
    expect(out).toBeDefined();
    // gpt-5.6-luna custom price on this proxy is $1/1M in, $6/1M out —
    // distinct from the public map's default rates.
    expect(out!['gpt-5.6-luna']?.prompt).toBeCloseTo(1);
    expect(out!['gpt-5.6-luna']?.completion).toBeCloseTo(6);
  });
});
