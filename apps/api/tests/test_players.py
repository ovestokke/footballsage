from fastapi.testclient import TestClient

from footballsage_api.main import app


def test_health() -> None:
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_teams_from_worldcup_snapshot() -> None:
    client = TestClient(app)
    response = client.get("/teams")
    assert response.status_code == 200
    teams = response.json()
    assert len(teams) == 48
    assert {team["fifa_code"] for team in teams} >= {"ARG", "BRA", "FRA"}


def test_fixtures_from_worldcup_snapshot() -> None:
    client = TestClient(app)
    response = client.get("/fixtures?team=ARG&limit=3")
    assert response.status_code == 200
    fixtures = response.json()
    assert fixtures
    assert all("ARG" in {fixture["home_team_code"], fixture["away_team_code"]} for fixture in fixtures)


def test_players_returns_official_prices_and_worldcup_context() -> None:
    client = TestClient(app)
    response = client.get("/players?round=1&position=FWD&limit=20")
    assert response.status_code == 200
    players = response.json()
    assert players
    assert players[0]["position"] == "FWD"
    assert players[0]["price"] >= 3.5
    assert "expected_points" in players[0]
    assert "mapping_status" in players[0]
    assert "next_fixture" in players[0]


def test_tv2_provider_uses_tv2_prices() -> None:
    client = TestClient(app)
    response = client.get("/players?provider=tv2&team=NOR&position=FWD")
    assert response.status_code == 200
    players = response.json()
    haaland = next(player for player in players if player["name"] == "Erling Haaland")
    assert haaland["price"] == 12.5
    assert haaland["official_position"] == "ANG"
    assert haaland["mapping_status"] == "matched"


def test_import_text_returns_manual_verification_candidates() -> None:
    client = TestClient(app)
    response = client.post(
        "/team/import-text",
        json={"provider": "tv2", "text": "Erling Haaland\nMohamed Salah\nMarcus Rashford"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["needs_manual_verification"] is True
    matched_names = {candidate["match"]["name"] for candidate in payload["candidates"] if candidate["match"]}
    assert {"Erling Haaland", "Mohamed Salah", "Marcus Rashford"} <= matched_names


def test_import_text_preserves_lineup_order_and_captain_markers() -> None:
    client = TestClient(app)
    response = client.post(
        "/team/import-text",
        json={
            "provider": "tv2",
            "text": "starter|C|Manu Koné\nstarter|VC|Leonardo Balerdi\nbench|none|Vitinha\nbench|none|Munir Mohamedi",
        },
    )
    assert response.status_code == 200
    candidates = response.json()["candidates"]
    assert [candidate["match"]["name"] for candidate in candidates[:4]] == [
        "Manu Koné",
        "Leonardo Balerdi",
        "Vitinha",
        "Munir Mohamedi",
    ]
    assert candidates[0]["is_captain"] is True
    assert candidates[1]["is_vice_captain"] is True
    assert candidates[2]["suggested_role"] == "bench"
    assert candidates[3]["suggested_role"] == "bench"


def test_team_analyze_returns_validation_and_suggestions() -> None:
    client = TestClient(app)
    import_response = client.post(
        "/team/import-text",
        json={"provider": "tv2", "text": "Erling Haaland\nMohamed Salah\nMarcus Rashford"},
    )
    player_ids = [candidate["match"]["player_id"] for candidate in import_response.json()["candidates"] if candidate["match"]]

    response = client.post("/team/analyze", json={"provider": "tv2", "player_ids": player_ids})

    assert response.status_code == 200
    payload = response.json()
    assert payload["player_count"] == 3
    assert payload["total_price"] > 0
    assert payload["expected_points"] > 0
    assert payload["captain_picks"] == []
    assert payload["bench_candidates"] == []
    assert payload["suggestions"] == []
    assert any(issue["code"] == "squad_size" for issue in payload["issues"])


def test_team_analyze_flags_players_without_knockout_fixture() -> None:
    client = TestClient(app)
    import_response = client.post(
        "/team/import-text",
        json={"provider": "tv2", "text": "Erling Haaland"},
    )
    player_ids = [candidate["match"]["player_id"] for candidate in import_response.json()["candidates"] if candidate["match"]]

    response = client.post("/team/analyze", json={"provider": "tv2", "player_ids": player_ids, "round": 4})

    assert response.status_code == 200
    payload = response.json()
    assert any(issue["code"] == "team_eliminated" for issue in payload["issues"])
    assert payload["selected_players"][0]["expected_points"] == 0


def test_team_analyze_enforces_max_three_players_per_country() -> None:
    client = TestClient(app)
    import_response = client.post(
        "/team/import-text",
        json={"provider": "tv2", "text": "Lionel Messi\nLautaro Martínez\nJulián Alvarez\nEmiliano Martínez"},
    )
    player_ids = [candidate["match"]["player_id"] for candidate in import_response.json()["candidates"] if candidate["match"]]

    response = client.post("/team/analyze", json={"provider": "tv2", "player_ids": player_ids})

    assert response.status_code == 200
    payload = response.json()
    assert any(issue["code"] == "country_limit" for issue in payload["issues"])
    assert payload["suggestions"] == []


def test_team_analyze_requires_lineup_roles_when_supplied() -> None:
    client = TestClient(app)
    import_response = client.post(
        "/team/import-text",
        json={"provider": "tv2", "text": "Erling Haaland\nMohamed Salah"},
    )
    player_ids = [candidate["match"]["player_id"] for candidate in import_response.json()["candidates"] if candidate["match"]]
    selections = [
        {"player_id": player_ids[0], "role": "bench", "is_captain": True, "is_vice_captain": False},
        {"player_id": player_ids[1], "role": "starter", "is_captain": False, "is_vice_captain": True},
    ]

    response = client.post("/team/analyze", json={"provider": "tv2", "selections": selections})

    assert response.status_code == 200
    payload = response.json()
    assert payload["lineup"][0]["role"] == "bench"
    assert payload["lineup"][0]["is_captain"] is True
    assert payload["lineup"][1]["is_vice_captain"] is True
    assert any(issue["code"] == "captain_benched" for issue in payload["issues"])
