import {
  ResponseCostCollector,
  parseResponseCostHeader,
  extractCompletionId,
  runWithResponseCostCollector,
  getResponseCostCollector,
} from './responseCost';

describe('parseResponseCostHeader', () => {
  it('parses a valid decimal cost', () => {
    expect(parseResponseCostHeader('0.00123')).toBe(0.00123);
  });

  it('parses zero', () => {
    expect(parseResponseCostHeader('0')).toBe(0);
  });

  it('returns undefined for null/empty', () => {
    expect(parseResponseCostHeader(null)).toBeUndefined();
    expect(parseResponseCostHeader(undefined)).toBeUndefined();
    expect(parseResponseCostHeader('')).toBeUndefined();
  });

  it('returns undefined for non-numeric or negative (trust boundary)', () => {
    expect(parseResponseCostHeader('NaN')).toBeUndefined();
    expect(parseResponseCostHeader('abc')).toBeUndefined();
    expect(parseResponseCostHeader('-0.5')).toBeUndefined();
    expect(parseResponseCostHeader('Infinity')).toBeUndefined();
  });
});

describe('extractCompletionId', () => {
  it('extracts id from a non-streaming JSON body', () => {
    expect(extractCompletionId('{"id":"chatcmpl-abc123","object":"chat.completion"}')).toBe(
      'chatcmpl-abc123',
    );
  });

  it('extracts id from an SSE data line', () => {
    const sse = 'data: {"id":"chatcmpl-xyz","choices":[]}\n\n';
    expect(extractCompletionId(sse)).toBe('chatcmpl-xyz');
  });

  it('returns undefined when no id present', () => {
    expect(extractCompletionId('{"object":"chat.completion"}')).toBeUndefined();
    expect(extractCompletionId('')).toBeUndefined();
    expect(extractCompletionId(null)).toBeUndefined();
  });
});

describe('ResponseCostCollector', () => {
  it('records and looks up cost by completion id', () => {
    const c = new ResponseCostCollector();
    c.record(0.0012, 'chatcmpl-1');
    c.record(0.0034, 'chatcmpl-2');
    expect(c.getById('chatcmpl-1')).toBe(0.0012);
    expect(c.getById('chatcmpl-2')).toBe(0.0034);
    expect(c.size).toBe(2);
  });

  it('ignores invalid costs', () => {
    const c = new ResponseCostCollector();
    c.record(NaN, 'a');
    c.record(-1, 'b');
    expect(c.getById('a')).toBeUndefined();
    expect(c.getById('b')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('returns undefined for unknown id', () => {
    const c = new ResponseCostCollector();
    c.record(0.01, 'known');
    expect(c.getById('unknown')).toBeUndefined();
    expect(c.getById(undefined)).toBeUndefined();
  });

  it('consumeById removes the cost so it cannot be billed twice', () => {
    const c = new ResponseCostCollector();
    c.record(0.05, 'chatcmpl-1');
    expect(c.consumeById('chatcmpl-1')).toBe(0.05);
    expect(c.consumeById('chatcmpl-1')).toBeUndefined();
    expect(c.getById('chatcmpl-1')).toBeUndefined();
  });

  it('consumeById returns undefined for unknown/undefined id', () => {
    const c = new ResponseCostCollector();
    expect(c.consumeById('nope')).toBeUndefined();
    expect(c.consumeById(undefined)).toBeUndefined();
  });
});

describe('responseCostStorage ALS', () => {
  it('exposes the collector to the ambient context', () => {
    const c = new ResponseCostCollector();
    expect(getResponseCostCollector()).toBeUndefined();
    runWithResponseCostCollector(c, () => {
      expect(getResponseCostCollector()).toBe(c);
    });
    expect(getResponseCostCollector()).toBeUndefined();
  });

  it('propagates across async boundaries within the run', async () => {
    const c = new ResponseCostCollector();
    await runWithResponseCostCollector(c, async () => {
      await Promise.resolve();
      c.record(0.02, 'chatcmpl-async');
      expect(getResponseCostCollector()?.getById('chatcmpl-async')).toBe(0.02);
    });
  });

  it('isolates concurrent contexts', async () => {
    const a = new ResponseCostCollector();
    const b = new ResponseCostCollector();
    await Promise.all([
      runWithResponseCostCollector(a, async () => {
        await Promise.resolve();
        expect(getResponseCostCollector()).toBe(a);
      }),
      runWithResponseCostCollector(b, async () => {
        await Promise.resolve();
        expect(getResponseCostCollector()).toBe(b);
      }),
    ]);
  });
});
