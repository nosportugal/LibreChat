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

/** Minimal node-fetch-like Response stub with a clonable text body. */
function makeResponse(headers: Record<string, string>, body: string) {
  const res = {
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? headers[k] ?? null,
    },
    clone() {
      return { text: async () => body };
    },
  };
  return res;
}

describe('createFetch cost capture', () => {
  beforeEach(() => mockFetch.mockReset());

  it('records cost keyed by completion id from the body', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(
        { 'x-litellm-response-cost': '0.00123' },
        '{"id":"chatcmpl-abc","object":"chat.completion"}',
      ),
    );
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.getById('chatcmpl-abc')).toBe(0.00123);
  });

  it('does nothing when the header is absent', async () => {
    mockFetch.mockResolvedValue(makeResponse({}, '{"id":"chatcmpl-x"}'));
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.size).toBe(0);
  });

  it('ignores an invalid header value (trust boundary)', async () => {
    mockFetch.mockResolvedValue(
      makeResponse({ 'x-litellm-response-cost': '-5' }, '{"id":"chatcmpl-x"}'),
    );
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    expect(collector.size).toBe(0);
  });

  it('returns the original response (does not consume stream body)', async () => {
    const res = makeResponse(
      { 'x-litellm-response-cost': '0.01' },
      '{"id":"chatcmpl-abc"}',
    );
    const cloneSpy = jest.spyOn(res, 'clone');
    mockFetch.mockResolvedValue(res);
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    const out = await fn('http://litellm/v1/chat/completions', {});
    expect(out).toBe(res);
    expect(cloneSpy).toHaveBeenCalled(); // read via clone, original untouched
  });

  it('no collector => no capture, response passthrough', async () => {
    const res = makeResponse({ 'x-litellm-response-cost': '0.01' }, '{"id":"x"}');
    mockFetch.mockResolvedValue(res);
    const fn = createFetch({});
    const out = await fn('http://litellm/v1/chat/completions', {});
    expect(out).toBe(res);
  });
});
