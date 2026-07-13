# Choosing an LLM

FeedbackKit sends **one** LLM call per feedback (POST-1) to extract structured
fields from the user's raw text **and from the attached screenshot**. This page
recommends models **by category** and explains the knobs. The model is
**operator configuration** — nothing here is hard-coded; set it per project.

## What the task needs

Extraction, not reasoning. In order:

1. **Vision — mandatory.** Screenshots are always collected and are a primary
   input; a text-only model silently loses whatever was only in the image, so
   text-only models are **not an option** regardless of price. Every model
   recommended below is multimodal.
2. **Structured / JSON output** — so `llm.structuredOutput` can stay `true` and we
   get clean JSON. Some free/local endpoints don't support strict
   `response_format: json_schema` and return *empty content* when it's forced
   (see the flag below).
3. **Cost** — the endpoint is public and anonymous; the operator pays. A typical
   call is ~1–2k input tokens + a downscaled screenshot + ~200 output tokens →
   well under **$0.001 per feedback** on the models below.
4. **Latency** — the follow-up question is synchronous. P1 exit target is
   **p90 < 8 s**; every model below clears it with room for the screenshot.
5. **Multilingual, no translation** — the system prompt forbids translating; the
   model must keep the user's language verbatim.

## Verified data

Measured 2026-07-13 via the OpenRouter models API (pricing/capabilities) and a
live smoke test of FeedbackKit's **exact** request shape (system prompt + field
schema + `response_format: json_schema`) on a German bug report. Latency is a
single un-warmed call — indicative, not a benchmark. Prices/availability drift;
re-check before committing. Every model listed is multimodal, kept German
verbatim, and extracted all required fields.

| Model | $/1M in→out | Structured | Open-weights | Latency (schema) |
|---|---|---|---|---|
| **google/gemma-4-26b-a4b-it** | 0.06 → — | ✅ | ✅ | **~0.69 s** |
| google/gemma-3-27b-it | 0.08 → — | ✅ | ✅ | ~1.0 s |
| google/gemini-2.5-flash-lite | 0.10 → 0.40 | ✅ | ❌ | ~0.75 s |
| openai/gpt-5-nano | 0.05 → 0.40 | ✅ | ❌ | ~0.77 s |
| mistralai/mistral-small-3.2-24b | 0.075 → 0.20 | ✅ | ✅ | ~2.0 s |
| google/gemini-2.5-flash | 0.30 → 2.50 | ✅ | ❌ | — |
| openai/gpt-4o-mini | 0.15 → 0.60 | ✅ | ❌ | — |
| `google/gemma-4-26b-a4b-it:free` | 0 | ✅ | ✅ | ~1.1 s |

> Text-only models (e.g. OpenAI's open-weights `gpt-oss-20b/120b` — very cheap
> and fast, but no image input) are **excluded**: vision is mandatory here.

## Recommendations by category

**1. Default — `google/gemma-4-26b-a4b-it`.**
Extraction isn't a reasoning task, so a mid-size model is plenty. Vision +
reliable structured output, the cheapest *and* fastest model tested, and — the
deciding factor for a privacy-first tool — **open-weights**, so the *same* model
an operator runs hosted (OpenRouter) also runs on-prem (vLLM/Ollama). One pick
spans the hosted and the fully-local tier.

**2. Fully managed, maximum reliability — `google/gemini-2.5-flash-lite` or `openai/gpt-5-nano`.**
First-party endpoints (no third-party routing) — choose these if "just works"
uptime matters more than local portability. Both ~0.75 s, clean JSON, cheap.
gpt-5-nano gave the cleanest output; gemini-flash-lite has a 1M context.

**3. Higher quality for messy input / heavy screenshot OCR — `google/gemini-2.5-flash` or `openai/gpt-4o-mini` (paid).**
Every model nails a clean bug report; the paid step-up earns its keep on
*ambiguous* multilingual feedback and on **reading text out of cluttered
screenshots** (stronger vision OCR). Reach for it when extraction quality — not
cost — is your bottleneck. (Not differentiated by the happy-path smoke test;
recommended on model-size grounds.)

**4. Fully local / privacy (self-hosted, [ADR-007](DECISIONS.md)).**
Open-weights, multimodal: `gemma-4-26b-a4b-it` or `mistralai/mistral-small-3.2-24b`.
Run via vLLM or Ollama, point `llm.baseUrl` at your endpoint, and set
`structuredOutput` to match whether your serving stack honors `json_schema`.

**5. Free / testing / zero-budget — `google/gemma-4-26b-a4b-it:free`.**
Free, and unlike most free tiers it keeps vision + structured output. Good for
CI-adjacent smoke tests and low-traffic hobby instances.

## The knobs (`llm` in a project's config)

```jsonc
"llm": {
  "provider": "openrouter",              // openrouter | github-models | custom | off
  "model": "google/gemma-4-26b-a4b-it",  // open-weights → same model runs local
  "baseUrl": "https://openrouter.ai/api/v1", // set for LiteLLM/Ollama/vLLM/custom
  "dailyBudget": 200,                    // calls/day cap (cost guard)
  "structuredOutput": true               // ↓ see below
}
```

- **`structuredOutput`** (default `true`): sends `response_format: json_schema`.
  Turn it **off** for endpoints that don't support strict schema (some free tiers,
  many Ollama/vLLM setups) — otherwise they return empty content and every
  extraction degrades. With it off, FeedbackKit relies on the prompt plus a
  fence-tolerant parser (strips ` ```json ` fences), which works well on models
  that only emit best-effort JSON.
- **`provider: "off"`** disables the LLM entirely (kill switch): the widget shows
  plain required-field forms. Same effect if no `LLM_API_KEY` is set.
- Extraction never blocks: any LLM failure degrades to create-anyway or manual
  required-field entry (never a lost submission) — see [ADR-005](DECISIONS.md).

## Reproduce this yourself

```bash
# 1) list multimodal models with pricing + structured-output support
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OR_KEY" \
  | jq -r '.data[] | select((.architecture.input_modalities//[]|index("image")) and (.supported_parameters//[]|index("structured_outputs")))
      | "\(.id)\tin$\((.pricing.prompt|tonumber)*1e6)/M out$\((.pricing.completion|tonumber)*1e6)/M"'
# 2) smoke-test extraction quality/latency against your own field set + language
```
