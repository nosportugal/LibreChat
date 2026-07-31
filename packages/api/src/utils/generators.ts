import fetch from 'node-fetch';
import { logger } from '@librechat/data-schemas';
import { GraphEvents, sleep } from '@librechat/agents';
import type { Response as ServerResponse } from 'express';
import type { Agent as HttpsAgent } from 'node:https';
import type { Agent as HttpAgent } from 'node:http';
import type { URL as NodeURL } from 'node:url';
import type { ServerSentEvent } from '~/types';
import type { ResponseCostCollector } from './responseCost';
import { LITELLM_COST_HEADER, parseResponseCostHeader, extractCompletionId } from './responseCost';
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
    if (costUSD == null) {
      return;
    }
    let id: string | undefined;
    try {
      // Peek at a bounded prefix of a clone to resolve the completion id without
      // consuming the real body (streaming or not).
      const text = await res.clone().text();
      id = extractCompletionId(text.slice(0, 512));
    } catch {
      // Body not clonable/readable as text (rare); record cost without id.
    }
    costCollector.record(costUSD, id);
  } catch (err) {
    logger.debug('[createFetch] Failed to capture response cost', err);
  }
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
