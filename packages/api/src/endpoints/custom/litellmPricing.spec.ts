jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));

import { convertLiteLLMPriceMap, convertModelInfoResponse } from './litellmPricing';

describe('convertLiteLLMPriceMap', () => {
  it('converts per-token costs to per-1M rates', () => {
    const out = convertLiteLLMPriceMap({
      'gpt-5-nano': {
        input_cost_per_token: 5e-8,
        output_cost_per_token: 4e-7,
        cache_read_input_token_cost: 5e-9,
        max_input_tokens: 272000,
      },
    });
    const c = out['gpt-5-nano'];
    expect(c.prompt).toBeCloseTo(0.05);
    expect(c.completion).toBeCloseTo(0.4);
    expect(c.read).toBeCloseTo(0.005);
    expect(c.context).toBe(272000);
  });

  it('includes cache write cost when present', () => {
    const out = convertLiteLLMPriceMap({
      'claude-x': {
        input_cost_per_token: 3e-6,
        output_cost_per_token: 15e-6,
        cache_creation_input_token_cost: 3.75e-6,
        cache_read_input_token_cost: 3e-7,
        max_tokens: 200000,
      },
    });
    expect(out['claude-x'].write).toBeCloseTo(3.75);
    expect(out['claude-x'].read).toBeCloseTo(0.3);
    expect(out['claude-x'].context).toBe(200000);
  });

  it('skips sample_spec and entries without any cost', () => {
    const out = convertLiteLLMPriceMap({
      sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1 },
      'no-price': { max_tokens: 1000 },
      'ok': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    });
    expect(out.sample_spec).toBeUndefined();
    expect(out['no-price']).toBeUndefined();
    expect(out.ok).toBeDefined();
  });

  it('defaults missing output/context to 0', () => {
    const out = convertLiteLLMPriceMap({
      'input-only': { input_cost_per_token: 1e-6 },
    });
    expect(out['input-only']).toEqual({ prompt: 1, completion: 0, context: 0 });
  });
});

describe('convertModelInfoResponse (proxy custom pricing)', () => {
  it('keys per-1M config by model_name from model_info', () => {
    const out = convertModelInfoResponse({
      data: [
        {
          model_name: 'gpt-5-nano',
          model_info: {
            input_cost_per_token: 5e-8,
            output_cost_per_token: 4e-7,
            max_input_tokens: 272000,
          },
        },
      ],
    });
    expect(out['gpt-5-nano'].prompt).toBeCloseTo(0.05);
    expect(out['gpt-5-nano'].completion).toBeCloseTo(0.4);
    expect(out['gpt-5-nano'].context).toBe(272000);
  });

  it('reflects custom (overridden) prices as-is', () => {
    // a proxy margin/override: higher than upstream
    const out = convertModelInfoResponse({
      data: [
        { model_name: 'gpt-5-nano', model_info: { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 } },
      ],
    });
    expect(out['gpt-5-nano'].prompt).toBeCloseTo(1);
    expect(out['gpt-5-nano'].completion).toBeCloseTo(5);
  });

  it('skips entries without a name or usable price', () => {
    const out = convertModelInfoResponse({
      data: [
        { model_info: { input_cost_per_token: 1e-6 } },
        { model_name: 'no-price', model_info: { max_tokens: 1000 } },
        { model_name: 'ok', model_info: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } },
      ],
    });
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('handles empty/missing data', () => {
    expect(convertModelInfoResponse({})).toEqual({});
    expect(convertModelInfoResponse({ data: [] })).toEqual({});
  });
});
