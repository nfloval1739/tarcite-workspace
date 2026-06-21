# Profile Tuning Log

Benchmark results from tuning each AI profile's `suggestion_top_k` and `suggestion_temperature`.
Update this file whenever a new model is tested or an existing profile is re-tuned.

## Test Methodology

- **Benchmark paragraph:** *"A long-standing drought index has been developed to quantify water deficits. PDSI uses a soil water balance model."*
- **Ground truth** (manually evaluated by Claude): 4 correct citations exist in the library
  1. Zhang et al. (2019) — *A water-energy balance approach…* — High / strong (best match, verbatim PDSI bucket model evidence)
  2. Wang et al. (2022) — *Historical and future PDSI with improved hydrological modeling* — High / strong
  3. Mishra & Singh (2010) — *A review of drought concepts* — High (review paper, ideal for introducing PDSI)
  4. Zhang et al. (2019) — *Attributing changes in future extreme droughts based on PDSI in China* — Medium / partial
- **Pipeline:** HyDE → triple retrieval → cross-encoder rerank → LLM evaluation
- **What we're tuning:** Only the LLM evaluation stage (top_k = candidates sent to LLM, temperature = LLM sampling)

---

## Profiles & Current Settings

| Profile | Model | Top K | Temp | Status |
|---|---|---|---|---|
| Local qwen2.5:3b | qwen2.5:3b (Ollama) | 10 | 0.1 | Tuned ✓ |
| Default | gpt-oss-120b (NVIDIA NIM, primary) + nemotron-3-nano-30b-a3b (backup) | 40 | 0.1 | Tuned ✓ |
| Premium | see backend log below | 15 | 0.05 | Tuned ✓ |
| qwen3.6-plus | qwen3.6-plus (OpenCode GO) | 50 | 0.2 | Not yet tuned |
| XIAOMI | mimo-v2.5 | 50 | 0.15 | Not yet tuned |
| XIOAMI_1 | mimo-v2-flash | 50 | 0.15 | Not yet tuned |

---openai/gpt-oss-120b

## Backend Rankings

### Default Profile — Final Ranking

| Rank | Backend | Top K | Temp | Time | Quality | Notes |
|---|---|---|---|---|---|---|
| 🥇 1 | gpt-oss-120b | 40 | 0.1 | 24.6s | 4/4 | Best overall |
| 🥈 2 | step-3.5-flash | 40 | 0.1 | 24.8s | 3/4 | Fastest, 1 miss |
| 🥉 3 | kimi-k2.6 | 40 | 0.1 | 30s | 4/4 | Best quality tie |
| 4 | llama-3.3-70b-instruct | 15 | 0.1 | 45s | 3/4 | Good fallback |
| 5 | minimax-m2.7 | 15 | 0.1 | ~60s | 1/4 | Slow, low recall |
| 6 | mistral-medium-3.5-128b | 40 | 0.1 | 96s | 3/4 | Too slow |
| ✗ | nemotron-nano-30b-a3b | 15 | 0.1 | 27s | 0/4 | Not suitable |
| ✗ | nemotron-super-49b | — | — | >120s | — | Timeout |
| ✗ | gemma-4-31b-it | — | — | >120s | — | Timeout |

> **Speed vs quality trade-off:** gpt-oss-120b is the best overall (fastest large model + highest recall). step-3.5-flash ties on speed but misses 1 citation. kimi-k2.6 matches quality but is 5s slower.

### Premium Profile — Final Ranking

| Rank | Backend | Top K | Temp | Time | Quality | Notes |
|---|---|---|---|---|---|---|
| 🥇 1 | mimo-v2-flash | 15 | 0.05 | 11.5s | 3/3 | Fastest |
| 🥈 2 | gemini-3.1-flash-lite | 15 | 0.05 | 14.7s | 3/3 | Reliable |
| 🥉 3 | GLM 5.1 | 40 | 0.1 | 48.4s | 3/3 | Accurate but slow |

> All 3 Premium backends return identical quality (same 3 correct papers). Ranking is purely on speed. Universal safe settings: **Top K 15, Temp 0.05**.

---

## Tuning Results by Profile

### Local qwen2.5:3b

**Architecture:** 3B dense, 16K context window (Ollama local)

