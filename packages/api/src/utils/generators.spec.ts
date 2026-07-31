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
  const lower: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  const res = {
    headers: {
      get: (k: string) => lower[k.toLowerCase()] ?? null,
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

  it('does not read a streaming body (records cost without id, never clones)', async () => {
    const res = makeResponse(
      { 'x-litellm-response-cost': '0.02', 'content-type': 'text/event-stream' },
      'data: {"id":"chatcmpl-stream"}\n\n',
    );
    const cloneSpy = jest.spyOn(res, 'clone');
    mockFetch.mockResolvedValue(res);
    const collector = new ResponseCostCollector();
    const fn = createFetch({ costCollector: collector });
    await fn('http://litellm/v1/chat/completions', {});
    // cost recorded (size 1) but not keyed by id, and stream body never read
    expect(collector.size).toBe(1);
    expect(collector.getById('chatcmpl-stream')).toBeUndefined();
    expect(cloneSpy).not.toHaveBeenCalled();
  });
});
