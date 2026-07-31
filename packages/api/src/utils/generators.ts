import fetch from 'node-fetch';
import { logger } from '@librechat/data-schemas';
import { GraphEvents, sleep } from '@librechat/agents';
import type { Response as ServerResponse } from 'express';
import type { Agent as HttpsAgent } from 'node:https';
import type { Agent as HttpAgent } from 'node:http';
import type { URL as NodeURL } from 'node:url';
import type { ServerSentEvent } from '~/types';
import type { ResponseCostCollector } from './responseCost';
import { LITELLM_COST_HEADER, LITELLM_MODEL_ID_HEADER, parseResponseCostHeader, extractCompletionId } from './responseCost';
import { sendEvent } from './events';

type SSRFSafeAgents = {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
};

/**
 * Makes a function to make HTTP request and logs the process.
 * @param params
 * @param params.directEndpoint - Whether to use a direct endpoint.
 * @param params.reverseProxyUrl - The reverse proxy URL to use for the request.
 * @param params.ssrfAgents - Optional SSRF-safe agents for user-provided URLs.
 * @param params.redirect - Optional redirect policy for user-provided URLs.
 * @returns A promise that resolves to the response of the fetch request.
 */
export function createFetch({
  directEndpoint = false,
  reverseProxyUrl = '',
  ssrfAgents,
  redirect,
  costCollector,
}: {
  directEndpoint?: boolean;
  reverseProxyUrl?: string;
  ssrfAgents?: SSRFSafeAgents;
  redirect?: fetch.RequestRedirect;
  /**
   * When provided, the wrapper reads the provider's response-cost header
   * (e.g. LiteLLM's `x-litellm-response-cost`) off each response and records it,
   * keyed by completion id, for accurate post-response billing.
   */
  costCollector?: ResponseCostCollector;
}) {
  /**
   * Makes an HTTP request and logs the process.
   * @param url - The URL to make the request to. Can be a string or a Request object.
   * @param init - Optional init options for the request.
   * @returns A promise that resolves to the response of the fetch request.
   */
  return async function (
    _url: fetch.RequestInfo,
    init: fetch.RequestInit,
  ): Promise<fetch.Response> {
    let url = _url;
    if (directEndpoint) {
      url = reverseProxyUrl;
    }
    logger.debug(`Making request to ${url}`);
    const requestInit = { ...init };
    if (ssrfAgents) {
      requestInit.agent = (parsedURL: NodeURL) =>
        parsedURL.protocol === 'http:' ? ssrfAgents.httpAgent : ssrfAgents.httpsAgent;
    }
    if (redirect) {
      requestInit.redirect = redirect;
    }
    const res = await fetch(url, requestInit);
    if (costCollector) {
      await captureResponseCost(res, costCollector);
    }
    return res;
  };
}

/**
 * Reads the provider response-cost header off a response and records it into the
 * collector, correlated to the completion id when resolvable. Clones the response
 * so the stream body is never consumed. All failures are swallowed — cost capture
 * must never break the request; billing falls back to token*multiplier.
 */
async function captureResponseCost(
  res: fetch.Response,
  costCollector: ResponseCostCollector,
): Promise<void> {
  try {
    const costUSD = parseResponseCostHeader(res.headers.get(LITELLM_COST_HEADER));
    const modelId = res.headers.get(LITELLM_MODEL_ID_HEADER) ?? undefined;
    // Nothing to correlate if the provider exposed neither signal.
    if (costUSD == null && !modelId) {
      return;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const id = await resolveCompletionId(res, contentType);
    costCollector.record(id, { costUSD, modelId });
  } catch (err) {
    logger.debug('[createFetch] Failed to capture response cost', err);
  }
}

/**
 * Resolves the completion id (`chatcmpl-…`) needed to correlate captured
 * cost/model-id to the right usage record. For JSON (non-streaming) reads the
 * cloned body; for an event-stream reads only a bounded PREFIX of a clone (the
 * id is in the first chunk) so the real stream is never drained — avoiding the
 * hang/OOM risk of buffering the whole stream.
 */
async function resolveCompletionId(
  res: fetch.Response,
  contentType: string,
): Promise<string | undefined> {
  try {
    if (contentType.includes('application/json')) {
      const text = await res.clone().text();
      return extractCompletionId(text.slice(0, 512));
    }
    if (contentType.includes('text/event-stream') || contentType.includes('stream')) {
      const body = res.clone().body as NodeJS.ReadableStream | null;
      if (!body) {
        return undefined;
      }
      return await readIdFromStreamPrefix(body);
    }
  } catch {
    // Body not readable; record without a completion id.
  }
  return undefined;
}

/** Reads at most ~2KB from a stream clone to extract the completion id from the
 *  first SSE chunk, then stops without consuming the rest. */
function readIdFromStreamPrefix(stream: NodeJS.ReadableStream): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = '';
    const done = (id?: string) => {
      stream.removeAllListeners();
      // Best-effort: let the clone be GC'd; do not destroy the real response.
      resolve(id);
    };
    stream.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const id = extractCompletionId(buffer);
      if (id || buffer.length > 2048) {
        done(id);
      }
    });
    stream.on('end', () => done(extractCompletionId(buffer)));
    stream.on('error', () => done(undefined));
  });
}

/**
 * Creates event handlers for stream events that don't capture client references
 * @param res - The response object to send events to
 * @returns Object containing handler functions
 */
export function createStreamEventHandlers(res: ServerResponse): {
  on_run_step: (event: ServerSentEvent) => void;
  on_message_delta: (event: ServerSentEvent) => void;
  on_reasoning_delta: (event: ServerSentEvent) => void;
} {
  return {
    [GraphEvents.ON_RUN_STEP]: function (event: ServerSentEvent): void {
      if (res) {
        sendEvent(res, event);
      }
    },
    [GraphEvents.ON_MESSAGE_DELTA]: function (event: ServerSentEvent): void {
      if (res) {
        sendEvent(res, event);
      }
    },
    [GraphEvents.ON_REASONING_DELTA]: function (event: ServerSentEvent): void {
      if (res) {
        sendEvent(res, event);
      }
    },
  };
}

export function createHandleLLMNewToken(streamRate: number) {
  return async function (): Promise<void> {
    if (streamRate) {
      await sleep(streamRate);
    }
  };
}
