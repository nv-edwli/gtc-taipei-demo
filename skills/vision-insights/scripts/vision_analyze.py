#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Vision Insights helper — call the multimodal Nemotron Omni model.

Usage:
    vision_analyze.py [options] <image> [<image> ...]

Each <image> can be:
    - A remote URL (http://... or https://...)
    - A local file path (encoded as base64 data URL automatically)

The script POSTs a chat-completions request to the multimodal endpoint and
prints the model's final answer to stdout (clean, user-facing UX).

The reasoning trace is for debugging only:
  - text mode: pass --show-reasoning to dump it to stderr
  - json mode: it's always included in the response object

If the model is cut off mid-thought (no content emitted), the reasoning
trace is surfaced as a best-effort fallback with a stderr warning.

Exit codes:
    0  success (content present, finish_reason=stop)
    2  truncated  (finish_reason=length — reasoning likely cut off, retry with --max-tokens higher)
    3  api error  (non-2xx response from the endpoint)
    4  bad input  (missing image, unreadable file, bad URL)
    5  network error
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_ENDPOINT = os.environ.get(
    "VISION_ENDPOINT",
    "http://host.openshell.internal:8000/v1/chat/completions",
)
DEFAULT_MODEL = os.environ.get(
    "VISION_MODEL",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
)
DEFAULT_MAX_TOKENS = int(os.environ.get("VISION_MAX_TOKENS", "4096"))
DEFAULT_TIMEOUT = int(os.environ.get("VISION_TIMEOUT", "180"))


# ---------------------------------------------------------------------------
# Prompt presets — each tuned to surface actionable insights for that image
# kind. The preset is appended/prepended to the user's prompt; if the user
# passes --prompt, that overrides the preset entirely.
# ---------------------------------------------------------------------------

PRESETS: dict[str, str] = {
    "auto": (
        "You are an expert visual analyst. Carefully examine the image(s).\n\n"
        "1. Identify what kind of visual this is (chart, diagram, screenshot, "
        "photo, document, dashboard, UI, scientific figure, table, code, "
        "error screen, mockup, etc.).\n"
        "2. Extract the key information relevant to that kind of visual.\n"
        "3. Note anomalies, outliers, or anything that looks off.\n"
        "4. End with three labeled sections:\n"
        "   - **Observations** — what is objectively present\n"
        "   - **Insights** — what those observations imply\n"
        "   - **Actionable Recommendations** — concrete next steps the viewer should take"
    ),
    "chart": (
        "Analyze this chart with the rigor of a data analyst.\n\n"
        "1. Identify the chart type (bar, line, scatter, pie, area, heatmap, etc.) "
        "and the axes, units, legend, and time range if applicable.\n"
        "2. Read the actual values where possible. Estimate where exact reads are not visible.\n"
        "3. Identify the dominant trend, the outliers, and any inflection points.\n"
        "4. Quantify the magnitude of changes (percent change, absolute delta, slope).\n"
        "5. Flag anything that looks suspicious: missing data, broken axes, "
        "misleading scales, cherry-picked ranges, unlabeled units.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(decisions or follow-up analyses that this chart supports)."
    ),
    "dashboard": (
        "Treat this as a multi-panel dashboard. For each panel:\n"
        "- name the metric or chart\n"
        "- read the headline value or trend\n"
        "- flag panels showing anomalies, alerts, breaches of thresholds, or "
        "unhealthy states\n\n"
        "Then synthesize across panels: which signals correlate, what is the "
        "overall system health story, and what would an operator do first.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**, "
        "ordered by urgency."
    ),
    "diagram": (
        "Analyze this diagram as a systems engineer.\n\n"
        "1. List every component, node, or block and its role.\n"
        "2. Map every connection: direction, label, protocol, or data type.\n"
        "3. Identify the entry points, exit points, and any cycles.\n"
        "4. Note bottlenecks, single points of failure, missing redundancy, "
        "ambiguous boundaries, or violations of common patterns.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(architectural or operational changes worth considering)."
    ),
    "screenshot": (
        "Analyze this UI screenshot.\n\n"
        "1. Identify the application or page (if recognizable) and the user's "
        "current context (logged-in state, mode, selected item).\n"
        "2. Transcribe visible text, especially errors, warnings, status banners, "
        "form fields, and CTAs.\n"
        "3. Describe the apparent user intent and what the next obvious action is.\n"
        "4. Flag accessibility issues, broken UI, suspicious states.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**."
    ),
    "photo": (
        "Describe this photo with the rigor of a forensic observer.\n\n"
        "1. Scene, setting, time-of-day cues, weather, location hints.\n"
        "2. Subjects: people, objects, animals, vehicles — with attributes.\n"
        "3. Activity, mood, narrative.\n"
        "4. Anything unusual, out-of-place, or potentially safety-relevant.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(what the viewer should do, ask, or investigate based on what is shown)."
    ),
    "document": (
        "Analyze this document page.\n\n"
        "1. Identify the document type (form, contract, invoice, paper, report, etc.).\n"
        "2. Transcribe headings, key fields, totals, dates, signatures, and any "
        "highlighted or marked text.\n"
        "3. Summarize the document's intent.\n"
        "4. Flag missing fields, inconsistencies, or anything that needs the "
        "reader's attention.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**."
    ),
    "table": (
        "Analyze this table.\n\n"
        "1. Read column headers and units. Read every row you can clearly see; "
        "note where rows are unreadable.\n"
        "2. Identify the highest, lowest, and median values per relevant column.\n"
        "3. Look for outliers, missing cells, formatting that suggests special "
        "handling (bold, color, asterisks).\n"
        "4. Compute simple aggregates if useful (sum, mean, ratio).\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**."
    ),
    "code": (
        "This is a screenshot of code or a terminal.\n\n"
        "1. Identify the language and what the code is doing.\n"
        "2. Transcribe the code accurately. Note syntax-highlighting cues.\n"
        "3. Identify bugs, code smells, security issues, or performance concerns.\n"
        "4. If the screenshot shows an error or stack trace, identify the root "
        "cause and the line responsible.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(specific code changes or next debugging steps)."
    ),
    "scientific": (
        "Analyze this scientific figure as a peer reviewer.\n\n"
        "1. Identify the figure type (plot, micrograph, gel, schematic, etc.) "
        "and what variable is being shown.\n"
        "2. Read axes, error bars, sample sizes, statistical annotations.\n"
        "3. Describe the main result the figure is making.\n"
        "4. Critique: is the claim supported by what is shown? Are there "
        "alternative explanations? Confounders? Missing controls?\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(experiments or analyses that would strengthen the claim)."
    ),
    "compare": (
        "You are given multiple images to compare. Examine each in turn, then:\n\n"
        "1. List what is the same across the images.\n"
        "2. List what is different — be precise about what changed and by how much.\n"
        "3. If these look like before/after, identify regressions and improvements.\n"
        "4. If these look like A/B variants, recommend which is stronger and why.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**."
    ),
    "ui-mock": (
        "Analyze this UI mockup or wireframe as a senior designer.\n\n"
        "1. Identify the screen's purpose and target user task.\n"
        "2. Critique layout, hierarchy, affordances, copy, accessibility, and "
        "consistency with common platform conventions.\n"
        "3. Identify edge cases or states the mockup doesn't cover.\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations** "
        "(specific design changes ranked by impact)."
    ),
    "error": (
        "This image shows an error, crash, or failure state.\n\n"
        "1. Transcribe every error message, code, stack frame, and timestamp.\n"
        "2. Identify the failing component and the immediate cause.\n"
        "3. Hypothesize the root cause given the visible context.\n"
        "4. Suggest the next diagnostic step (log to check, command to run, "
        "config to verify).\n\n"
        "End with **Observations**, **Insights**, **Actionable Recommendations**."
    ),
    "medical": (
        "Describe this medical or biological image objectively.\n\n"
        "IMPORTANT: Do NOT issue diagnoses or clinical recommendations. "
        "Describe what is visible only.\n\n"
        "1. Modality (X-ray, MRI, histology, dermatology photo, etc.) if identifiable.\n"
        "2. Anatomical or structural features visible.\n"
        "3. Notable visual features (asymmetry, density, coloration, artifacts).\n"
        "4. Image-quality issues (blur, cropping, exposure).\n\n"
        "End with **Observations** and **Suggestions for Follow-up** "
        "(what a qualified clinician might want to examine — never a diagnosis)."
    ),
}


# ---------------------------------------------------------------------------
# Image handling
# ---------------------------------------------------------------------------

def _is_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://") or s.startswith("data:")


def _file_to_data_url(path: str) -> str:
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"[bad input] image not found: {path}")
    if not p.is_file():
        raise SystemExit(f"[bad input] not a regular file: {path}")
    mime, _ = mimetypes.guess_type(str(p))
    if mime is None or not mime.startswith("image/"):
        # fall back to image/jpeg if extension is unknown but file exists
        mime = "image/jpeg"
    data = p.read_bytes()
    if len(data) == 0:
        raise SystemExit(f"[bad input] image is empty: {path}")
    if len(data) > 20 * 1024 * 1024:
        print(
            f"[warn] image {path} is {len(data) // (1024*1024)}MB — large images "
            "may be rejected or slow to process",
            file=sys.stderr,
        )
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _normalize_image(image: str) -> str:
    if _is_url(image):
        return image
    return _file_to_data_url(image)


