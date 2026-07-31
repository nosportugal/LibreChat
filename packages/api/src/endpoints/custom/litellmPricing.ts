import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import type { EndpointTokenConfig, TokenConfig } from '~/types/tokens';

/**
 * LiteLLM's public model price map (the same file LiteLLM itself uses for cost
 * tracking). Keyed by model name with per-TOKEN USD costs. We convert these to
 * LibreChat's per-1M-token `EndpointTokenConfig` so streamed token counts can be
 * priced without the per-call cost header (which LiteLLM only emits on
 * non-streaming responses) and without any user-provided `tokenConfig`.
 *
 * Override the source with `LITELLM_PRICE_MAP_URL` (e.g. an internal mirror).
 */
const DEFAULT_PRICE_MAP_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

interface LiteLLMPriceEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_input_tokens?: number;
  max_tokens?: number;
  litellm_provider?: string;
}

type LiteLLMPriceMap = Record<string, LiteLLMPriceEntry>;

const PER_MILLION = 1_000_000;

/**
 * Converts LiteLLM's per-token price map into LibreChat's per-1M-token
 * `EndpointTokenConfig`. Skips the `sample_spec` meta entry and any model
 * missing both input and output costs.
 */
export function convertLiteLLMPriceMap(map: LiteLLMPriceMap): EndpointTokenConfig {
  const config: EndpointTokenConfig = {};
  for (const [model, entry] of Object.entries(map)) {
    if (model === 'sample_spec' || entry == null || typeof entry !== 'object') {
      continue;
    }
    const input = entry.input_cost_per_token;
    const output = entry.output_cost_per_token;
    if (input == null && output == null) {
      continue;
    }
    const tokenConfig: TokenConfig = {
      prompt: (input ?? 0) * PER_MILLION,
      completion: (output ?? 0) * PER_MILLION,
      context: entry.max_input_tokens ?? entry.max_tokens ?? 0,
    };
    if (entry.cache_read_input_token_cost != null) {
      tokenConfig.read = entry.cache_read_input_token_cost * PER_MILLION;
    }
    if (entry.cache_creation_input_token_cost != null) {
      tokenConfig.write = entry.cache_creation_input_token_cost * PER_MILLION;
    }
    config[model] = tokenConfig;
  }
  return config;
}

let inflight: Promise<EndpointTokenConfig | undefined> | undefined;

/**
 * Fetches and converts the LiteLLM price map. In-flight requests are shared so a
 * burst of endpoint initializations triggers a single network call. Returns
 * undefined on failure (billing then falls back to defaultRate) — a pricing
 * fetch must never break request initialization.
 */
export async function fetchLiteLLMPriceMap(): Promise<EndpointTokenConfig | undefined> {
  if (inflight) {
    return inflight;
  }
  const url = process.env.LITELLM_PRICE_MAP_URL || DEFAULT_PRICE_MAP_URL;
  inflight = (async () => {
    try {
      const res = await axios.get<LiteLLMPriceMap>(url, { timeout: 10000 });
      const config = convertLiteLLMPriceMap(res.data);
      logger.debug(
        `[litellmPricing] Loaded ${Object.keys(config).length} model prices from ${url}`,
      );
      return config;
    } catch (err) {
      logger.warn('[litellmPricing] Failed to load LiteLLM price map; billing will fall back', err);
      return undefined;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
