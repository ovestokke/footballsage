from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class SageConfigError(RuntimeError):
    pass


class SageLLMError(RuntimeError):
    pass


@dataclass(frozen=True)
class SageLLMConfig:
    provider: str
    model: str
    api_key: str
    base_url: str | None = None


ROOT = Path(__file__).resolve().parents[3]

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except ImportError:
    pass


SAGE_SYSTEM_PROMPT = """You are Sage, an AI fantasy football advisor for FootballSage.

You give next-round transfer, captaincy, bench and risk advice. You must ground every
claim in the JSON context supplied by the application. Do not invent injuries, weather,
odds, lineups, ownership, prices, fixtures, or expected points. If a useful signal is
missing, put it in data_gaps instead of guessing.

Prioritize transfers that improve starters, captaincy, or players with no fixture.
Bench goalkeeper transfers are usually low priority unless they free meaningful budget,
the user has surplus free transfers, or the user explicitly says the bench goalkeeper matters.
If the user gives feedback on a previous recommendation, revise the advice and explain how
the priority changed. When previous_advice is present, it contains only the recommendations
the user selected for follow-up; focus the revision on those selected recommendations.

Return JSON only with this shape:
{
  "summary": string,
  "priority_actions": [
    {
      "kind": "transfer" | "captain" | "bench" | "monitor" | "hold",
      "title": string,
      "reason": string,
      "confidence": "low" | "medium" | "high",
      "out_player_id": string | null,
      "in_player_id": string | null,
      "expected_points_delta": number | null,
      "risks": [string]
    }
  ],
  "transfer_advice": [
    {
      "out_player_id": string,
      "in_player_id": string,
      "reason": string,
      "expected_points_delta": number | null,
      "confidence": "low" | "medium" | "high"
    }
  ],
  "captain_advice": {
    "captain_player_id": string | null,
    "vice_captain_player_id": string | null,
    "reason": string
  },
  "problems_found": [
    {"player_id": string | null, "problem": string, "severity": "low" | "medium" | "high", "evidence": string}
  ],
  "risks": [string],
  "data_gaps": [string]
}
"""


def load_llm_config() -> SageLLMConfig:
    return _load_llm_config(prefix="SAGE")


def load_ocr_config() -> SageLLMConfig:
    config = load_llm_config()
    provider_override = os.environ.get("SAGE_OCR_LLM_PROVIDER")
    model_override = os.environ.get("SAGE_OCR_LLM_MODEL")
    if provider_override or model_override:
        return _load_llm_config(prefix="SAGE_OCR")
    if config.provider == "openrouter":
        # Keep DeepSeek/etc. available for advice, but default screenshot OCR to
        # a vision model when the user has only configured one OpenRouter key.
        return SageLLMConfig(
            provider=config.provider,
            model="google/gemini-3-flash-preview",
            api_key=config.api_key,
            base_url=config.base_url,
        )
    return config


