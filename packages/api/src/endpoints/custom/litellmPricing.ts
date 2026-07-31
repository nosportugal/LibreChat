import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import type { EndpointTokenConfig, TokenConfig } from '~/types/tokens';

/**
 * LiteLLM billing prices, converted to LibreChat's per-1M-token
 * `EndpointTokenConfig` so streamed token counts can be priced without the
 * per-call cost header (LiteLLM only emits that on non-streaming responses) and
 * without any user-provided `tokenConfig`.
 *
 * Two sources, in priority order:
 * 1. The proxy's own `/model/info` — carries the proxy's CUSTOM pricing
 *    (margins, overrides, per-deployment rates). Requires the endpoint's key to
 *    be allowed on that route.
 * 2. LiteLLM's public `model_prices_and_context_window.json` — default upstream
 *    rates, used only when `/model/info` is unavailable. Override the source
 *    with `LITELLM_PRICE_MAP_URL` (e.g. an internal mirror).
 */
const DEFAULT_PRICE_MAP_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PER_MILLION = 1_000_000;

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

/** Shape of an entry in the proxy's `/model/info` `data[]`. */
interface ModelInfoEntry {
  model_name?: string;
  model_info?: LiteLLMPriceEntry & Record<string, unknown>;
}

/** Builds a per-1M `TokenConfig` from a LiteLLM per-token price entry, or null
 *  when the entry has no usable pricing. */
function toTokenConfig(entry: LiteLLMPriceEntry): TokenConfig | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (input == null && output == null) {
    return null;
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
  return tokenConfig;
}

/**
 * Converts LiteLLM's public per-token price map into `EndpointTokenConfig`.
 * Skips the `sample_spec` meta entry and models with no usable pricing.
 */
export function convertLiteLLMPriceMap(map: LiteLLMPriceMap): EndpointTokenConfig {
  const config: EndpointTokenConfig = {};
  for (const [model, entry] of Object.entries(map)) {
    if (model === 'sample_spec' || entry == null || typeof entry !== 'object') {
      continue;
    }
    const tokenConfig = toTokenConfig(entry);
    if (tokenConfig) {
      config[model] = tokenConfig;
    }
  }
  return config;
}

/**
 * Converts a proxy `/model/info` response (`{ data: [{ model_name, model_info }] }`)
 * into `EndpointTokenConfig`, keyed by the public `model_name`. This is the
 * proxy's authoritative CUSTOM pricing.
 */
export function convertModelInfoResponse(data: { data?: ModelInfoEntry[] }): EndpointTokenConfig {
  const config: EndpointTokenConfig = {};
  for (const item of data?.data ?? []) {
    const name = item?.model_name;
    const info = item?.model_info;
    if (!name || info == null) {
      continue;
    }
    const tokenConfig = toTokenConfig(info);
    if (tokenConfig) {
      config[name] = tokenConfig;
    }
  }
  return config;
}

/**
 * Loads the proxy's CUSTOM pricing from `{baseURL}/model/info`, using the
 * endpoint's own key. Returns undefined when the route is unavailable (e.g. the
 * key is restricted to `llm_api_routes`, 403) so the caller can fall back to the
 * public map. Never throws — a pricing fetch must not break initialization.
 */
export async function fetchProxyModelInfo(
  baseURL: string,
  apiKey: string,
  headers?: Record<string, string>,
): Promise<EndpointTokenConfig | undefined> {
  const base = baseURL.replace(/\/+$/, '');
  try {
    const res = await axios.get(`${base}/model/info`, {
      timeout: 10000,
      headers: { Authorization: `Bearer ${apiKey}`, ...headers },
    });
    const config = convertModelInfoResponse(res.data);
    if (Object.keys(config).length === 0) {
      return undefined;
    }
    logger.debug(
      `[litellmPricing] Loaded ${Object.keys(config).length} custom prices from ${base}/model/info`,
    );
    return config;
  } catch (err) {
    logger.debug(
      `[litellmPricing] /model/info unavailable at ${base} (falling back to public map)`,
      err,
    );
    return undefined;
  }
}

let inflight: Promise<EndpointTokenConfig | undefined> | undefined;

/**
 * Fetches and converts LiteLLM's PUBLIC price map. In-flight requests are shared
 * so a burst of endpoint initializations triggers a single network call.
 * Returns undefined on failure (billing then falls back to defaultRate).
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

/**
 * Resolves LiteLLM pricing for an endpoint: the proxy's custom `/model/info`
 * prices first (authoritative), else the public upstream map. Returns undefined
 * only when both are unavailable.
 */
export async function resolveLiteLLMPricing(
  baseURL: string | null | undefined,
  apiKey: string,
  headers?: Record<string, string>,
): Promise<EndpointTokenConfig | undefined> {
  if (baseURL) {
    const custom = await fetchProxyModelInfo(baseURL, apiKey, headers);
    if (custom != null) {
      return custom;
    }
  }
  return fetchLiteLLMPriceMap();
}
