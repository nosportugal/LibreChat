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

export interface ResponseCostEntry {
  /** Completion id (e.g. `chatcmpl-...`) when resolvable, else undefined. */
  id?: string;
  /** Cost in USD. */
  costUSD: number;
}

export class ResponseCostCollector {
  private byId = new Map<string, number>();
  private ordered: number[] = [];

  record(costUSD: number, id?: string): void {
    if (!Number.isFinite(costUSD) || costUSD < 0) {
      return;
    }
    if (id) {
      this.byId.set(id, costUSD);
    }
    this.ordered.push(costUSD);
  }

  /** Look up a captured cost by completion id. */
  getById(id?: string): number | undefined {
    if (id && this.byId.has(id)) {
      return this.byId.get(id);
    }
    return undefined;
  }

  get size(): number {
    return this.ordered.length;
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