def _load_llm_config(*, prefix: str) -> SageLLMConfig:
    provider = os.environ.get(f"{prefix}_LLM_PROVIDER") or os.environ.get("SAGE_LLM_PROVIDER", "")
    provider = provider.strip().lower()
    if provider not in {"openai", "openrouter", "anthropic"}:
        raise SageConfigError("Sage requires SAGE_LLM_PROVIDER=openai|openrouter|anthropic")

    model = os.environ.get(f"{prefix}_LLM_MODEL") or os.environ.get("SAGE_LLM_MODEL", "")
    model = model.strip()
    if not model:
        raise SageConfigError(f"Sage requires {prefix}_LLM_MODEL or SAGE_LLM_MODEL")

    if provider == "openai":
        api_key = os.environ.get(f"{prefix}_OPENAI_API_KEY") or os.environ.get("SAGE_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
        base_url = os.environ.get(f"{prefix}_OPENAI_BASE_URL") or os.environ.get("SAGE_OPENAI_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    elif provider == "openrouter":
        api_key = os.environ.get(f"{prefix}_OPENROUTER_API_KEY") or os.environ.get("SAGE_OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
        base_url = os.environ.get(f"{prefix}_OPENROUTER_BASE_URL") or os.environ.get("SAGE_OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
    else:
        api_key = os.environ.get(f"{prefix}_ANTHROPIC_API_KEY") or os.environ.get("SAGE_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
        base_url = os.environ.get(f"{prefix}_ANTHROPIC_BASE_URL") or os.environ.get("SAGE_ANTHROPIC_BASE_URL")

    if not api_key:
        raise SageConfigError(f"Sage requires an API key for provider '{provider}'")

    return SageLLMConfig(provider=provider, model=model, api_key=api_key, base_url=base_url or None)


def compact_player(player: dict[str, Any], lineup_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    fixture = player.get("next_fixture") or {}
    return {
        "player_id": player.get("player_id"),
        "name": player.get("name"),
        "team": player.get("team"),
        "team_abbr": player.get("team_abbr"),
        "position": player.get("position"),
        "price": player.get("price"),
        "status": player.get("status"),
        "expected_points": player.get("expected_points"),
        "mapping_status": player.get("mapping_status"),
        "role": (lineup_meta or {}).get("role"),
        "is_captain": (lineup_meta or {}).get("is_captain", False),
        "is_vice_captain": (lineup_meta or {}).get("is_vice_captain", False),
        "fixture": {
            "opponent": fixture.get("opponent"),
            "opponent_code": fixture.get("opponent_code"),
            "difficulty": fixture.get("difficulty"),
            "kickoff_utc": fixture.get("kickoff_utc"),
        }
        if fixture
        else None,
        "reasons": player.get("reasons", [])[:5],
    }


def build_sage_context(
    *,
    question: str,
    risk_profile: str,
    free_transfers: int,
    bank: float,
    analysis: dict[str, Any],
    available_players: list[dict[str, Any]],
    previous_advice: dict[str, Any] | None = None,
    user_feedback: str | None = None,
) -> dict[str, Any]:
    selected = analysis.get("selected_players", [])
    lineup = analysis.get("lineup", [])
    selected_ids = {player.get("player_id") for player in selected}
    lineup_meta_by_id = {
        line.get("player", {}).get("player_id"): {
            "role": line.get("role"),
            "is_captain": line.get("is_captain"),
            "is_vice_captain": line.get("is_vice_captain"),
        }
        for line in lineup
        if line.get("player", {}).get("player_id")
    }
    issue_player_ids = {issue.get("player_id") for issue in analysis.get("issues", []) if issue.get("player_id")}

    problem_players = _problem_players(selected, analysis.get("issues", []), issue_player_ids, lineup_meta_by_id)
    if not problem_players:
        problem_players = _low_signal_players(selected, lineup_meta_by_id, limit=4)

    transfer_candidates = {
        player["player_id"]: _replacement_candidates(player, available_players, selected_ids, bank)
        for player in problem_players
        if player.get("player_id")
    }
    captain_candidates = _captain_candidates(lineup)

    return {
        "user_question": question,
        "user_feedback": user_feedback,
        "previous_advice": previous_advice,
        "rules": {
            "free_transfers": free_transfers,
            "bank": bank,
            "risk_profile": risk_profile,
            "provider": analysis.get("provider"),
            "round": analysis.get("round"),
            "budget": analysis.get("budget"),
            "max_players_per_country": 3,
        },
        "team_analysis": {
            "total_price": analysis.get("total_price"),
            "remaining_budget": analysis.get("remaining_budget"),
            "expected_points": analysis.get("expected_points"),
            "player_count": analysis.get("player_count"),
            "position_counts": analysis.get("position_counts"),
            "issues": analysis.get("issues", []),
        },
        "squad": [compact_player(player, lineup_meta_by_id.get(player.get("player_id"))) for player in selected],
        "lineup": [
            {
                "player": compact_player(
                    line.get("player", {}),
                    {
                        "role": line.get("role"),
                        "is_captain": line.get("is_captain"),
                        "is_vice_captain": line.get("is_vice_captain"),
                    },
                ),
                "role": line.get("role"),
                "is_captain": line.get("is_captain"),
                "is_vice_captain": line.get("is_vice_captain"),
            }
            for line in lineup
        ],
        "problem_players": [compact_player(player, lineup_meta_by_id.get(player.get("player_id"))) for player in problem_players],
        "transfer_candidates": transfer_candidates,
        "captain_candidates": captain_candidates,
        "data_gaps": [
            "No live injury/suspension/news feed is connected yet.",
            "No weather feed is connected yet.",
            "Expected points are v1 projections from local fantasy data, not a full odds/minutes model yet.",
        ],
    }


def _problem_players(
    selected: list[dict[str, Any]],
    issues: list[dict[str, Any]],
    issue_player_ids: set[str],
    lineup_meta_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    by_id = {player.get("player_id"): player for player in selected}
    result = [by_id[player_id] for player_id in issue_player_ids if player_id in by_id]
    for player in selected:
        if player.get("status") != "playing" or not player.get("next_fixture"):
            if player not in result:
                result.append(player)
    if any(issue.get("code") == "country_limit" for issue in issues):
        result.extend(player for player in _low_signal_players(selected, lineup_meta_by_id, limit=5) if player not in result)
    return sorted(result, key=lambda player: _player_priority_key(player, lineup_meta_by_id))[:8]


def _low_signal_players(
    selected: list[dict[str, Any]], lineup_meta_by_id: dict[str, dict[str, Any]], *, limit: int
) -> list[dict[str, Any]]:
    return sorted(selected, key=lambda player: _player_priority_key(player, lineup_meta_by_id))[:limit]


def _player_priority_key(player: dict[str, Any], lineup_meta_by_id: dict[str, dict[str, Any]]) -> tuple[int, float, float]:
    meta = lineup_meta_by_id.get(player.get("player_id"), {})
    role = meta.get("role") or "starter"
    position = player.get("position")
    has_no_fixture = not player.get("next_fixture")
    bad_status = player.get("status") != "playing"
    if role == "starter" or meta.get("is_captain") or meta.get("is_vice_captain") or has_no_fixture or bad_status:
        role_priority = 0
    elif position == "GK":
        role_priority = 3
    else:
        role_priority = 2
    expected_points = player.get("expected_points") if isinstance(player.get("expected_points"), int | float) else 999
    price = player.get("price") if isinstance(player.get("price"), int | float) else 0
    return (role_priority, expected_points, -price)


def _replacement_candidates(
    player: dict[str, Any], available_players: list[dict[str, Any]], selected_ids: set[str], bank: float
) -> list[dict[str, Any]]:
    position = player.get("position")
    max_price = float(player.get("price") or 0) + max(bank, 0)
    candidates = []
    for candidate in available_players:
        if candidate.get("player_id") in selected_ids:
            continue
        if candidate.get("position") != position:
            continue
        if candidate.get("status") != "playing":
            continue
        if not candidate.get("next_fixture"):
            continue
        if float(candidate.get("price") or 0) > max_price + 0.001:
            continue
        delta = round(float(candidate.get("expected_points") or 0) - float(player.get("expected_points") or 0), 2)
        compact = compact_player(candidate)
        compact["expected_points_delta"] = delta
        candidates.append(compact)

    return sorted(candidates, key=lambda item: (item["expected_points_delta"], item.get("expected_points") or 0), reverse=True)[:3]


def _captain_candidates(lineup: list[dict[str, Any]]) -> list[dict[str, Any]]:
    starters = [line.get("player", {}) for line in lineup if line.get("role") == "starter"]
    starters = [player for player in starters if player.get("status") == "playing" and player.get("next_fixture")]
    return [compact_player(player) for player in sorted(starters, key=lambda player: player.get("expected_points") or 0, reverse=True)[:6]]


def generate_sage_advice(context: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    config = load_llm_config()
    user_prompt = "Application context JSON:\n" + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    advice = call_llm_json(config, SAGE_SYSTEM_PROMPT, user_prompt)
    return advice, {"provider": config.provider, "model": config.model}


def ocr_team_screenshot(image_data_url: str) -> tuple[str, dict[str, str]]:
    config = load_ocr_config()
    if config.provider not in {"openai", "openrouter"}:
        raise SageConfigError("LLM screenshot OCR currently requires openai/openrouter")
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise SageConfigError("Install the openai package to use LLM screenshot OCR") from exc

    if not image_data_url.startswith("data:image/"):
        image_data_url = f"data:image/png;base64,{image_data_url}"

    prompt = """Extract the 15 fantasy football players from this screenshot.
Return exactly one player per line using this pipe-separated format:
role|captain_marker|player name

Rules:
- role must be starter or bench.
- captain_marker must be C, VC, or none.
- Bench players are marked with a small "B" badge; do not read the B as part of the player name, but set role=bench.
- Captain and vice-captain are marked with small "C" and "VC" badges; set captain_marker accordingly, but do not read those badges as part of the player name.
- Ignore countries, opponents, prices, points, table headings, and pitch labels.
- Preserve accents when readable. If a name is uncertain, still output the most likely real player name.

Example:
starter|C|Erling Haaland
starter|VC|Alexander Isak
bench|none|Vitinha
"""
    client = OpenAI(api_key=config.api_key, base_url=config.base_url, timeout=45.0)
    try:
        response = client.chat.completions.create(
            model=config.model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                }
            ],
            temperature=0,
        )
    except Exception as exc:
        raise SageLLMError(f"OCR API call failed: {type(exc).__name__}") from exc
    content = (response.choices[0].message.content or "").strip()
    if not content:
        raise SageLLMError("LLM OCR returned no text")
    return _clean_ocr_names(content), {"provider": config.provider, "model": config.model}


def _clean_ocr_names(content: str) -> str:
    lines = []
    for line in content.splitlines():
        line = line.strip().strip("-•*0123456789. ")
        if not line or line.startswith("```"):
            continue
        if ":" in line and len(line.split(":", 1)[0]) < 16:
            line = line.split(":", 1)[1].strip()
        lines.append(line)
    return "\n".join(lines[:20])


def call_llm_json(config: SageLLMConfig, system_prompt: str, user_prompt: str) -> dict[str, Any]:
    if config.provider in {"openai", "openrouter"}:
        return _call_openai_compatible(config, system_prompt, user_prompt)
    if config.provider == "anthropic":
        return _call_anthropic(config, system_prompt, user_prompt)
    raise SageConfigError(f"Unsupported Sage provider: {config.provider}")


def _call_openai_compatible(config: SageLLMConfig, system_prompt: str, user_prompt: str) -> dict[str, Any]:
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise SageConfigError("Install the openai package to use Sage with openai/openrouter") from exc

    client = OpenAI(api_key=config.api_key, base_url=config.base_url, timeout=45.0)
    try:
        response = client.chat.completions.create(
            model=config.model,
            messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
    except Exception as exc:
        raise SageLLMError(f"LLM API call failed: {type(exc).__name__}") from exc
    content = response.choices[0].message.content or ""
    return _parse_json(content)


def _call_anthropic(config: SageLLMConfig, system_prompt: str, user_prompt: str) -> dict[str, Any]:
    try:
        from anthropic import Anthropic
    except ImportError as exc:
        raise SageConfigError("Install the anthropic package to use Sage with anthropic") from exc

    kwargs: dict[str, Any] = {"api_key": config.api_key}
    if config.base_url:
        kwargs["base_url"] = config.base_url
    client = Anthropic(**kwargs)
    response = client.messages.create(
        model=config.model,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt + "\n\nReturn JSON only."}],
        max_tokens=2500,
        temperature=0.2,
    )
    content = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
    return _parse_json(content)


def _parse_json(content: str) -> dict[str, Any]:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}")
        if start < 0 or end <= start:
            raise SageLLMError("Sage LLM did not return JSON")
        try:
            parsed = json.loads(content[start : end + 1])
        except json.JSONDecodeError as exc:
            raise SageLLMError("Sage LLM returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise SageLLMError("Sage LLM JSON response must be an object")
    return parsed
