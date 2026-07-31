# Implementation Plan: Accurate LiteLLM Billing via `x-litellm-response-cost`

## Objective

For custom endpoints explicitly opted-in, debit user credits from LiteLLM's own
computed cost (the `x-litellm-response-cost` HTTP response header) instead of
LibreChat's `token × multiplier` estimate. This correctly handles LiteLLM's
per-route / fallback / tiered pricing that no static price table can capture.
Fall back to the existing multiplier math whenever the header is absent.

## Why not the original "fetch pricing" approach

LiteLLM routes one `model_name` to multiple deployments with different real
costs. `/model/info` pricing is per-deployment and cannot be resolved
client-side, so any pre-fetched price table diverges from the real bill under
routing/fallbacks. Only the post-response header is exact. **This is therefore a
change to the spend/transaction path, not the fetch-config path.**

## Locked decisions

1. Source of truth: `x-litellm-response-cost` header (dollars).
2. Capture mechanism: **inject a wrapping `fetch` via `configOptions.fetch`** —
   NOT a `ChatOpenAI` subclass (infeasible in-repo; the model is built inside
   `@librechat/agents`).
3. Coverage: chat.completions AND Responses API; streaming AND non-streaming
   (a fetch wrapper covers all four for free — it sits below the SDK).
4. No header → fall back to existing `token × multiplier`. Never zero.
5. Trust gated by an explicit per-endpoint opt-in flag in `librechat.yaml`.
6. Store as ONE transaction, `tokenValue = -(costUSD × 1e6)` set directly
   (bypass multiplier), keeping token counts for display.
7. `checkBalance` unchanged — stays a multiplier estimate pre-gate; accurate cost
   reconciled on the post-response debit.

## Conversion

`1 USD = 1,000,000 tokenCredits` (multipliers are USD/1M; `tokenValue` = credits).
So `tokenCredits = costUSD × 1e6`, stored negative for a debit.

---

## Step 0 — SPIKE FIRST: fetch → billing correlation (the one real unknown)

The wrapping `fetch` runs **below** langchain, so the captured USD must be matched
back to the correct usage record before `processUsageGroup` debits. Prove a
concurrency-safe correlation before building the rest.

- The OpenAI SDK sends a client-generated request id and LiteLLM echoes a
  `x-litellm-call-id` / the response body carries `id` (chatcmpl-...). The
  streamed response's first SSE chunk also carries `id`.
- Approach to validate: in the wrapper, after `await fetch(...)`, read
  `response.headers.get('x-litellm-response-cost')` and correlate by the
  response body/stream `id` (chat completion id), which is the same id present on
  the AIMessage (`response_metadata.id` / `usage_metadata` is tagged with model,
  and the message id is available at `ModelEndHandler`).
- Store `{ [completionId]: costUSD }` in a short-lived per-request map (NOT a
  global — scope to the request/run to avoid cross-user leakage and unbounded
  growth), consumed and deleted at debit time.
- Deliverable of the spike: a throwaway proof that for a streamed LiteLLM call,
  the cost header value can be read AND matched to the `usage_metadata` that
  reaches `recordCollectedUsage`. If correlation by completion id is unreliable
  on streaming, fall back to attaching cost onto the fetch's returned response
  object and threading through the run context.

If Step 0 fails, stop and re-evaluate before any other step.

---

## Step 1 — Config schema: opt-in flag (COMPLIANT)

**File:** `packages/data-provider/src/config.ts` (custom `endpointSchema`, ~line 957)

Add a top-level optional boolean, mirroring `directEndpoint` (`:997`) and
`fetch` (`:968`):

```ts
useResponseCost: z.boolean().optional(),
```

Rationale for boolean over `costHeader: string`: single known header today;
add string flexibility only when a second proxy needs a different header (YAGNI).

Thread the field through wherever the custom endpoint config is read into
runtime options (see Step 2).

---

## Step 2 — Thread the flag to fetch construction + spend site

**File:** `packages/api/src/endpoints/custom/initialize.ts`
- Carry `useResponseCost` from `endpointConfig` onto the options object passed to
  `getOpenAIConfig` (alongside `endpointTokenConfig`, ~line 343).

**File:** `packages/api/src/endpoints/openai/config.ts`
- Accept `useResponseCost` in the options type consumed by `getOpenAIConfig`.
- **Widen the `configOptions.fetch` gate** (currently `directEndpoint === true`
  only, `:297`) so the capturing fetch is also installed when
  `useResponseCost === true`. Do not add a parallel mechanism — reuse
  `createFetch`.

---

## Step 3 — Header-capturing fetch (COMPLIANT via configOptions.fetch)

**File:** `packages/api/src/utils/generators.ts` — extend `createFetch` (`:25`)

