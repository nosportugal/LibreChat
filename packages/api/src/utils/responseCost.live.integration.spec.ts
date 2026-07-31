import fetch from 'node-fetch';
import {
  ResponseCostCollector,
  parseResponseCostHeader,
  extractCompletionId,
  LITELLM_COST_HEADER,
} from './responseCost';

const BASE = 'https://litellm.oizys.clg.nos.pt/v1';
const KEY = process.env.LITELLM_OIZYS_API_KEY;

const maybe = KEY ? describe : describe.skip;

maybe('LiteLLM live cost capture (non-streaming)', () => {
  jest.setTimeout(60000);

  it('captures x-litellm-response-cost and correlates by completion id', async () => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-nano',
        messages: [{ role: 'user', content: 'say hi in 3 words' }],
      }),
    });

    expect(res.status).toBe(200);

    // Simulate what createFetch's captureResponseCost does
    const costUSD = parseResponseCostHeader(res.headers.get(LITELLM_COST_HEADER));
    const bodyText = await res.clone().text();
    const id = extractCompletionId(bodyText.slice(0, 512));

    expect(costUSD).toBeGreaterThan(0);
    expect(id).toMatch(/^chatcmpl-/);

    const collector = new ResponseCostCollector();
    collector.record(costUSD!, id);

    // Debit-side: consume by id, convert to credits
    const consumed = collector.consumeById(id);
    expect(consumed).toBe(costUSD);
    const credits = -(consumed! * 1_000_000);
    expect(credits).toBeLessThan(0);
    // eslint-disable-next-line no-console
    console.log(`[live] cost=$${costUSD} id=${id} -> tokenValue=${credits} credits`);
  });
});
