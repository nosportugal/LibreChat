import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped collector for provider-reported response costs (e.g. LiteLLM's
 * `x-litellm-response-cost` header). One instance is created per request/run and
 * shared with the request's `fetch` wrapper closure, so multiple completions in
 * a single agent run (tool loops, summarization) each record their own cost.
 *
 * Costs are keyed by the completion id (chatcmpl-...) so the debit can correlate
 * a captured cost to the specific usage record it belongs to. A fallback ordered
 * list is kept for cases where the id is unavailable.
 */
export const LITELLM_COST_HEADER = 'x-litellm-response-cost';
export const LITELLM_MODEL_ID_HEADER = 'x-litellm-model-id';

export interface ResponseCostEntry {
  /** Cost in USD (from `x-litellm-response-cost`), when present. */
  costUSD?: number;
  /**
   * The deployment id actually served (`x-litellm-model-id`). Differs from the
   * requested model for router/fallback/auto-router aliases; used to price the
   * real model on streaming, where the response body reports only the alias.
   */
  modelId?: string;
}

export class ResponseCostCollector {
  private byId = new Map<string, ResponseCostEntry>();
  private count = 0;

  /**
   * Records the provider signals for a completion: the exact USD cost (present
   * on non-streaming) and/or the served deployment id (present on both). Invalid
   * costs are dropped; a bare model id (streaming) is still recorded.
   */
  record(id: string | undefined, entry: ResponseCostEntry): void {
    const clean: ResponseCostEntry = {};
    if (entry.costUSD != null && Number.isFinite(entry.costUSD) && entry.costUSD >= 0) {
      clean.costUSD = entry.costUSD;
    }
    if (entry.modelId) {
      clean.modelId = entry.modelId;
    }
    if (clean.costUSD == null && clean.modelId == null) {
      return;
    }
    this.count++;
    if (id) {
      this.byId.set(id, { ...this.byId.get(id), ...clean });
    }
  }

  /** Look up captured signals by completion id (non-consuming). */
  getById(id?: string): ResponseCostEntry | undefined {
    if (id && this.byId.has(id)) {
      return this.byId.get(id);
    }
    return undefined;
  }

  /**
   * Consumes and returns the captured signals for a completion id, removing them
   * so the same cost can never be billed twice (e.g. on a retried callback).
   */
  consumeById(id?: string): ResponseCostEntry | undefined {
    if (id != null && this.byId.has(id)) {
      const entry = this.byId.get(id);
      this.byId.delete(id);
      return entry;
    }
    return undefined;
  }

  get size(): number {
    return this.count;
  }
}

/**
 * Parses a `x-litellm-response-cost` header value into a validated, non-negative
 * finite USD number. Returns undefined when absent or invalid (trust boundary:
 * never trust a malformed cost for billing).
 */
export function parseResponseCostHeader(raw: string | null | undefined): number | undefined {
  if (raw == null || raw === '') {
    return undefined;
  }
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Extracts the completion id (`chatcmpl-...` / responses `resp_...`) from a
 * parsed non-streaming JSON body or an SSE data line, for cost correlation.
 */
export function extractCompletionId(text: string | null | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  // Non-streaming JSON body: {"id":"chatcmpl-...", ...}
  const match = text.match(/"id"\s*:\s*"([^"]+)"/);
  return match?.[1];
}

/**
 * Request-scoped AsyncLocalStorage holding the active response-cost collector.
 *
 * The capturing `fetch` (below the langchain/SDK layer) writes captured costs
 * into this store; `ModelEndHandler` (the billing choke point) reads from it and
 * correlates by completion id — without threading a live object through
 * `@librechat/agents`. Mirrors the repo's existing `tenantStorage` ALS pattern.
 */
export const responseCostStorage: AsyncLocalStorage<ResponseCostCollector> =
  new AsyncLocalStorage<ResponseCostCollector>();

/**
 * Runs `fn` within a fresh response-cost collector context. Establish this once
 * per generation (around client init + `sendMessage`) so both the fetch and the
 * end-of-model callback observe the same collector.
 */
export function runWithResponseCostCollector<T>(
  collector: ResponseCostCollector,
  fn: () => T,
): T {
  return responseCostStorage.run(collector, fn);
}

/** Returns the ambient request-scoped collector, if a context is active. */
export function getResponseCostCollector(): ResponseCostCollector | undefined {
  return responseCostStorage.getStore();
}