- Add an optional param `captureResponseCost?: (id: string, costUSD: number) => void`
  (or return-and-correlate per Step 0's outcome).
- After `const res = await fetch(url, requestInit)`:
  - Read `res.headers.get('x-litellm-response-cost')`.
  - Parse to a finite, non-negative float (validate at this trust boundary — do
    NOT be lazy here).
  - Correlate to the completion id (from response clone/body or stream id per
    Step 0) and record via the callback/map.
  - Return the original `res` untouched (must not consume the stream).

**File:** `packages/api/src/endpoints/openai/config.ts`
- When `useResponseCost` is set, pass the capture hook into `createFetch` at
  `:298`.

Note: only enable capture when opted-in, so default requests keep current behavior
and overhead.

---

## Step 4 — Read cost at the billing choke point (COMPLIANT; wire in 3 places)

Extra usage fields are NOT free pass-through. Wire in all three:

1. **`packages/api/src/stream/interfaces/IJobStore.ts` (~:254)** — add
   `costUSD?: number;` to `UsageMetadata` (consistent with `provider?`/`agentId?`).
2. **`packages/api/src/agents/transactions.ts` (~:77-86)** — add
   `costUSD?: number;` to the `TxMetadata` interface.
3. **`packages/api/src/agents/usage.ts` (`processUsageGroup`, `:590-604`)** —
   copy `usage.costUSD` into the `txMetadata` literal.

**Populate `usage.costUSD`:** at `api/server/controllers/agents/callbacks.js`
`ModelEndHandler.handle` (~:105), after reading `usage_metadata`, look up the
correlated cost (by completion id from `data.output.response_metadata?.id` /
message id) and set `usage.costUSD` before the object is pushed to
`collectedUsage` (`:135`). This is the single point where the captured cost joins
the usage record.

---

## Step 5 — Direct-value transaction (precedent exists; label corrected)

**File:** `packages/data-schemas/src/methods/transaction.ts`

Precedent (correctly described): the `!tokenType` fallback branch at **:127**
sets `txn.tokenValue = txn.rawAmount` directly, bypassing the multiplier. This is
the pattern to mirror — it is the untyped-fallback direct-value branch, NOT a
dedicated "credits path."

- Add a path (or extend `createTransaction`) that, when a `costUSD` is supplied,
  sets `tokenValue = -(costUSD × 1e6)` directly and skips `getMultiplier` /
  `calculateTokenValue`.
- Keep `rawAmount` and prompt/completion token counts on the transaction for
  display/analytics; only the debited `tokenValue` comes from cost.
- Write ONE transaction for the call (not split prompt/completion — LiteLLM does
  not break the cost down).
- `updateBalance` needs no change (it already decrements by `tokenValue`,
  `:361-365`).

**File:** `packages/data-schemas/src/methods/spendTokens.ts`
- Accept and forward `costUSD` from `txData` so `createTransaction` uses the
  direct value. When `costUSD` is absent → existing token-based path unchanged.

---

## Step 6 — Fallback + safety

- If `useResponseCost` set but header missing / `null` / unparseable / negative →
  log once at debug and use the existing multiplier path. Billing never goes to
  zero.
- Validate the header is a finite non-negative number before trusting (trust
  boundary — not lazy).
- Opt-in off + header present → header ignored entirely (no trust).

---

## Step 7 — checkBalance

No change. `packages/api/src/middleware/checkBalance.ts` remains a
`token × multiplier` estimate pre-gate; accuracy comes from the post-response
debit.

---

## Step 8 — Tests (`*.spec.ts`, Jest, co-located)

- `transaction.spec.ts`: header value `"0.00123"` → transaction
  `tokenValue === -1230`.
- `spendTokens.spec.ts`: `costUSD` supplied → direct-value transaction, multiplier
  not called.
- `usage.spec.ts`: `usage.costUSD` set + opted-in → cost path; absent → multiplier
  fallback path.
- `generators` fetch test: parse guard — `null` / `"NaN"` / negative header →
  no cost recorded, response returned untouched, stream not consumed.
- config schema test: `useResponseCost` parses as optional boolean.

---

## Files touched (summary)

| File | Change |
|---|---|
| `packages/data-provider/src/config.ts` | `useResponseCost` schema field |
| `packages/api/src/endpoints/custom/initialize.ts` | thread flag onto options |
| `packages/api/src/endpoints/openai/config.ts` | widen fetch gate; pass capture hook |
| `packages/api/src/utils/generators.ts` | `createFetch` reads + correlates cost header |
| `packages/api/src/stream/interfaces/IJobStore.ts` | `costUSD?` on `UsageMetadata` |
| `packages/api/src/agents/transactions.ts` | `costUSD?` on `TxMetadata` |
| `packages/api/src/agents/usage.ts` | copy `costUSD` into `txMetadata` |
| `api/server/controllers/agents/callbacks.js` | set `usage.costUSD` from correlated cost |
| `packages/data-schemas/src/methods/transaction.ts` | direct-value cost transaction |
| `packages/data-schemas/src/methods/spendTokens.ts` | forward `costUSD` |
| docs `.../ai_endpoints/litellm.mdx` | document `useResponseCost` |
| co-located `*.spec.ts` | tests per Step 8 |

## Compliance notes (validated against repo)

- Schema flag: matches `directEndpoint`/`fetch` declaration pattern. ✅
- No `ChatOpenAI` subclass anywhere; model built via `Run.create` inside
  `@librechat/agents`. Use `configOptions.fetch` injection instead. ✅
- `configOptions.fetch` / `defaultHeaders` / dispatcher already threaded through
  `getOpenAIConfig`; capture is possible without touching `@librechat/agents`. ✅
- Usage → spend is NOT free pass-through; requires the 3 explicit wiring points
  in Step 4. ✅
- Direct-value precedent is the `!tokenType` fallback at `transaction.ts:127`. ✅
- Tests are Jest `*.spec.ts`, co-located. ✅

## Out of scope

- Legacy `BaseClient` (non-agents) path — LiteLLM custom endpoints route through
  the agents path. Confirm no deployment uses the legacy client for custom
  endpoints before shipping.
- `/model/info` pre-fetch / context-cost estimate UI (deliberately not pursued;
  cannot represent per-route pricing).

## Biggest remaining risk

The fetch → billing correlation (Step 0). The capturing fetch runs beneath
langchain, so the captured USD must be matched to the right usage record before
`processUsageGroup` debits, safely under concurrency. Prove this first.
