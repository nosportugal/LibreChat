jest.mock('@librechat/data-schemas', () => ({ CANCEL_RATE: 1.15, logger: { error: jest.fn() } }));

import type { EndpointTokenConfig } from '~/types/tokens';
import { pickPricingModel } from './usage';

const cfg: EndpointTokenConfig = {
  // A router/auto alias priced 0 (billing would leak without the fix)
  'auto-nos-gpt': { prompt: 0, completion: 0, context: 0 },
  // The real routed deployment, keyed by its /model/info id, with real prices
  'deploy-gemini-id': { prompt: 0.25, completion: 1.5, context: 1000000 },
  // A normally-priced model
  'gpt-5-nano': { prompt: 0.05, completion: 0.4, context: 272000 },
};

describe('pickPricingModel (router / fallback)', () => {
  it('prices by the routed deployment id when the requested alias is unpriced', () => {
    expect(pickPricingModel('auto-nos-gpt', 'deploy-gemini-id', cfg)).toBe('deploy-gemini-id');
  });

  it('keeps the requested model when it is properly priced', () => {
    expect(pickPricingModel('gpt-5-nano', 'deploy-gemini-id', cfg)).toBe('gpt-5-nano');
  });

  it('keeps the requested model when there is no routed id', () => {
    expect(pickPricingModel('auto-nos-gpt', undefined, cfg)).toBe('auto-nos-gpt');
  });

  it('keeps the requested model when the routed id is also unpriced', () => {
    expect(pickPricingModel('auto-nos-gpt', 'unknown-deploy', cfg)).toBe('auto-nos-gpt');
  });

  it('ignores a routed id equal to the requested model', () => {
    expect(pickPricingModel('gpt-5-nano', 'gpt-5-nano', cfg)).toBe('gpt-5-nano');
  });

  it('returns the requested model when no config is available', () => {
    expect(pickPricingModel('auto-nos-gpt', 'deploy-gemini-id', undefined)).toBe('auto-nos-gpt');
  });
});
