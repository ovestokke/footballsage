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
