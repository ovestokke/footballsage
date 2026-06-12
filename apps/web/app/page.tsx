"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";
const squadSize = 15;
const sampleTeam = [
  "Emiliano Martínez",
  "Gerónimo Rulli",
  "Cristian Romero",
  "Lisandro Martínez",
  "Nahuel Molina",
  "Nicolás Otamendi",
  "Nicolás Tagliafico",
  "Alexis Mac Allister",
  "Enzo Fernández",
  "Rodrigo De Paul",
  "Giovani Lo Celso",
  "Exequiel Palacios",
  "Lionel Messi",
  "Lautaro Martínez",
  "Julián Alvarez",
].join("\n");

type Scene = "team-select" | "import" | "verify" | "analysis";
type AppMode = "sage" | "matches";

type SavedTeam = {
  id: string;
  name: string;
  provider: "tv2" | "fifa_official";
  round: number;
  selections: TeamSelection[];
  created_at: string;
  updated_at: string;
};

async function apiLoadTeams(): Promise<SavedTeam[]> {
  try {
    const response = await fetch(`${apiBase}/saved-teams`);
    if (!response.ok) return [];
    return response.json();
  } catch {
    return [];
  }
}

async function apiSaveTeam(team: SavedTeam, isNew: boolean): Promise<SavedTeam> {
  const [method, url] = isNew
    ? ["POST", `${apiBase}/saved-teams`]
    : ["PUT", `${apiBase}/saved-teams/${team.id}`];
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(team),
  });
  if (!response.ok) throw new Error(`Klarte ikke lagre lag (${response.status})`);
  return response.json();
}

