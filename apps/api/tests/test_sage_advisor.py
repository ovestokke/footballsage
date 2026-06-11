from fastapi.testclient import TestClient

from footballsage_api import sage_advisor
from footballsage_api.main import app


SAMPLE_TEAM = """
Emiliano Martínez
Gerónimo Rulli
Cristian Romero
Lisandro Martínez
Nahuel Molina
Nicolás Otamendi
Nicolás Tagliafico
Alexis Mac Allister
Enzo Fernández
Rodrigo De Paul
Giovani Lo Celso
Exequiel Palacios
Lionel Messi
Lautaro Martínez
Julián Alvarez
""".strip()


def _sample_selections(client: TestClient) -> list[dict[str, object]]:
    response = client.post("/team/import-text", json={"provider": "tv2", "text": SAMPLE_TEAM})
    assert response.status_code == 200
    player_ids = []
    for candidate in response.json()["candidates"]:
        if candidate["match"] and candidate["match"]["player_id"] not in player_ids:
            player_ids.append(candidate["match"]["player_id"])
    player_ids = player_ids[:15]
    assert len(player_ids) == 15
    return [
        {
            "player_id": player_id,
            "role": "starter" if index < 11 else "bench",
            "is_captain": index == 12,
            "is_vice_captain": index == 13,
        }
        for index, player_id in enumerate(player_ids)
    ]


def test_sage_requires_llm_config(monkeypatch) -> None:
    for name in [
        "SAGE_LLM_PROVIDER",
        "SAGE_LLM_MODEL",
        "SAGE_OPENAI_API_KEY",
        "OPENAI_API_KEY",
        "SAGE_OPENROUTER_API_KEY",
        "OPENROUTER_API_KEY",
        "SAGE_ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY",
    ]:
        monkeypatch.delenv(name, raising=False)

    client = TestClient(app)
    response = client.post(
        "/sage/advice",
        json={"provider": "tv2", "question": "Hvilke bytter bør jeg gjøre?", "selections": _sample_selections(client)},
    )

    assert response.status_code == 503
    assert "SAGE_LLM_PROVIDER" in response.json()["detail"]


def test_sage_advice_uses_llm_and_returns_context(monkeypatch) -> None:
    captured_context = {}

    def fake_generate(context):
        captured_context.update(context)
        return (
            {
                "summary": "Prioriter spillere uten kamp og vurder kaptein blant høyest xP.",
                "priority_actions": [
                    {
                        "kind": "captain",
                        "title": "Sjekk kaptein",
                        "reason": "Captain candidates are supplied by the app context.",
                        "confidence": "medium",
                        "out_player_id": None,
                        "in_player_id": None,
                        "expected_points_delta": None,
                        "risks": [],
                    }
                ],
                "transfer_advice": [],
                "captain_advice": {"captain_player_id": None, "vice_captain_player_id": None, "reason": "Use supplied candidates."},
                "problems_found": [],
                "risks": [],
                "data_gaps": ["No live injury/suspension/news feed is connected yet."],
            },
            {"provider": "openai", "model": "test-model"},
        )

    monkeypatch.setattr(sage_advisor, "generate_sage_advice", fake_generate)

    client = TestClient(app)
    response = client.post(
        "/sage/advice",
        json={
            "provider": "tv2",
            "question": "Hvilke bytter bør jeg gjøre før neste runde?",
            "selections": _sample_selections(client),
            "free_transfers": 2,
            "risk_profile": "balanced",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["llm_provider"] == "openai"
    assert payload["model"] == "test-model"
    assert payload["advice"]["summary"].startswith("Prioriter")
    assert captured_context["rules"]["free_transfers"] == 2
    assert captured_context["squad"]
    assert captured_context["captain_candidates"]
    assert "transfer_candidates" in captured_context
