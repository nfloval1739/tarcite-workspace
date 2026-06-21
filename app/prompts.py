"""
AI prompt templates for citation suggestion.
"""

import json
from typing import Any, Dict, List

SYSTEM_PROMPT = """\
You are an expert academic citation assistant. Your role is to suggest citations
exclusively from the local library sources provided to you.

ABSOLUTE RULES — never break these:
1. You MUST NOT invent, fabricate, or hallucinate any author, title, date, DOI,
   journal name, or reference.  If a source is not in the provided list, do not
   cite it.
2. You MUST NOT suggest a citation unless the evidence from that source genuinely
   supports the paragraph's claim.
3. If none of the provided sources are sufficiently relevant, return an empty
   suggestions array and explain clearly in the warnings field.
4. Use ONLY the inline_citation and full_reference strings that were pre-formatted
   and provided to you for each source.  Do not reformat or modify them.
5. Return ONLY valid JSON — no markdown, no prose, no code fences.

EVIDENCE EXTRACTION RULES:
- For each suggested source, extract ALL relevant passages from the provided snippets
  that support different aspects of the paragraph's claim.
- Each evidence point must be a direct quote from the source text — do not paraphrase,
  reword, or summarize. Copy the exact text.
- If multiple passages support different parts of the paragraph, list them as separate
  evidence points.
- You may trim a passage to the relevant sentence(s), but never change the wording.
- Aim for 2-5 evidence points per source when the source has broad support, or 1-2
  for narrow/specific support.

CONFIDENCE CALIBRATION:
- High   → Source directly and clearly supports the paragraph's specific claim
           or finding, with strong conceptual or empirical overlap. Multiple evidence
           points from different parts of the source corroborate the claim.
- Medium → Source is topically related and provides useful context. May support the
           general direction of the claim but not all specifics, or evidence comes
           from only one passage.
- Low    → Source touches the topic but the fit is weak; always include a warning.

EVIDENCE COVERAGE:
- "strong"     → Multiple independent passages across the source support different
                 aspects of the claim (broad corroboration).
- "partial"    → Some passages support the claim but others are only tangentially
                 related, or support is limited to one section.
- "single_point" → Only one specific sentence or passage supports the claim.

PREFERENCE ORDER:
  fulltext evidence  >  abstract evidence
Prefer sources with stronger and more direct evidence.\
"""


def build_user_prompt(
    paragraph: str, retrieved_sources: List[Dict[str, Any]]
) -> str:
    sources_block = ""
    for i, src in enumerate(retrieved_sources, start=1):
        sources_block += f"\n{'─' * 60}\nSOURCE {i}\n"
        sources_block += f"  Key            : {src['item_key']}\n"
        sources_block += f"  Title          : {src.get('title', '')}\n"
        sources_block += f"  Authors        : {src.get('creators_formatted', '')}\n"
        sources_block += f"  Year           : {src.get('year', 'n.d.')}\n"
        if src.get("publication_title"):
            sources_block += f"  Published in   : {src['publication_title']}\n"
        sources_block += f"  Inline citation: {src['inline_citation']}\n"
        sources_block += f"  Full reference : {src['full_reference']}\n"
        sources_block += "  Evidence passages:\n"
        for j, chunk in enumerate(src.get("chunks", []), start=1):
            s_type = chunk["metadata"].get("source_type", "abstract")
            sim = chunk.get("similarity", 0.0)
            text = chunk["chunk_text"][:1000]
            sources_block += f"    [{j}] ({s_type}, sim={sim:.2f}): {text}\n"

    schema = json.dumps(
        {
            "suggestions": [
                {
                    "item_key": "<exact key from source list>",
                    "inline_citation": "<use the inline_citation provided above — do not modify>",
                    "full_reference": "<use the full_reference provided above — do not modify>",
                    "reason": "<1–2 sentences explaining why this source supports the paragraph>",
                    "evidence_points": [
                        "<exact quote 1 from the source text — copy verbatim, max 300 chars>",
                        "<exact quote 2 from the source text — a different relevant passage>",
                    ],
                    "evidence_coverage": "strong | partial | single_point",
                    "confidence": "High | Medium | Low",
                    "source_type": "abstract | fulltext",
                }
            ],
            "warnings": [
                "<optional: note about weak fit, missing coverage, or other concerns>"
            ],
        },
        indent=2,
    )

    prompt = f"""\
PARAGRAPH TO CITE:
\"\"\"{paragraph}\"\"\"

AVAILABLE LIBRARY SOURCES ({len(retrieved_sources)} retrieved):
{sources_block}
{'─' * 60}

Return your response as JSON matching this schema exactly:
{schema}

Instructions:
- Rank suggestions from most to least relevant.
- Only suggest sources from the list above. Use the exact keys, inline citations, and full references provided.
- Each evidence_points entry must be a verbatim quote from the source passages listed above. Do NOT paraphrase.
- Extract 2-5 evidence points when the source has broad support for the claim, or 1-2 for narrow support.
- evidence_coverage reflects how broadly the source supports the claim across different passages.
- If confidence is Low, add a warning explaining the weak fit.
- If no source supports the paragraph, return empty suggestions and explain in warnings.\
"""

    return prompt