**Key finding:** Context window ≠ reasoning quality. At top_k=50, the model got overwhelmed and returned Hatmoko et al. 2015 (SRI paper, wrong). Effective reasoning window is ~4K tokens for this model.

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 50 | 0.5 | ~20s | 1 — **wrong** (Hatmoko et al.) | Original default, failed |
| 10 | 0.1 | ~20s | 1 — correct (Zhang 2019) | Sweet spot |
| 10 | 0.2 | ~20s | 1 — **wrong** (Eshetie et al.) | Higher temp broke it |

**Settled:** Top K = 10, Temp = 0.1

---

### Default (gpt-oss-120b primary / nemotron-3-nano-30b-a3b backup)

**Architecture:** 120B dense primary (NVIDIA NIM API). Backup is MoE 30B total / 3B active.

#### Backend: gpt-oss-120b

**Key finding:** 120B handles top_k=40 easily. No wrong picks, consistent results.

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 24.6s | 4 — all correct | Best overall result across all profiles |

**Settled:** Top K = 40, Temp = 0.1

#### Backend: moonshotai/kimi-k2.6

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 15 | 0.1 | 30s | 4 correct | All High, no wrong picks |
| 25 | 0.1 | 37s | 5 — 1 wrong (dos Santos soil moisture) | Slight degradation |
| 40 | 0.1 | 30s | 4 correct | Matches gpt-oss-120b result exactly |

**Settled:** Top K 40, Temp 0.1. Near-identical to gpt-oss-120b (30s vs 24.6s, same 4/4 quality). Excellent Default backend.

#### Backend: stepfun-ai/step-3.5-flash

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 24.8s | 3 correct | Clean, no wrong picks |
| 50 | 0.1 | 40s | 4 correct + Gebrechorkos (wrong) | Ceiling broken |
| 60 | 0.1 | 48s | same as 50 | No improvement |

**Settled:** Top K 40, Temp 0.1. Ties gpt-oss-120b on speed (24.8s vs 24.6s), 3/4 correct. Good fast alternative for Default.

#### Backend: minimaxai/minimax-m2.7

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 58s | 1 — wrong (dos Santos) | Wrong pick |
| 20 | 0.1 | 62s | 1 correct (Zhang 2019) | Only top paper |
| 15 | 0.1 | 59s | 1 correct (Zhang 2019) | Same ceiling |

**Verdict:** Consistently returns only 1 suggestion (~60s) regardless of Top K. Identifies the top paper correctly but misses the rest. Slow with small-model recall — not recommended for Default.

#### Backend: google/gemma-4-31b-it ⚠️ TOO SLOW

| Top K | Temp | Time | Notes |
|---|---|---|---|
| 40 | 0.1 | >120s timeout | — |
| 10 | 0.1 | >120s timeout | Still times out |

**Verdict:** Not usable. Times out even at Top K 10. Not recommended.

#### Backend: mistralai/mistral-medium-3.5-128b

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 96s | 3 — 1 wrong (Gebrechorkos) | Too slow, wrong pick |

**Verdict:** Too slow (~96s) for practical use. Not tuned further. Not recommended for Default.

#### Backend: meta/llama-3.3-70b-instruct

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 33s | 3 — 1 wrong (Gebrechorkos) | Too many candidates |
| 20 | 0.1 | 45s | 2 correct | Misses Wang 2022 |
| 15 | 0.1 | 45s | 3 correct | Sweet spot |

**Settled:** Top K 15, Temp 0.1. Slower than gpt-oss-120b (~45s vs 24.6s) despite smaller size — likely NVIDIA NIM queue latency. Quality good but not as high as gpt-oss-120b (3/4 vs 4/4).

#### Backend: nvidia/llama-3.3-nemotron-super-49b-v1.5

Timed out at 120s limit — too slow for practical use. Not tested further.

#### Backend: nemotron-3-nano-30b-a3b ⚠️ NOT RECOMMENDED

**Architecture:** MoE 30B total / only 3B active params. Designed for fast inference, not complex reasoning.

**Key finding:** Consistently fails to produce valid ranked JSON with evidence. Not suitable for citation evaluation regardless of Top K or temperature.

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 31.5s | **0** | Overwhelmed |
| 15 | 0.1 | 27.3s | 1 — Low/single_point | Only viable setting, poor quality |
| 15 | 0.15 | 27.7s | **0** | — |
| 10 | 0.05 | 25.8s | **0** | Too restrictive |

