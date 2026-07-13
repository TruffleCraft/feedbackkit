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
| **google/gemini-2.5-flash-lite** | 0.10 → 0.40 | ✅ | ✅ clean JSON | ~750 ms | **Recommended default.** Cheapest with vision+structured; 1M ctx. |
| **openai/gpt-5-nano** | 0.05 → 0.40 | ✅ | ✅ clean JSON | ~770 ms | Co-recommendation; cleanest output (filled `type`+`summary`); 400k ctx. |
| mistralai/mistral-small-3.2-24b | 0.075 → 0.20 | ✅ | ✅ | ~2.0 s | **Open-weights → self-hostable.** Best local/privacy pick. |
| openai/gpt-4o-mini | 0.15 → 0.60 | ✅ | ✅ | — | Battle-tested "safe middle" for messier feedback. |
| google/gemini-2.5-flash | 0.30 → 2.50 | ✅ | ✅ | — | Quality step-up; 1M ctx. |
| gemma / llama `:free` tiers | 0 | ❌ (mostly) | ⚠️ empty w/ schema | — | Zero-cost prompt tests only — not the production path. |

All four paid models above kept German verbatim and extracted every required
field in the smoke test.

## Recommendations

- **Default (hosted): `google/gemini-2.5-flash-lite`.** Extraction is not a
  reasoning task; the "lite" tier is more than enough, it's the cheapest option
  with both vision and reliable structured output, and it's fast. At the default
  200-calls/day budget this is cents per day.
- **OpenAI shops: `openai/gpt-5-nano`** — effectively tied; marginally cheaper
  input, produced the cleanest output.
- **Privacy-first / fully local (see [ADR-007](DECISIONS.md)): `mistralai/mistral-small-3.2-24b-instruct`.**
  Vision **+** structured **+** open weights → runs on-prem via vLLM or Ollama.
  Point `llm.baseUrl` at your endpoint; if your serving stack doesn't honor
  `json_schema`, set `structuredOutput: false` (below). For text-only local,
  `qwen-2.5-7b`/`llama-3.3-70b` are strong and tiny.
- **Higher-stakes / messy input:** step up to `gpt-4o-mini` or `gemini-2.5-flash`.

## The knobs (`llm` in a project's config)

```jsonc
"llm": {
  "provider": "openrouter",              // openrouter | github-models | custom | off
  "model": "google/gemini-2.5-flash-lite",
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
