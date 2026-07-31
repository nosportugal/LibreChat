import { Readable } from 'stream';
import { ResponseCostCollector } from './responseCost';

const mockFetch = jest.fn();
jest.mock('node-fetch', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/agents', () => ({ GraphEvents: {}, sleep: jest.fn() }));

import { createFetch } from './generators';

/** node-fetch-like Response stub. JSON bodies are readable via clone().text();
 *  stream bodies (content-type text/event-stream) via clone().body. */
function makeResponse(headers: Record<string, string>, body: string) {
  const lower: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  const isStream = (lower['content-type'] ?? '').includes('event-stream');
  const res = {
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    clone() {
      return {
        text: async () => body,
        get body() {
          return isStream ? Readable.from([body]) : null;
        },
      };
    },
  };
  return res;
}

describe('createFetch cost capture', () => {
  beforeEach(() => mockFetch.mockReset());

  it('records cost + model id keyed by completion id from a JSON body', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        { 'x-litellm-response-cost': '0.00123', 'x-litellm-model-id': 'deploy-1' },
        '{"id":"chatcmpl-abc","object":"chat.completion"}',
      ),
    );
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.getById('chatcmpl-abc')).toEqual({ costUSD: 0.00123, modelId: 'deploy-1' });
  });

  it('does nothing when neither cost nor model id header is present', async () => {
    mockFetch.mockResolvedValue(makeResponse({}, '{"id":"chatcmpl-x"}'));
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.size).toBe(0);
  });

  it('ignores an invalid cost but still records the model id', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        { 'x-litellm-response-cost': '-5', 'x-litellm-model-id': 'deploy-2' },
        '{"id":"chatcmpl-x"}',
      ),
    );
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.getById('chatcmpl-x')).toEqual({ modelId: 'deploy-2' });
  });

  it('returns the original response object (never the clone)', async () => {
    const res = makeResponse({ 'x-litellm-response-cost': '0.01' }, '{"id":"chatcmpl-abc"}');
    mockFetch.mockResolvedValue(res);
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    const out = await fn('http://litellm/v1/chat/completions', {});
    expect(out).toBe(res);
  });

  it('no collector => no capture, response passthrough', async () => {
    const res = makeResponse({ 'x-litellm-response-cost': '0.01' }, '{"id":"x"}');
    mockFetch.mockResolvedValue(res);
    const fn = createFetch({});
    const out = await fn('http://litellm/v1/chat/completions', {});
    expect(out).toBe(res);
  });

  it('streaming: reads only the first-chunk id from a clone and records model id', async () => {
    const res = makeResponse(
      { 'x-litellm-model-id': 'deploy-routed', 'content-type': 'text/event-stream' },
      'data: {"id":"chatcmpl-stream","choices":[]}\n\ndata: {"id":"chatcmpl-stream","choices":[{"delta":{}}]}\n\n',
    );
    mockFetch.mockResolvedValue(res);
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.getById('chatcmpl-stream')).toEqual({ modelId: 'deploy-routed' });
  });
});