**Verdict:** Do not use nemotron-3-nano-30b-a3b as the Default backend. The 3B active MoE architecture cannot reliably handle multi-candidate citation evaluation. Default profile settings (Top K 40, Temp 0.1) are optimised for gpt-oss-120b as primary.

---

### Premium (backend-switchable via ci-work proxy)

**Key finding:** Settings must be tuned per backend model. Top K 15, Temp 0.05 is the safe universal default for flash/small models routed through Premium. Increase top_k only after verifying no hallucination or wrong picks.

#### Backend: mimo-v2-flash

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 19.4s | 2 + **1 hallucinated** | Anti-hallucination guard caught it |
| 40 | 0.05 | 15.6s | 2 correct + Keetch 1968 (wrong) | Hallucination gone, still wrong pick |
| 15 | 0.05 | 11.5s | 3 — all correct | Sweet spot |
| 20 | 0.05 | 15.4s | 3 — all correct | Also works, slightly more candidates |
| 25 | 0.05 | 14.0s | 2 — 1 wrong (Gebrechorkos) | Breaks here |

**Ceiling:** Top K 20. Default set to 15 (conservative, safe).

#### Backend: google/gemini-3.1-flash-lite

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 15 | 0.05 | 14.7s | 3 — all correct, all High/strong | Clean result |

**Note:** Not fully explored beyond Top K 15. Safe to use with Premium defaults.

#### Backend: GLM 5.1

| Top K | Temp | Time | Suggestions | Notes |
|---|---|---|---|---|
| 40 | 0.1 | 48.4s | 3 — all correct, all High/strong | Slow but accurate |
| 20 | 0.05 | — | — | Not tested |

**Note:** Quality matches Default but 2× slower. Could likely use lower top_k for speed.

---

## Key Learnings

### Temperature
- **0.05–0.1** is the right range for citation evaluation — it's a factual matching task, not creative generation.
- Higher temperature (0.15–0.5) causes small models to pick wrong papers or hallucinate item_keys.
- For flash/small models, prefer **0.05** over 0.1 to suppress hallucination.

### Top K
- Top K = candidates sent to the LLM after reranking. The reranker already sorted best-first, so the LLM just needs to read the top slice.
- Rule of thumb by model size:

| Model tier | Active params | Recommended Top K |
|---|---|---|
| Local small (qwen2.5:3b) | 3B | 10 |
| Flash / nano MoE (mimo-v2-flash, gemini-flash-lite) | 3B–8B active | 15–20 |
| Mid (GLM 5.1) | ~30B | 20–40 |
| Large (gpt-oss-120b) | 120B | 40 |

### Hallucination
- mimo-v2-flash hallucinated a citation key at top_k=40, temp=0.1.
- The anti-hallucination guard (item_key validation) caught it — but it means the model was generating keys from memory rather than the provided list.
- Fix: lower temp to 0.05 + lower top_k to 15. Hallucination disappeared.

### Speed vs Quality
| Profile / Backend | Time | Correct hits | Verdict |
|---|---|---|---|
| Premium mimo-v2-flash (Top K 15) | 11.5s | 3/4 | Fastest |
| Premium gemini-3.1-flash-lite (Top K 15) | 14.7s | 3/4 | Fast, reliable |
| Default gpt-oss-120b (Top K 40) | 24.6s | 4/4 | Best quality |
| Premium GLM 5.1 (Top K 40) | 48.4s | 3/4 | Slow, accurate |
| Local qwen2.5:3b (Top K 10) | ~20s | 1/4 | Limited, offline only |

**Default (gpt-oss-120b) is the best overall** — fastest among large models, highest recall (4/4), no wrong picks.

---

## How to Add a New Backend Test

1. Switch the backend on the ci-work proxy
2. Run the benchmark paragraph via API:
   ```bash
   curl -sk -N -X POST https://localhost:8000/api/suggest-citations/stream \
     -H "Content-Type: application/json" \
     -d '{"paragraph": "A long-standing drought index has been developed to quantify water deficits. PDSI uses a soil water balance model."}'
   ```
3. Note: time, number of suggestions, confidence ratings, any wrong picks or hallucinations
4. Try top_k: 15 → 20 → 25 until wrong picks appear. Back off one step.
5. If hallucination occurs, lower temp to 0.05 first, then retry top_k ladder.
6. Record results in this file under the appropriate backend section.