# ---------------------------------------------------------------------------
# Request building
# ---------------------------------------------------------------------------

def _build_messages(prompt: str, images: list[str]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": img}})
    return [{"role": "user", "content": content}]


def _build_payload(
    prompt: str,
    images: list[str],
    *,
    model: str,
    max_tokens: int,
    temperature: float | None,
    top_p: float | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": _build_messages(prompt, images),
        "max_tokens": max_tokens,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if top_p is not None:
        payload["top_p"] = top_p
    return payload


def _post_json(url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        print(f"[api error] HTTP {e.code} from {url}", file=sys.stderr)
        if err_body:
            print(err_body, file=sys.stderr)
        sys.exit(3)
    except urllib.error.URLError as e:
        print(f"[network error] {e.reason} contacting {url}", file=sys.stderr)
        sys.exit(5)


# ---------------------------------------------------------------------------
# Response interpretation
# ---------------------------------------------------------------------------

def _extract(resp: dict[str, Any]) -> dict[str, Any]:
    """Return a flat dict with reasoning, content, finish_reason, usage."""
    choices = resp.get("choices") or []
    if not choices:
        return {
            "reasoning": "",
            "content": "",
            "finish_reason": None,
            "usage": resp.get("usage"),
            "raw": resp,
        }
    choice = choices[0]
    msg = choice.get("message") or {}
    return {
        "reasoning": msg.get("reasoning") or "",
        "content": msg.get("content") or "",
        "finish_reason": choice.get("finish_reason"),
        "usage": resp.get("usage"),
        "model": resp.get("model"),
        "raw": resp,
    }


def _print_text(extracted: dict[str, Any], *, show_reasoning: bool) -> None:
    """Print user-facing output.

    Default: print only the final answer (clean UX).
    With show_reasoning=True: also print the reasoning trace before the answer
    (for debugging / when verifying the model's analysis).
    """
    finish = extracted.get("finish_reason")
    reasoning = extracted.get("reasoning") or ""
    content = extracted.get("content") or ""
    usage = extracted.get("usage") or {}

    if show_reasoning and reasoning:
        print("=" * 70, file=sys.stderr)
        print("MODEL REASONING (debug — thinking trace)", file=sys.stderr)
        print("=" * 70, file=sys.stderr)
        print(reasoning.strip(), file=sys.stderr)
        print(file=sys.stderr)
        print("=" * 70, file=sys.stderr)
        print("FINAL ANSWER", file=sys.stderr)
        print("=" * 70, file=sys.stderr)

    if content:
        print(content.strip())
    elif reasoning:
        # Fallback: content empty (likely truncated). Surface the reasoning
        # so the user sees *something*, with a clear warning.
        print(reasoning.strip())
        print(
            "\n[warn] no final answer was returned — the text above is the "
            "model's truncated reasoning trace, surfaced as a best-effort "
            "fallback. Re-run with a larger --max-tokens to get a clean answer.",
            file=sys.stderr,
        )
    else:
        print("(no content returned)")

    if show_reasoning:
        print(file=sys.stderr)
        print("-" * 70, file=sys.stderr)
        print(f"finish_reason: {finish}", file=sys.stderr)
        if usage:
            print(
                f"tokens: prompt={usage.get('prompt_tokens')}, "
                f"completion={usage.get('completion_tokens')}, "
                f"total={usage.get('total_tokens')}",
                file=sys.stderr,
            )

    if finish == "length" and content:
        # Content present but cut off — quiet stderr note, doesn't disrupt UX.
        print(
            "[note] response was truncated (finish_reason=length). Re-run with "
            "a larger --max-tokens for a complete answer.",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        prog="vision_analyze",
        description=(
            "Send images to the Nemotron Omni multimodal model and print the "
            "reasoning trace plus final answer."
        ),
    )
    p.add_argument(
        "images",
        nargs="+",
        help="Image URLs or local file paths. Multiple allowed.",
    )
    p.add_argument(
        "--prompt",
        help=(
            "Custom user prompt. Overrides --preset. If neither is set, the "
            "'auto' preset is used."
        ),
    )
    p.add_argument(
        "--preset",
        choices=sorted(PRESETS.keys()),
        default="auto",
        help="Prompt template tuned for a specific kind of image.",
    )
    p.add_argument(
        "--max-tokens",
        type=int,
        default=DEFAULT_MAX_TOKENS,
        help=(
            "Max output tokens. The reasoning model emits its thinking trace "
            "in this budget too — use 4096+ for substantive analyses, 8192+ "
            "for dense charts/diagrams. Default: %(default)s."
        ),
    )
    p.add_argument(
        "--temperature",
        type=float,
        default=None,
        help="Sampling temperature (omit to use server default).",
    )
    p.add_argument(
        "--top-p",
        type=float,
        default=None,
        help="Nucleus sampling top_p (omit to use server default).",
    )
    p.add_argument(
        "--endpoint",
        default=DEFAULT_ENDPOINT,
        help=f"Chat completions endpoint URL. Default: {DEFAULT_ENDPOINT}",
    )
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Model id. Default: {DEFAULT_MODEL}",
    )
    p.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="HTTP timeout seconds. Default: %(default)s",
    )
    p.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format. 'text' is human-readable; 'json' is machine-readable.",
    )
    p.add_argument(
        "--show-reasoning",
        action="store_true",
        help=(
            "Print the model's reasoning trace to stderr before the final "
            "answer. Off by default — reasoning is for debugging only. "
            "JSON output always includes reasoning regardless of this flag."
        ),
    )
    args = p.parse_args(argv)

    prompt = args.prompt if args.prompt else PRESETS[args.preset]

    images: list[str] = []
    for raw in args.images:
        images.append(_normalize_image(raw))

    payload = _build_payload(
        prompt=prompt,
        images=images,
        model=args.model,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
    )

    resp = _post_json(args.endpoint, payload, args.timeout)
    extracted = _extract(resp)

    if args.format == "json":
        out = {
            "reasoning": extracted["reasoning"],
            "content": extracted["content"],
            "finish_reason": extracted["finish_reason"],
            "usage": extracted["usage"],
            "model": extracted.get("model"),
        }
        print(json.dumps(out, indent=2))
    else:
        _print_text(extracted, show_reasoning=args.show_reasoning)

    if extracted["finish_reason"] == "length":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