async function apiDeleteTeam(teamId: string): Promise<void> {
  const response = await fetch(`${apiBase}/saved-teams/${teamId}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`Failed to delete team (${response.status})`);
}

type Player = {
  player_id: string;
  worldcup_player_id: string | null;
  mapping_status: string | null;
  name: string;
  team: string;
  team_abbr: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  price: number;
  status: string;
  expected_points: number;
  reasons: string[];
  next_fixture: { opponent_code: string | null; difficulty: number | null; kickoff_utc: string } | null;
};

type ImportPlayerOption = Pick<Player, "player_id" | "name" | "team" | "team_abbr" | "position" | "price" | "worldcup_player_id">;

type ImportCandidate = {
  raw_text: string;
  status: string;
  confidence: number;
  match: ImportPlayerOption | null;
  alternatives: ImportPlayerOption[];
  suggested_role: "starter" | "bench" | null;
  is_captain: boolean;
  is_vice_captain: boolean;
};

type ImportResponse = {
  provider: string;
  raw_text: string;
  needs_manual_verification: boolean;
  candidates: ImportCandidate[];
  notes: string[];
};

type TeamIssue = {
  code: string;
  severity: "good" | "warn" | "bad" | string;
  title: string;
  detail: string;
  player_id: string | null;
};

type TeamSelection = {
  player_id: string;
  role: "starter" | "bench";
  is_captain: boolean;
  is_vice_captain: boolean;
};

type TeamLineupPlayer = {
  player: Player;
  role: "starter" | "bench";
  is_captain: boolean;
  is_vice_captain: boolean;
};

type TeamAnalysis = {
  provider: string;
  round: number;
  budget: number;
  total_price: number;
  remaining_budget: number;
  expected_points: number;
  player_count: number;
  position_counts: Record<string, number>;
  selected_players: Player[];
  lineup: TeamLineupPlayer[];
  issues: TeamIssue[];
  captain_picks: Player[];
  bench_candidates: Player[];
  suggestions: [];
};

type SageAction = {
  kind?: string;
  title?: string;
  reason?: string;
  confidence?: string;
  out_player_id?: string | null;
  in_player_id?: string | null;
  expected_points_delta?: number | null;
  risks?: string[];
};

type SageContextPlayer = Pick<Player, "player_id" | "name">;

type SageAdviceResponse = {
  provider: string;
  round: number;
  llm_provider: string;
  model: string;
  context?: {
    squad?: SageContextPlayer[];
    transfer_candidates?: Record<string, SageContextPlayer[]>;
  };
  advice: {
    summary: string;
    priority_actions: SageAction[];
    transfer_advice: SageAction[];
    captain_advice: { captain_player_id?: string | null; vice_captain_player_id?: string | null; reason?: string } | null;
    problems_found: Array<{ player_id?: string | null; problem?: string; severity?: string; evidence?: string }>;
    risks: string[];
    data_gaps: string[];
  };
};

type Fixture = {
  id: string;
  match_number: number;
  stage: string;
  group: string | null;
  matchday: number | null;
  kickoff_utc: string;
  status: string;
  minute: number | null;
  home_score: number | null;
  away_score: number | null;
  home_score_ht: number | null;
  away_score_ht: number | null;
  home_pens: number | null;
  away_pens: number | null;
  home_team: string | null;
  away_team: string | null;
  home_team_code: string | null;
  away_team_code: string | null;
  venue: string | null;
};

export default function Home() {
  const [appMode, setAppMode] = useState<AppMode>("sage");
  const [scene, setScene] = useState<Scene>("team-select");
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [teamText, setTeamText] = useState(sampleTeam);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const [draftSelections, setDraftSelections] = useState<Record<number, string>>({});
  const [draftLineup, setDraftLineup] = useState<Record<string, Omit<TeamSelection, "player_id">>>({});
  const [confirmedSelections, setConfirmedSelections] = useState<TeamSelection[]>([]);
  const [analysis, setAnalysis] = useState<TeamAnalysis | null>(null);
  const [sageQuestion, setSageQuestion] = useState("Hvilke bytter bør jeg gjøre før neste runde?");
  const [sageFeedback, setSageFeedback] = useState("");
  const [sageAdvice, setSageAdvice] = useState<SageAdviceResponse | null>(null);
  const [selectedAdviceKeys, setSelectedAdviceKeys] = useState<Record<string, boolean>>({});
  const [sageLoading, setSageLoading] = useState(false);
  const [sageError, setSageError] = useState<string | null>(null);
  const [round, setRound] = useState(1);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [teams, setTeams] = useState<SavedTeam[]>([]);
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [renamingTeamId, setRenamingTeamId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [playerCatalog, setPlayerCatalog] = useState<Player[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [manualPlayerQuery, setManualPlayerQuery] = useState("");

  const activeTeam = useMemo(() => teams.find((t) => t.id === activeTeamId) ?? null, [teams, activeTeamId]);

  useEffect(() => {
    apiLoadTeams().then(setTeams);
  }, []);

  const visibleCandidates = useMemo(() => (importResult?.candidates ?? []).filter((candidate) => !isNoise(candidate)), [importResult]);
  const ignoredCandidates = useMemo(() => (importResult?.candidates ?? []).filter(isNoise), [importResult]);

  const parsedProvider = useMemo(() => {
    if (!importResult) return "tv2" as const;
    return importResult.provider as "tv2" | "fifa_official";
  }, [importResult]);

  useEffect(() => {
    if (scene !== "verify" || !importResult) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ provider: parsedProvider, round: String(round), limit: "5000" });
    setCatalogLoading(true);
    fetch(`${apiBase}/players?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Klarte ikke hente spillerkatalog (${response.status})`);
        return response.json();
      })
      .then((players: Player[]) => setPlayerCatalog(players))
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Klarte ikke hente spillerkatalog");
      })
      .finally(() => setCatalogLoading(false));
    return () => controller.abort();
  }, [scene, importResult?.provider, parsedProvider, round]);

  const selectedDraftIds = useMemo(() => unique(Object.values(draftSelections)), [draftSelections]);
  const selectedDraftCount = selectedDraftIds.length;
  const starterCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.role !== "bench").length;
  const benchCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.role === "bench").length;
  const captainCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.is_captain).length;
  const viceCaptainCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.is_vice_captain).length;
  const captainId = selectedDraftIds.find((playerId) => draftLineup[playerId]?.is_captain);
  const viceCaptainId = selectedDraftIds.find((playerId) => draftLineup[playerId]?.is_vice_captain);
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (selectedDraftCount !== squadSize) errors.push(`Velg nøyaktig ${squadSize} spillere (${selectedDraftCount}/${squadSize}).`);
    if (starterCount !== 11) errors.push(`Sett nøyaktig 11 aktive spillere (${starterCount}/11).`);
    if (benchCount !== 4) errors.push(`Sett nøyaktig 4 på benk (${benchCount}/4).`);
    if (captainCount !== 1) errors.push(`Velg nøyaktig én kaptein (${captainCount}/1).`);
    if (viceCaptainCount !== 1) errors.push(`Velg nøyaktig én vicekaptein (${viceCaptainCount}/1).`);
    if (captainId && viceCaptainId && captainId === viceCaptainId) errors.push("Kaptein og vicekaptein kan ikke være samme spiller.");
    return errors;
  }, [benchCount, captainCount, captainId, selectedDraftCount, starterCount, viceCaptainCount, viceCaptainId]);
  const selectedDraftIsConfirmable = validationErrors.length === 0;
  const selectedDraftPlayers = useMemo(() => selectedDraftIds.map((playerId) => findDraftOption(importResult, playerId)).filter(Boolean) as ImportPlayerOption[], [importResult, selectedDraftIds]);
  const manualPlayerResults = useMemo(() => {
    const query = normalizeSearch(manualPlayerQuery);
    if (query.length < 2) return [];
    const selected = new Set(selectedDraftIds);
    return playerCatalog
      .filter((player) => !selected.has(player.player_id))
      .filter((player) => normalizeSearch(`${player.name} ${player.team} ${player.team_abbr} ${player.position}`).includes(query))
      .slice(0, 8);
  }, [manualPlayerQuery, playerCatalog, selectedDraftIds]);

  useEffect(() => {
    setSageAdvice(null);
    setSageError(null);
    if (!confirmedSelections.length) {
      setAnalysis(null);
      return;
    }

    const controller = new AbortController();
    setAnalyzing(true);
    setMessage(null);

    fetch(`${apiBase}/team/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "tv2", selections: confirmedSelections, round }),
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Analyse feilet (${response.status})`);
        return response.json();
      })
      .then(setAnalysis)
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMessage(error instanceof Error ? error.message : "Analyse feilet");
      })
      .finally(() => setAnalyzing(false));

    return () => controller.abort();
  }, [confirmedSelections, round]);

  useEffect(() => {
    setDraftLineup((current) => {
      const next: Record<string, Omit<TeamSelection, "player_id">> = {};
      selectedDraftIds.forEach((playerId, index) => {
        next[playerId] = current[playerId] ?? { role: index < 11 ? "starter" : "bench", is_captain: false, is_vice_captain: false };
      });
      if (selectedDraftIds.length && !selectedDraftIds.some((playerId) => next[playerId]?.is_captain)) {
        const firstStarter = selectedDraftIds.find((playerId) => next[playerId]?.role === "starter") ?? selectedDraftIds[0];
        next[firstStarter] = { ...next[firstStarter], is_captain: true, is_vice_captain: false };
      }
      if (selectedDraftIds.length && !selectedDraftIds.some((playerId) => next[playerId]?.is_vice_captain)) {
        const secondStarter = selectedDraftIds.find((playerId) => next[playerId]?.role === "starter" && !next[playerId]?.is_captain) ?? selectedDraftIds[0];
        next[secondStarter] = { ...next[secondStarter], is_vice_captain: true };
      }
      return next;
    });
  }, [selectedDraftIds]);

  async function importText() {
    if (!teamText.trim()) {
      setMessage("Lim inn minst én spiller først.");
      return;
    }
    await postImport("/team/import-text", { provider: "tv2", text: teamText });
  }

  async function importScreenshot(file: File | null) {
    if (!file) return;
    const imageBase64 = await readFileAsDataUrl(file);
    await postImport("/team/import-screenshot", { provider: "tv2", filename: file.name, image_base64: imageBase64 });
  }

  async function postImport(path: string, body: object) {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload: ImportResponse & { detail?: string } = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Import feilet");

      const nextSelections: Record<number, string> = {};
      const nextLineup: Record<string, Omit<TeamSelection, "player_id">> = {};
      payload.candidates.forEach((candidate, index) => {
        if (!isNoise(candidate) && candidate.match) {
          nextSelections[index] = candidate.match.player_id;
          if (candidate.suggested_role || candidate.is_captain || candidate.is_vice_captain) {
            nextLineup[candidate.match.player_id] = {
              role: candidate.suggested_role ?? "starter",
              is_captain: candidate.is_captain,
              is_vice_captain: candidate.is_vice_captain,
            };
          }
        }
      });
      setImportResult(payload);
      setDraftSelections(nextSelections);
      setDraftLineup(nextLineup);
      setScene("verify");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import feilet");
    } finally {
      setLoading(false);
    }
  }

  async function askSage(feedback?: string) {
    if (!confirmedSelections.length || !analysis) return;
    setSageLoading(true);
    setSageError(null);
    try {
      const response = await fetch(`${apiBase}/sage/advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "tv2",
          question: sageQuestion,
          selections: confirmedSelections,
          round,
          budget: analysis.budget,
          bank: Math.max(analysis.remaining_budget, 0),
          free_transfers: 1,
          risk_profile: "balanced",
          previous_advice: feedback && sageAdvice ? selectedAdviceForFollowup(sageAdvice, selectedAdviceKeys) : undefined,
          user_feedback: feedback || undefined,
        }),
      });
      const payload: SageAdviceResponse & { detail?: string } = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Sage-råd feilet");
      setSageAdvice(payload);
      setSelectedAdviceKeys(defaultSelectedAdviceKeys(payload));
      if (feedback) setSageFeedback("");
    } catch (error) {
      setSageError(error instanceof Error ? error.message : "Sage-råd feilet");
    } finally {
      setSageLoading(false);
    }
  }

  function updateSelection(index: number, playerId: string) {
    setDraftSelections((current) => {
      const next = { ...current, [index]: playerId };
      if (!playerId) delete next[index];
      return next;
    });
  }

  async function confirmSquad() {
    if (!selectedDraftIsConfirmable) return;
    const selections = selectedDraftIds.map((playerId) => ({
      player_id: playerId,
      role: draftLineup[playerId]?.role ?? "starter",
      is_captain: Boolean(draftLineup[playerId]?.is_captain),
      is_vice_captain: Boolean(draftLineup[playerId]?.is_vice_captain),
    }));
    setConfirmedSelections(selections);

    const existingTeam = editingTeamId ? teams.find((t) => t.id === editingTeamId) : null;
    const teamName = existingTeam?.name ?? `Lag ${teams.length + 1}`;
    const savedTeam: SavedTeam = {
      id: editingTeamId ?? "",
      name: teamName,
      provider: parsedProvider,
      round,
      selections,
      created_at: existingTeam?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const isNew = !editingTeamId;

    try {
      const result = await apiSaveTeam(savedTeam, isNew);
      setTeams(await apiLoadTeams());
      setActiveTeamId(result.id);
      setEditingTeamId(null);
      setScene("analysis");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Klarte ikke lagre laget");
    }
  }

  function navigateToScene(target: Scene) {
    setScene(target);
  }

  function startNewImport() {
    setScene("import");
    setImportResult(null);
    setDraftSelections({});
    setDraftLineup({});
    setConfirmedSelections([]);
    setAnalysis(null);
    setSageAdvice(null);
    setMessage(null);
    setEditingTeamId(null);
  }

  function openTeam(teamId: string) {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    setActiveTeamId(teamId);
    setRound(team.round);
    setConfirmedSelections(team.selections);
    setAnalysis(null);
    setSageAdvice(null);
    setMessage(null);
    setScene("analysis");
  }

  function editTeam(teamId: string) {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    setEditingTeamId(teamId);
    setActiveTeamId(teamId);
    setRound(team.round);

    // Build a synthetic import result from the saved selections so verify scene works
    (async () => {
      try {
        const params = new URLSearchParams({
          provider: team.provider,
          round: String(team.round),
        });
        const response = await fetch(`${apiBase}/players?${params}`);
        if (!response.ok) throw new Error(`Failed to fetch players (${response.status})`);
        const allPlayers: Player[] = await response.json();
        const playersById = new Map(allPlayers.map((p) => [p.player_id, p]));

        const candidates: ImportCandidate[] = team.selections.flatMap((sel) => {
          const player = playersById.get(sel.player_id);
          if (!player) return [];
          const option: ImportPlayerOption = {
            player_id: player.player_id,
            name: player.name,
            team: player.team,
            team_abbr: player.team_abbr,
            position: player.position,
            price: player.price,
            worldcup_player_id: player.worldcup_player_id,
          };
          return [{
            raw_text: player.name,
            status: "matched",
            confidence: 1.0,
            match: option,
            alternatives: [option],
            suggested_role: sel.role === "bench" ? "bench" : "starter",
            is_captain: sel.is_captain,
            is_vice_captain: sel.is_vice_captain,
          } satisfies ImportCandidate];
        });

        const syntheticResult: ImportResponse = {
          provider: team.provider,
          raw_text: "(existing team)",
          needs_manual_verification: false,
          candidates,
          notes: ["Lag hentet fra lagret tropp."],
        };

        const nextSelections: Record<number, string> = {};
        const nextLineup: Record<string, Omit<TeamSelection, "player_id">> = {};
        candidates.forEach((candidate, index) => {
          nextSelections[index] = candidate.match!.player_id;
          nextLineup[candidate.match!.player_id] = {
            role: candidate.suggested_role ?? team.selections[index]?.role ?? "starter",
            is_captain: candidate.is_captain,
            is_vice_captain: candidate.is_vice_captain,
          };
        });

        setImportResult(syntheticResult);
        setDraftSelections(nextSelections);
        setDraftLineup(nextLineup);
        setConfirmedSelections(team.selections);
        setScene("verify");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Klarte ikke hente spillere for redigering");
      }
    })();
  }

  async function renameTeam(teamId: string, name: string) {
    const team = teams.find((t) => t.id === teamId);
    if (!team) return;
    try {
      await apiSaveTeam({ ...team, name, updated_at: new Date().toISOString() }, false);
      setTeams(await apiLoadTeams());
    } catch { /* ignore */ }
    setRenamingTeamId(null);
  }

  async function removeTeam(teamId: string) {
    try {
      await apiDeleteTeam(teamId);
      setTeams(await apiLoadTeams());
    } catch { /* ignore */ }
    if (activeTeamId === teamId) {
      setActiveTeamId(null);
      setConfirmedSelections([]);
      setAnalysis(null);
    }
  }

  function setDraftRole(playerId: string, role: "starter" | "bench") {
    setDraftLineup((current) => ({ ...current, [playerId]: { ...(current[playerId] ?? { is_captain: false, is_vice_captain: false }), role } }));
  }

  function setDraftCaptain(playerId: string) {
    setDraftLineup((current) => {
      const next: Record<string, Omit<TeamSelection, "player_id">> = {};
      selectedDraftIds.forEach((id) => {
        const existing = current[id] ?? { role: "starter", is_vice_captain: false };
        next[id] = { ...existing, is_captain: id === playerId, is_vice_captain: id === playerId ? false : Boolean(existing.is_vice_captain) };
      });
      return next;
    });
  }

  function setDraftViceCaptain(playerId: string) {
    setDraftLineup((current) => {
      const next: Record<string, Omit<TeamSelection, "player_id">> = {};
      selectedDraftIds.forEach((id) => {
        const existing = current[id] ?? { role: "starter", is_captain: false };
        next[id] = { ...existing, is_vice_captain: id === playerId, is_captain: id === playerId ? false : Boolean(existing.is_captain) };
      });
      return next;
    });
  }

  function addManualPlayer(player: Player) {
    if (!importResult) return;
    if (selectedDraftIds.includes(player.player_id)) return;
    if (selectedDraftCount >= squadSize) {
      setMessage("Troppen har allerede 15 spillere. Sett en spiller til ‘Ikke bruk’ før du legger til en ny.");
      return;
    }

    const option = playerToImportOption(player);
    const nextIndex = importResult.candidates.length;
    const role = selectedDraftCount < 11 ? "starter" : "bench";
    const candidate: ImportCandidate = {
      raw_text: `Manuelt: ${player.name}`,
      status: "matched",
      confidence: 1,
      match: option,
      alternatives: [option],
      suggested_role: role,
      is_captain: false,
      is_vice_captain: false,
    };

    setImportResult({ ...importResult, candidates: [...importResult.candidates, candidate] });
    setDraftSelections((current) => ({ ...current, [nextIndex]: player.player_id }));
    setDraftLineup((current) => ({ ...current, [player.player_id]: { role, is_captain: false, is_vice_captain: false } }));
    setManualPlayerQuery("");
    setMessage(null);
  }

  return (
    <main className="app-shell">
      <header className="app-top compact">
        <div>
          <p className="eyebrow">FootballSage</p>
          <h1>{appMode === "matches" ? "VM-kamper, live og i CET." : "Få AI-råd til neste fantasy-runde."}</h1>
          <p>
            {appMode === "matches"
              ? "Én dag av gangen, live-stilling når datakilden har det, og kampkort som føles som matchday."
              : "Importer laget ditt, bekreft 15 spillere, og spør Sage om bytter, kaptein og problemer før neste runde."}
          </p>
        </div>
        <div className="top-controls">
          <ModeTabs appMode={appMode} onChange={setAppMode} />
          {appMode === "sage" && (
            <SceneSteps
              scene={scene}
              canVerify={importResult !== null}
              canAnalyze={confirmedSelections.length > 0}
              onNavigate={navigateToScene}
              hasTeams={teams.length > 0}
            />
          )}
        </div>
      </header>

      {message && appMode === "sage" && <p className="global-message">{message}</p>}

      {appMode === "matches" && <WorldCupMatches />}

      {appMode === "sage" && scene === "team-select" && (
        <section className="scene-card team-select-scene">
          <div className="scene-copy">
            <p className="eyebrow">Dine lag</p>
            <h2>Velg lag eller opprett nytt</h2>
            <p>Hvert lag lagres på serveren. Du kan ha flere lag samtidig – for eksempel ett til VM-liga og ett til venneliga.</p>
          </div>

          {teams.length > 0 ? (
            <div className="team-list">
              {teams.map((team) => (
                <div className="team-card" key={team.id}>
                  <div className="team-card-info" onClick={() => openTeam(team.id)} style={{ cursor: "pointer" }}>
                    <strong>{team.name}</strong>
                    <span>{team.selections.length} spillere · Runde {team.round}</span>
                    <small>{new Date(team.updated_at).toLocaleDateString("nb-NO", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
                  </div>
                  <div className="team-card-actions">
                    <button className="secondary-button team-action-btn" onClick={() => openTeam(team.id)}>Åpne</button>
                    <button className="secondary-button team-action-btn" onClick={() => editTeam(team.id)}>Rediger</button>
                    {renamingTeamId === team.id ? (
                      <form className="rename-form" onSubmit={(e) => { e.preventDefault(); renameTeam(team.id, renameValue); }}>
                        <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                        <button type="submit" className="secondary-button team-action-btn">Lagre</button>
                        <button type="button" className="secondary-button team-action-btn" onClick={() => setRenamingTeamId(null)}>Avbryt</button>
                      </form>
                    ) : (
                      <button className="secondary-button team-action-btn" onClick={() => { setRenamingTeamId(team.id); setRenameValue(team.name); }}>Gi nytt navn</button>
                    )}
                    <button className="secondary-button team-action-btn team-delete-btn" onClick={() => { if (confirm(`Slette \u00AB${team.name}\u00BB?`)) removeTeam(team.id); }}>Slett</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">Ingen lag lagret ennå. Opprett ditt første lag ved å importere spillere.</p>
          )}

          <div className="scene-actions">
            <button onClick={startNewImport}>+ Opprett nytt lag</button>
          </div>
        </section>
      )}

      {appMode === "sage" && scene === "import" && (
        <section className="scene-card import-scene">
          <div className="scene-copy">
            <p className="eyebrow">Steg 1</p>
            <h2>Importer laget ditt</h2>
            <p>Bruk screenshot fra TV2 eller lim inn spillerlisten. Importen lager bare et forslag — eksisterende bekreftet lag endres ikke før du trykker “Bekreft lag”.</p>
            {confirmedSelections.length > 0 && (
              <p className="global-message" style={{ marginTop: 12 }}>Du har allerede et bekreftet lag med {confirmedSelections.length} spillere. Ny import overskriver kun forslaget — det bekreftede laget beholdes til du bekrefter på nytt.</p>
            )}
            {(importResult || confirmedSelections.length > 0) && (
              <p style={{ marginTop: 8 }}>
                <button className="secondary-button" onClick={startNewImport}>Nullstill alt</button>
              </p>
            )}
          </div>

          <div className="import-grid">
            <article className="panel upload-panel">
              <PanelHeader title="Screenshot" subtitle="Anbefalt. OCR filtrerer bort overskrifter og støy før du bekrefter laget." />
              <label className="upload-zone">
                <input accept="image/*" type="file" onChange={(event) => { void importScreenshot(event.target.files?.[0] ?? null); event.target.value = ""; }} />
                <strong>{loading ? "Leser screenshot…" : "Velg screenshot"}</strong>
                <span>PNG/JPG/WebP. Crop rundt spillerlisten gir best treff.</span>
              </label>
            </article>

            <article className="panel paste-panel">
              <PanelHeader title="Tekst" subtitle="Lim inn én spiller per linje hvis du heller vil gjøre det manuelt." />
              <textarea value={teamText} onChange={(event) => setTeamText(event.target.value)} spellCheck={false} />
              <button disabled={loading} onClick={importText}>{loading ? "Matcher…" : "Match tekst"}</button>
            </article>
          </div>
        </section>
      )}

      {appMode === "sage" && scene === "verify" && importResult && (
        <section className="scene-card verify-scene">
          <div className="verify-header">
            <div>
              <p className="eyebrow">Steg 2</p>
              <h2>Bekreft laget</h2>
              <p>Dette skal være de 15 spillerne i troppen din. Linjer som ser ut som OCR-støy er flyttet ut av hovedlisten.</p>
            </div>
            <div className={selectedDraftIsConfirmable ? "count-box ok" : "count-box warn"}>
              <strong>{selectedDraftCount}/{squadSize}</strong>
              <span>{selectedDraftIsConfirmable ? "klart til AI" : selectedDraftCount !== squadSize ? "sjekk spillerantall" : "sett start/benk/kaptein"}</span>
            </div>
          </div>

          <section className="manual-player-panel">
            <div>
              <h3>Legg til spiller manuelt</h3>
              <p>Søk i spillerkatalogen hvis OCR/import mangler noen.</p>
            </div>
            <div className="manual-player-search">
              <input
                placeholder="Søk navn, land eller posisjon"
                value={manualPlayerQuery}
                onChange={(event) => setManualPlayerQuery(event.target.value)}
              />
              <span>{catalogLoading ? "Laster katalog…" : selectedDraftCount >= squadSize ? "Troppen er full" : `${playerCatalog.length} spillere`}</span>
            </div>
            {manualPlayerResults.length > 0 && (
              <div className="manual-player-results">
                {manualPlayerResults.map((player) => (
                  <button
                    className="manual-player-result"
                    disabled={selectedDraftCount >= squadSize}
                    key={player.player_id}
                    onClick={() => addManualPlayer(player)}
                    type="button"
                  >
                    <strong>{player.name}</strong>
                    <span>{player.team_abbr} · {player.position} · {player.price.toFixed(1)}m</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <div className="verify-list clean-list">
            {visibleCandidates.map((candidate) => {
              const index = importResult.candidates.indexOf(candidate);
              return (
                <div className={`verify-row ${candidate.status}`} key={`${candidate.raw_text}-${index}`}>
                  <div>
                    <span className="status-pill">{candidate.status}</span>
                    <strong>{candidate.raw_text}</strong>
                    <small>{Math.round(candidate.confidence * 100)}% treff</small>
                  </div>
                  <select value={draftSelections[index] ?? ""} onChange={(event) => updateSelection(index, event.target.value)}>
                    <option value="">Ikke bruk</option>
                    {candidate.alternatives.map((option) => (
                      <option value={option.player_id} key={option.player_id}>
                        {option.name} · {option.team_abbr} · {option.position} · {option.price.toFixed(1)}m
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          <section className="lineup-setup">
            <header>
              <div>
                <h3>Startellever, benk og kaptein</h3>
                <p>AI-råd blir basert på dette. Hvis OCR ikke fant rollene, sett dem manuelt her.</p>
              </div>
              <div className="lineup-counts">
                <span className={starterCount === 11 ? "ok" : "warn"}>Start {starterCount}/11</span>
                <span className={benchCount === 4 ? "ok" : "warn"}>Benk {benchCount}/4</span>
                <span className={captainCount === 1 ? "ok" : "warn"}>Kaptein {captainCount}/1</span>
                <span className={viceCaptainCount === 1 && captainId !== viceCaptainId ? "ok" : "warn"}>Vice {viceCaptainCount}/1</span>
              </div>
            </header>
            <div className="lineup-list">
              {selectedDraftPlayers.map((player) => (
                <div className="lineup-row" key={player.player_id}>
                  <strong>{player.name}</strong>
                  <span>{player.team_abbr} · {player.position} · {player.price.toFixed(1)}m</span>
                  <select value={draftLineup[player.player_id]?.role ?? "starter"} onChange={(event) => setDraftRole(player.player_id, event.target.value as "starter" | "bench")}>
                    <option value="starter">Spiller fra start</option>
                    <option value="bench">Benk</option>
                  </select>
                  <div className="captain-picks">
                    <label className="captain-radio">
                      <input checked={Boolean(draftLineup[player.player_id]?.is_captain)} name="captain" type="radio" onChange={() => setDraftCaptain(player.player_id)} />
                      C
                    </label>
                    <label className="captain-radio">
                      <input checked={Boolean(draftLineup[player.player_id]?.is_vice_captain)} name="viceCaptain" type="radio" onChange={() => setDraftViceCaptain(player.player_id)} />
                      VC
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {ignoredCandidates.length > 0 && (
            <details className="ignored-lines">
              <summary>{ignoredCandidates.length} OCR-linjer ignorert</summary>
              <ul>
                {ignoredCandidates.map((candidate, index) => <li key={`${candidate.raw_text}-${index}`}>{candidate.raw_text}</li>)}
              </ul>
            </details>
          )}

          {validationErrors.length > 0 && (
            <section className="validation-panel" aria-live="polite">
              <h3>Laget kan ikke lagres ennå</h3>
              <ul>
                {validationErrors.map((error) => <li key={error}>{error}</li>)}
              </ul>
            </section>
          )}

          <div className="scene-actions">
            <button className="secondary-button" onClick={() => navigateToScene("import")}>Tilbake til import</button>
            {teams.length > 0 && <button className="secondary-button" onClick={() => navigateToScene("team-select")}>Dine lag</button>}
            <button disabled={!selectedDraftIsConfirmable} onClick={confirmSquad}>Bekreft og lagre lag</button>
          </div>
        </section>
      )}

      {appMode === "sage" && scene === "analysis" && (
        <section className="analysis-scene">
          <div className="analysis-toolbar">
            <div>
              <p className="eyebrow">Steg 3</p>
              <h2>Sage-rådgiver</h2>
            </div>
            <label className="round-select">
              Runde
              <select value={round} onChange={(event) => setRound(Number(event.target.value))}>
                <option value={1}>Gruppe 1</option>
                <option value={2}>Gruppe 2</option>
                <option value={3}>Gruppe 3</option>
                <option value={4}>32-delsfinale</option>
                <option value={5}>8-delsfinale</option>
                <option value={6}>Kvartfinale</option>
                <option value={7}>Semifinale</option>
                <option value={8}>Finale</option>
              </select>
            </label>
            <button className="secondary-button" onClick={() => editTeam(activeTeamId ?? "")}>Endre lag</button>
            <button className="secondary-button" onClick={() => navigateToScene("team-select")}>Dine lag</button>
            <button className="secondary-button" onClick={startNewImport}>Nytt lag</button>
          </div>

          <section className="summary-grid" aria-label="Lagstatus">
            <Metric label="Spillere" value={`${analysis?.player_count ?? confirmedSelections.length}/15`} tone={analysis?.player_count === squadSize ? "good" : "warn"} />
            <Metric label="Budsjett" value={analysis ? `${analysis.total_price.toFixed(1)}m` : "—"} tone={(analysis?.remaining_budget ?? 0) < 0 ? "bad" : "good"} />
            <Metric label="Budsjett igjen" value={analysis ? `${analysis.remaining_budget.toFixed(1)}m` : "—"} tone={(analysis?.remaining_budget ?? 0) < 0 ? "bad" : "good"} />
            <Metric label="Varsler" value={String(analysis?.issues.length ?? 0)} tone={analysis?.issues.length ? "bad" : "good"} />
          </section>

          <details className="panel lineup-panel" open>
            <summary>
              <div>
                <h3>Bekreftet lag</h3>
                <p>{analyzing ? "Oppdaterer…" : "Startellever, benk og kaptein slik AI vil se laget. Kan lukkes når du bare vil lese rådene."}</p>
              </div>
              <span>Vis/skjul</span>
            </summary>
            <SquadByPosition lineup={analysis?.lineup ?? []} eliminatedIds={eliminatedIds(analysis)} />
          </details>

          <section className="ai-workspace">
            <article className="panel ai-panel">
              <PanelHeader title="AI-rådgiver" subtitle="Spør Sage om neste runde. LLM-en får laget, fixtures, xP og kandidatbytter fra appen." />
              <DecisionStack
                analysis={analysis}
                question={sageQuestion}
                setQuestion={setSageQuestion}
                askSage={askSage}
                sageFeedback={sageFeedback}
                setSageFeedback={setSageFeedback}
                sageAdvice={sageAdvice}
                selectedAdviceKeys={selectedAdviceKeys}
                setSelectedAdviceKeys={setSelectedAdviceKeys}
                sageLoading={sageLoading}
                sageError={sageError}
              />
            </article>
          </section>
        </section>
      )}
    </main>
  );
}

function ModeTabs({ appMode, onChange }: { appMode: AppMode; onChange: (mode: AppMode) => void }) {
  return (
    <nav className="mode-tabs" aria-label="Hovedseksjoner">
      <button className={appMode === "sage" ? "active" : ""} onClick={() => onChange("sage")} type="button">
        Sage
      </button>
      <button className={appMode === "matches" ? "active" : ""} onClick={() => onChange("matches")} type="button">
        VM-kamper
      </button>
    </nav>
  );
}

function WorldCupMatches() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selectedDay, setSelectedDay] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function loadFixtures(signal?: AbortSignal) {
    setError(null);
    const response = await fetch(`${apiBase}/fixtures?limit=500`, { signal });
    if (!response.ok) throw new Error(`Klarte ikke hente kamper (${response.status})`);
    const payload: Fixture[] = await response.json();
    setFixtures(payload);
    setLastUpdated(new Date());
    setLoading(false);
  }

  useEffect(() => {
    const controller = new AbortController();
    loadFixtures(controller.signal).catch((err: Error) => {
      if (err.name !== "AbortError") {
        setError(err.message);
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, []);

  const dayKeys = useMemo(() => unique(fixtures.map((fixture) => cetDateKey(fixture.kickoff_utc))), [fixtures]);
  const todayKey = cetDateKey(new Date().toISOString());
  const selectedFixtures = useMemo(
    () => fixtures.filter((fixture) => cetDateKey(fixture.kickoff_utc) === selectedDay),
    [fixtures, selectedDay],
  );
  const liveFixtures = selectedFixtures.filter(isLiveFixture);
  const hasLiveFixtures = fixtures.some(isLiveFixture);

  useEffect(() => {
    if (!dayKeys.length || selectedDay) return;
    setSelectedDay(dayKeys.find((day) => day === todayKey) ?? dayKeys.find((day) => day >= todayKey) ?? dayKeys[0]);
  }, [dayKeys, selectedDay, todayKey]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      loadFixtures().catch((err: Error) => setError(err.message));
    }, hasLiveFixtures ? 30_000 : 300_000);
    return () => window.clearInterval(interval);
  }, [hasLiveFixtures]);

  return (
    <section className="matches-scene">
      <div className="scene-card matchday-hero">
        <div>
          <p className="eyebrow">Matchday board</p>
          <h2>{selectedDay ? matchdayTitle(selectedDay) : "VM-kamper"}</h2>
          <p>Alle klokkeslett vises som CET. Live-stilling oppdateres automatisk når API-et leverer score.</p>
        </div>
        <div className="matchday-status">
          <span className={hasLiveFixtures ? "live-indicator on" : "live-indicator"}>{hasLiveFixtures ? "Live nå" : "Ingen live"}</span>
          <small>{lastUpdated ? `Oppdatert ${lastUpdated.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" })}` : "Henter feed"}</small>
          <button className="secondary-button" onClick={() => loadFixtures().catch((err: Error) => setError(err.message))} type="button">
            Oppdater
          </button>
        </div>
      </div>

      {error && <p className="global-message">{error}</p>}

      <div className="date-rail" aria-label="Velg kampdag">
        {dayKeys.map((day) => (
          <button className={day === selectedDay ? "active" : ""} key={day} onClick={() => setSelectedDay(day)} type="button">
            <span>{shortDayLabel(day, todayKey)}</span>
            <small>{fixtures.filter((fixture) => cetDateKey(fixture.kickoff_utc) === day).length} kamper</small>
          </button>
        ))}
      </div>

      {loading ? (
        <section className="panel match-list-panel"><p className="empty">Laster VM-kamper…</p></section>
      ) : selectedFixtures.length === 0 ? (
        <section className="panel match-list-panel"><p className="empty">Ingen kamper denne dagen.</p></section>
      ) : (
        <section className="match-list-panel">
          {liveFixtures.length > 0 && (
            <div className="live-strip">
              <p className="eyebrow">Nå live</p>
              <div className="match-list live-list">
                {liveFixtures.map((fixture) => <MatchCard fixture={fixture} key={`live-${fixture.id}`} />)}
              </div>
            </div>
          )}

          <div className="match-section-title">
            <div>
              <p className="eyebrow">Dagens kamper</p>
              <h3>{selectedFixtures.length} kamper</h3>
            </div>
            <span>{selectedDay ? matchdayTitle(selectedDay) : ""}</span>
          </div>
          <div className="match-list">
            {selectedFixtures.map((fixture) => <MatchCard fixture={fixture} key={fixture.id} />)}
          </div>
        </section>
      )}
    </section>
  );
}

function MatchCard({ fixture }: { fixture: Fixture }) {
  const live = isLiveFixture(fixture);
  const finished = isFinishedFixture(fixture);
  const hasScore = fixture.home_score !== null && fixture.away_score !== null;
  return (
    <article className={`match-card ${live ? "live" : ""} ${finished ? "finished" : ""}`}>
      <div className="match-time">
        <strong>{live ? statusLabel(fixture) : cetTime(fixture.kickoff_utc)}</strong>
        <span>{live ? `${fixture.minute ?? "—"}'` : "CET"}</span>
      </div>
      <div className="match-teams">
        <TeamLine name={fixture.home_team ?? "TBD"} code={fixture.home_team_code} />
        <div className="scoreline">
          {hasScore ? (
            <strong>{fixture.home_score}–{fixture.away_score}</strong>
          ) : (
            <span>vs</span>
          )}
          {fixture.home_pens !== null && fixture.away_pens !== null && <small>p. {fixture.home_pens}–{fixture.away_pens}</small>}
        </div>
        <TeamLine name={fixture.away_team ?? "TBD"} code={fixture.away_team_code} align="right" />
      </div>
      <div className="match-meta">
        <span>{stageLabel(fixture.stage, fixture.group)}</span>
        {fixture.venue && <span>{fixture.venue}</span>}
        <span>{statusLabel(fixture)}</span>
      </div>
    </article>
  );
}

function TeamLine({ name, code, align = "left" }: { name: string; code: string | null; align?: "left" | "right" }) {
  return (
    <div className={`team-line ${align === "right" ? "right" : ""}`}>
      <strong>{name}</strong>
      {code && <span>{code}</span>}
    </div>
  );
}

function SceneSteps({
  scene,
  canVerify,
  canAnalyze,
  onNavigate,
  hasTeams,
}: {
  scene: Scene;
  canVerify: boolean;
  canAnalyze: boolean;
  onNavigate: (target: Scene) => void;
  hasTeams: boolean;
}) {
  const steps: Array<[Scene, string, boolean]> = [
    ["team-select", "Lag", hasTeams],
    ["import", "Importer", true],
    ["verify", "Bekreft", canVerify],
    ["analysis", "Sjekk", canAnalyze],
  ];
  return (
    <ol className="scene-steps" aria-label="Flyt">
      {steps.map(([key, label, unlocked]) => {
        const isActive = scene === key;
        return (
          <li key={key}>
            <button
              aria-current={isActive ? "step" : undefined}
              className={isActive ? "active" : ""}
              disabled={!unlocked && !isActive}
              onClick={() => onNavigate(key)}
              type="button"
            >
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  return <div className={tone ? `metric ${tone}` : "metric"}><span>{label}</span><strong>{value}</strong></div>;
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return <header className="panel-header"><h3>{title}</h3><p>{subtitle}</p></header>;
}

function SquadByPosition({ lineup, eliminatedIds }: { lineup: TeamLineupPlayer[]; eliminatedIds: Set<string> }) {
  const positions: Array<[Player["position"], string]> = [["GK", "Keepere"], ["DEF", "Forsvar"], ["MID", "Midtbane"], ["FWD", "Angrep"]];
  if (!lineup.length) return <p className="empty">Ingen analyse ennå.</p>;
  return (
    <div className="position-groups">
      {positions.map(([position, label]) => {
        const group = lineup.filter((line) => line.player.position === position);
        return (
          <section className="position-group" key={position}>
            <h4>{label} <span>{group.length}</span></h4>
            {group.map((line) => {
              const player = line.player;
              const eliminated = eliminatedIds.has(player.player_id);
              return (
                <div className={`squad-row ${rowTone(player, eliminated)} ${line.role}`} key={player.player_id}>
                  <strong>{player.name}</strong>
                  <span>{line.role === "starter" ? "Starter" : "Benk"}{line.is_captain ? " · C" : line.is_vice_captain ? " · VC" : ""}</span>
                  <span>{player.team_abbr}</span>
                  <span>{player.next_fixture?.opponent_code ? `mot ${player.next_fixture.opponent_code}` : "ingen kamp"}</span>
                  <em>{playerLabel(player, eliminated)}</em>
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

function DecisionStack({
  analysis,
  question,
  setQuestion,
  askSage,
  sageFeedback,
  setSageFeedback,
  sageAdvice,
  selectedAdviceKeys,
  setSelectedAdviceKeys,
  sageLoading,
  sageError,
}: {
  analysis: TeamAnalysis | null;
  question: string;
  setQuestion: (value: string) => void;
  askSage: (feedback?: string) => void;
  sageFeedback: string;
  setSageFeedback: (value: string) => void;
  sageAdvice: SageAdviceResponse | null;
  selectedAdviceKeys: Record<string, boolean>;
  setSelectedAdviceKeys: (value: Record<string, boolean>) => void;
  sageLoading: boolean;
  sageError: string | null;
}) {
  if (!analysis) return <p className="empty">Bekreft laget først.</p>;
  return (
    <div className="decision-stack">
      <article className="sage-question">
        <textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} />
        <div className="sage-actions">
          <button disabled={sageLoading || question.trim().length < 3} onClick={() => askSage()}>{sageLoading ? "Spør Sage…" : "Få Sage-råd"}</button>
          <span>Bruker obligatorisk LLM-konfig på API-serveren.</span>
        </div>
        {sageError && <p className="sage-error">{sageError}</p>}
      </article>

      {sageAdvice && (
        <SageAnswer
          response={sageAdvice}
          analysis={analysis}
          feedback={sageFeedback}
          setFeedback={setSageFeedback}
          askSage={askSage}
          selectedAdviceKeys={selectedAdviceKeys}
          setSelectedAdviceKeys={setSelectedAdviceKeys}
          sageLoading={sageLoading}
        />
      )}

      {analysis.issues.map((issue) => <IssueCard issue={issue} key={`${issue.code}-${issue.player_id ?? issue.title}`} />)}
    </div>
  );
}

function SageAnswer({
  response,
  analysis,
  feedback,
  setFeedback,
  askSage,
  selectedAdviceKeys,
  setSelectedAdviceKeys,
  sageLoading,
}: {
  response: SageAdviceResponse;
  analysis: TeamAnalysis;
  feedback: string;
  setFeedback: (value: string) => void;
  askSage: (feedback?: string) => void;
  selectedAdviceKeys: Record<string, boolean>;
  setSelectedAdviceKeys: (value: Record<string, boolean>) => void;
  sageLoading: boolean;
}) {
  const actions = response.advice.priority_actions ?? [];
  return (
    <article className="sage-answer">
      <header>
        <div>
          <h4>Sage sier</h4>
          <p>{response.advice.summary}</p>
        </div>
        <span>{response.llm_provider} · {response.model}</span>
      </header>

      <section className="sage-followup inline-followup">
        <h4>Svar på rådet</h4>
        <p>Rett Sage hvis et forslag ikke gir mening, f.eks. “Munir er benkekeeper, ikke bruk bytte der”.</p>
        <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} />
        <div className="sage-actions">
          <button disabled={sageLoading || feedback.trim().length < 3} onClick={() => askSage(feedback.trim())}>{sageLoading ? "Oppdaterer…" : "Send til Sage"}</button>
          <span>{selectedAdviceCount(selectedAdviceKeys)} råd tas med i oppfølgingen.</span>
        </div>
      </section>

      {actions.length > 0 && (
        <section className="sage-section">
          <h5>Prioriterte handlinger</h5>
          <div className="sage-action-list">
            {actions.map((action, index) => (
              <SageActionCard
                action={action}
                analysis={analysis}
                response={response}
                selected={selectedAdviceKeys[adviceKey("priority", index)] ?? false}
                setSelected={(selected) => setSelectedAdviceKeys({ ...selectedAdviceKeys, [adviceKey("priority", index)]: selected })}
                key={`${action.kind ?? "action"}-${index}`}
              />
            ))}
          </div>
        </section>
      )}

      {response.advice.transfer_advice.length > 0 && (
        <section className="sage-section">
          <h5>Bytteforslag</h5>
          <div className="sage-action-list">
            {response.advice.transfer_advice.map((action, index) => (
              <SageActionCard
                action={{ ...action, kind: "transfer", title: "Bytte" }}
                analysis={analysis}
                response={response}
                selected={selectedAdviceKeys[adviceKey("transfer", index)] ?? false}
                setSelected={(selected) => setSelectedAdviceKeys({ ...selectedAdviceKeys, [adviceKey("transfer", index)]: selected })}
                key={`transfer-${index}`}
              />
            ))}
          </div>
        </section>
      )}

      {response.advice.captain_advice && (
        <section className="sage-section compact-section">
          <h5>Kaptein</h5>
          <p>{response.advice.captain_advice.reason}</p>
        </section>
      )}

      {response.advice.data_gaps.length > 0 && (
        <section className="sage-section compact-section muted-section">
          <h5>Datagap</h5>
          <ul>{response.advice.data_gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
        </section>
      )}
    </article>
  );
}

function SageActionCard({
  action,
  analysis,
  response,
  selected,
  setSelected,
}: {
  action: SageAction;
  analysis: TeamAnalysis;
  response: SageAdviceResponse;
  selected: boolean;
  setSelected: (selected: boolean) => void;
}) {
  const outName = action.out_player_id ? playerNameById(analysis, response, action.out_player_id) : null;
  const inName = action.in_player_id ? playerNameById(analysis, response, action.in_player_id) : null;
  return (
    <article className="sage-action-card">
      <div className="sage-action-head">
        <label className="advice-include">
          <input checked={selected} type="checkbox" onChange={(event) => setSelected(event.target.checked)} />
          Ta med i oppfølging
        </label>
        <span>{action.kind ?? "råd"}{action.confidence ? ` · ${action.confidence}` : ""}</span>
        <h6>{action.title ?? "Anbefaling"}</h6>
      </div>
      {(outName || inName) && <p className="transfer-line">{outName ?? "—"} → {inName ?? action.in_player_id ?? "—"}</p>}
      <p>{action.reason}</p>
      {typeof action.expected_points_delta === "number" && <em>{action.expected_points_delta > 0 ? "+" : ""}{action.expected_points_delta.toFixed(2)} xP</em>}
      {action.risks && action.risks.length > 0 && <ul>{action.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>}
    </article>
  );
}

function IssueCard({ issue }: { issue: TeamIssue }) {
  return <article className={`issue-card ${issue.severity}`}><h4>{issue.title}</h4><p>{issue.detail}</p></article>;
}

function isNoise(candidate: ImportCandidate) {
  const text = candidate.raw_text.toLocaleLowerCase();
  return (
    candidate.status === "unmatched" &&
    !candidate.match &&
    (candidate.confidence < 0.62 || /troppen|spiller|lineup|pos\b|@|%|\d+\s*spillere/.test(text))
  );
}

function rowTone(player: Player, eliminated = false) {
  if (eliminated || player.status !== "playing" || player.mapping_status === "unmatched") return "bad";
  if (player.mapping_status === "review") return "warn";
  return "good";
}

function playerLabel(player: Player, eliminated = false) {
  if (eliminated) return "ute";
  if (player.status !== "playing") return player.status;
  if (player.mapping_status === "review") return "sjekk";
  if (player.mapping_status === "unmatched") return "mangler";
  return "ok";
}

function eliminatedIds(analysis: TeamAnalysis | null) {
  return new Set((analysis?.issues ?? []).filter((issue) => issue.code === "team_eliminated" && issue.player_id).map((issue) => issue.player_id as string));
}

function adviceKey(kind: "priority" | "transfer", index: number) {
  return `${kind}:${index}`;
}

function defaultSelectedAdviceKeys(response: SageAdviceResponse) {
  const selected: Record<string, boolean> = {};
  response.advice.priority_actions.forEach((_, index) => { selected[adviceKey("priority", index)] = true; });
  response.advice.transfer_advice.forEach((_, index) => { selected[adviceKey("transfer", index)] = true; });
  return selected;
}

function selectedAdviceCount(selectedAdviceKeys: Record<string, boolean>) {
  return Object.values(selectedAdviceKeys).filter(Boolean).length;
}

function selectedAdviceForFollowup(response: SageAdviceResponse, selectedAdviceKeys: Record<string, boolean>) {
  return {
    ...response.advice,
    priority_actions: response.advice.priority_actions.filter((_, index) => selectedAdviceKeys[adviceKey("priority", index)]),
    transfer_advice: response.advice.transfer_advice.filter((_, index) => selectedAdviceKeys[adviceKey("transfer", index)]),
  };
}

function playerNameById(analysis: TeamAnalysis, response: SageAdviceResponse, playerId: string) {
  const selectedName = analysis.selected_players.find((player) => player.player_id === playerId)?.name;
  if (selectedName) return selectedName;

  const squadName = response.context?.squad?.find((player) => player.player_id === playerId)?.name;
  if (squadName) return squadName;

  for (const candidates of Object.values(response.context?.transfer_candidates ?? {})) {
    const candidateName = candidates.find((player) => player.player_id === playerId)?.name;
    if (candidateName) return candidateName;
  }

  return playerId;
}

function findDraftOption(importResult: ImportResponse | null, playerId: string) {
  for (const candidate of importResult?.candidates ?? []) {
    const option = candidate.alternatives.find((alternative) => alternative.player_id === playerId);
    if (option) return option;
    if (candidate.match?.player_id === playerId) return candidate.match;
  }
  return null;
}

function playerToImportOption(player: Player): ImportPlayerOption {
  return {
    player_id: player.player_id,
    name: player.name,
    team: player.team,
    team_abbr: player.team_abbr,
    position: player.position,
    price: player.price,
    worldcup_player_id: player.worldcup_player_id,
  };
}

function normalizeSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function cetDateKey(iso: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Oslo",
    year: "numeric",
  }).formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function cetTime(iso: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Oslo",
  }).format(new Date(iso));
}

function matchdayTitle(dayKey: string) {
  return new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "long",
    timeZone: "Europe/Oslo",
    weekday: "long",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

function shortDayLabel(dayKey: string, todayKey: string) {
  if (dayKey === todayKey) return "I dag";
  const tomorrow = new Date(`${todayKey}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (dayKey === tomorrow.toISOString().slice(0, 10)) return "I morgen";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Oslo",
    weekday: "short",
  }).format(new Date(`${dayKey}T12:00:00Z`));
}

function isLiveFixture(fixture: Fixture) {
  return ["live", "ht", "in_play", "first_half", "second_half", "extra_time", "penalties"].includes(fixture.status.toLowerCase());
}

function isFinishedFixture(fixture: Fixture) {
  return ["ft", "finished", "awarded"].includes(fixture.status.toLowerCase());
}

function statusLabel(fixture: Fixture) {
  const status = fixture.status.toLowerCase();
  if (status === "live") return "LIVE";
  if (status === "ht") return "Pause";
  if (["ft", "finished"].includes(status)) return "Ferdig";
  if (status === "scheduled") return "Ikke startet";
  if (status === "postponed") return "Utsatt";
  if (status === "cancelled") return "Avlyst";
  return fixture.status;
}

function stageLabel(stage: string, group: string | null) {
  if (stage === "group") return group ? `Gruppe ${group}` : "Gruppespill";
  const labels: Record<string, string> = {
    r32: "32-delsfinale",
    r16: "8-delsfinale",
    qf: "Kvartfinale",
    sf: "Semifinale",
    third: "Bronsefinale",
    final: "Finale",
  };
  return labels[stage] ?? stage;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
