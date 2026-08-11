# Accurate LiteLLM Billing

Opt a custom endpoint into LiteLLM-aware billing with `useLiteLLMResponseCost`:

```yaml
endpoints:
  custom:
    - name: "LiteLLM"
      apiKey: "sk-from-config-file"
      baseURL: "http://litellm:4000/v1"
      useLiteLLMResponseCost: true
      models:
        default: ["gpt-4o"]
        fetch: true
```

## Behavior

- A valid `x-litellm-response-cost` header is charged as the exact USD cost.
- Missing or invalid headers use the existing token-based estimate.
- Streaming uses proxy `/model/info` pricing, then LiteLLM's public price map.
- Static `tokenConfig` remains authoritative over automatic pricing.
- Router and fallback responses use `x-litellm-model-id` to price the served deployment.
- The feature is opt-in; endpoints without `useLiteLLMResponseCost` are unchanged.

## Implementation

- `createFetch` captures provider cost and served model headers without consuming the real response.
- `ResponseCostCollector` stores signals per completion in `AsyncLocalStorage` and consumes them at the billing boundary.
- Provider costs flow through `UsageMetadata` and `TxMetadata` into one direct-value transaction: `tokenValue = -(costUSD * 1e6)`.
- Automatic pricing is cached per endpoint; public price-map requests share an in-flight request.
- Unit coverage is in `responseCost.spec.ts`, `generators.spec.ts`, `prepareCostSpend.spec.ts`, and `config-schemas.spec.ts`.
