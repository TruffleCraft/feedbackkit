# Choosing an LLM

FeedbackKit sends **one** LLM call per feedback (POST-1) to extract structured
fields from the user's raw text (and, when a screenshot is attached, from the
image). This page recommends models and explains the knobs. The model is
**operator configuration** — nothing here is hard-coded; set it per project.

## What the task actually needs

Extraction, not reasoning. Pick for these, in order:

1. **Structured / JSON output** — so `llm.structuredOutput` can stay `true` and we
   get clean JSON. Many free and local endpoints do **not** support strict
   `response_format: json_schema` and return *empty content* when it's forced
   (see the flag below).
2. **Vision** — screenshots are a core input; a text-only model silently loses
   whatever information was only in the image.
3. **Cost** — the endpoint is public and anonymous; the operator pays. A typical
   call is ~1–2k input tokens + an optional downscaled screenshot + ~200 output
   tokens → well under **$0.001 per feedback** on the models below.
4. **Latency** — the follow-up question is synchronous (the user is still on the
   page). P1 exit target is **p90 < 8 s**; flash/mini/nano/lite classes clear it
   with room for a screenshot.
5. **Multilingual, no translation** — the system prompt forbids translating; the
   model must keep the user's language verbatim (German, etc.).

## Verified comparison

Measured 2026-07-13 via the OpenRouter models API (pricing/capabilities) and a
live smoke test of FeedbackKit's **exact** request shape (system prompt + field
schema + `response_format: json_schema`) on a German bug report. Latency is a
single un-warmed call — indicative, not a benchmark. Prices and availability
drift; re-check before committing.

| Model | $/1M in→out | Vision | Structured | Latency (schema) | Notes |
|---|---|---|---|---|---|
| **google/gemma-3-27b-it** | 0.08 → — | ✅ | ✅ clean JSON | ~1.0 s | **Recommended default.** Open-weights → *identical* model runs on-prem. |
| **google/gemma-4-26b-a4b-it** | 0.06 → — | ✅ | ✅ clean JSON | **~0.7 s** | Cheaper/faster sibling; also video-in. Newer line — check route availability. |
| google/gemini-2.5-flash-lite | 0.10 → 0.40 | ✅ | ✅ clean JSON | ~0.75 s | Fully-managed alt; 1M ctx; max reliability. |
| openai/gpt-5-nano | 0.05 → 0.40 | ✅ | ✅ clean JSON | ~0.77 s | Managed alt; cleanest output (filled `type`+`summary`); 400k ctx. |
| mistralai/mistral-small-3.2-24b | 0.075 → 0.20 | ✅ | ✅ | ~2.0 s | Other open-weights local option. |
| openai/gpt-4o-mini · gemini-2.5-flash | 0.15+ | ✅ | ✅ | — | Quality step-up for messy/ambiguous feedback. |
| `google/gemma-4-26b-a4b-it:free` | **0** | ✅ | ✅ | ~1.1 s | Genuinely capable free tier (vision+structured) — good for tests. |
| `google/gemma-4-31b-it:free` | 0 | ✅ | ❌ empty w/ schema | — | Free but no structured output — needs `structuredOutput:false`. |

Every model above kept German verbatim and extracted all required fields in the
smoke test. **Correction:** Gemma 3 (4b/12b/27b) and Gemma 4 are all natively
multimodal and support structured output on OpenRouter — earlier notes calling
the Gemma tiers text-only were wrong (verified via the models API, below).
Free-tier support varies per endpoint: `gemma-4-26b-a4b-it:free` honors
`json_schema`, `gemma-4-31b-it:free` returns empty content with it.

## Recommendations

- **Default: `google/gemma-3-27b-it`.** Extraction is not a reasoning task, so a
  mid-size model is plenty. It has vision + reliable structured output, is
  cheaper than the managed flash/nano tiers, and — the deciding factor for a
  privacy-first tool — it's **open-weights**, so the *same* model an operator
  runs hosted (via OpenRouter) also runs on-prem (vLLM/Ollama). One
  recommendation spans both the hosted and the fully-local tier ([ADR-007](DECISIONS.md)).
  `google/gemma-4-26b-a4b-it` is a cheaper/faster newer sibling (and video-in);
  prefer it once you've confirmed it's reliably routed for you.
- **Fully-managed, max reliability: `google/gemini-2.5-flash-lite` or `openai/gpt-5-nano`.**
  First-party endpoints (no third-party routing) — pick these if "just works"
  matters more than local portability. gpt-5-nano gave the cleanest output.
- **Fully local / privacy (see [ADR-007](DECISIONS.md)):** run Gemma 3/4 yourself,
  or `mistralai/mistral-small-3.2-24b` — all open-weights, vision + structured.
  Point `llm.baseUrl` at your endpoint; if your serving stack doesn't honor
  `json_schema`, set `structuredOutput: false` (below). For text-only local,
  `qwen-2.5-7b`/`llama-3.3-70b` are strong and tiny.
- **Zero-budget / testing: `google/gemma-4-26b-a4b-it:free`** — free, and unlike
  most free tiers it keeps vision + structured output.
- **Higher-stakes / messy input:** step up to `gpt-4o-mini` or `gemini-2.5-flash`.

## The knobs (`llm` in a project's config)

```jsonc
"llm": {
  "provider": "openrouter",              // openrouter | github-models | custom | off
  "model": "google/gemma-3-27b-it",      // open-weights → same model runs local
  "baseUrl": "https://openrouter.ai/api/v1", // set for LiteLLM/Ollama/vLLM/custom
  "dailyBudget": 200,                    // calls/day cap (cost guard)
  "structuredOutput": true               // ↓ see below
}
```

- **`structuredOutput`** (default `true`): sends `response_format: json_schema`.
  Turn it **off** for endpoints that don't support strict schema (free OpenRouter
  tiers, most Ollama/vLLM setups) — otherwise they return empty content and every
  extraction degrades. With it off, FeedbackKit relies on the prompt plus a
  fence-tolerant parser (it strips ` ```json ` fences), which the smoke test
  confirmed works well on models that only emit best-effort JSON.
- **`provider: "off"`** disables the LLM entirely (kill switch): the widget shows
  plain required-field forms. Same effect if no `LLM_API_KEY` is set.
- Extraction never blocks: any LLM failure degrades to create-anyway or manual
  required-field entry (never a lost submission) — see [ADR-005](DECISIONS.md).

## Reproduce this yourself

```bash
# 1) list models with pricing + capabilities
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OR_KEY" \
  | jq -r '.data[] | select((.architecture.input_modalities//[]|index("image")) and
      (.supported_parameters//[]|index("structured_outputs")))
      | "\(.id)\tin$\((.pricing.prompt|tonumber)*1e6)/M\tout$\((.pricing.completion|tonumber)*1e6)/M"'
# 2) smoke-test extraction quality/latency against your own field set + language
```
