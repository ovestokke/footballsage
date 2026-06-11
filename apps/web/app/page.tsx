"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
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

type Scene = "import" | "verify" | "analysis";

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

export default function Home() {
  const [scene, setScene] = useState<Scene>("import");
  const [teamText, setTeamText] = useState(sampleTeam);
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const [draftSelections, setDraftSelections] = useState<Record<number, string>>({});
  const [draftLineup, setDraftLineup] = useState<Record<string, Omit<TeamSelection, "player_id">>>({});
  const [confirmedSelections, setConfirmedSelections] = useState<TeamSelection[]>([]);
  const [analysis, setAnalysis] = useState<TeamAnalysis | null>(null);
  const [round, setRound] = useState(1);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const visibleCandidates = useMemo(() => (importResult?.candidates ?? []).filter((candidate) => !isNoise(candidate)), [importResult]);
  const ignoredCandidates = useMemo(() => (importResult?.candidates ?? []).filter(isNoise), [importResult]);
  const selectedDraftIds = useMemo(() => unique(Object.values(draftSelections)), [draftSelections]);
  const selectedDraftCount = selectedDraftIds.length;
  const starterCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.role !== "bench").length;
  const benchCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.role === "bench").length;
  const captainCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.is_captain).length;
  const viceCaptainCount = selectedDraftIds.filter((playerId) => draftLineup[playerId]?.is_vice_captain).length;
  const captainId = selectedDraftIds.find((playerId) => draftLineup[playerId]?.is_captain);
  const viceCaptainId = selectedDraftIds.find((playerId) => draftLineup[playerId]?.is_vice_captain);
  const selectedDraftIsConfirmable = selectedDraftCount === squadSize && starterCount === 11 && benchCount === 4 && captainCount === 1 && viceCaptainCount === 1 && captainId !== viceCaptainId;
  const selectedDraftPlayers = useMemo(() => selectedDraftIds.map((playerId) => findDraftOption(importResult, playerId)).filter(Boolean) as ImportPlayerOption[], [importResult, selectedDraftIds]);

  useEffect(() => {
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
      payload.candidates.forEach((candidate, index) => {
        if (!isNoise(candidate) && candidate.match) nextSelections[index] = candidate.match.player_id;
      });
      setImportResult(payload);
      setDraftSelections(nextSelections);
      setDraftLineup({});
      setScene("verify");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import feilet");
    } finally {
      setLoading(false);
    }
  }

  function updateSelection(index: number, playerId: string) {
    setDraftSelections((current) => {
      const next = { ...current, [index]: playerId };
      if (!playerId) delete next[index];
      return next;
    });
  }

  function confirmSquad() {
    if (!selectedDraftIsConfirmable) return;
    setConfirmedSelections(
      selectedDraftIds.map((playerId) => ({
        player_id: playerId,
        role: draftLineup[playerId]?.role ?? "starter",
        is_captain: Boolean(draftLineup[playerId]?.is_captain),
        is_vice_captain: Boolean(draftLineup[playerId]?.is_vice_captain),
      })),
    );
    setScene("analysis");
  }

  function startNewImport() {
    setScene("import");
    setImportResult(null);
    setDraftSelections({});
    setDraftLineup({});
    setMessage(null);
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

  return (
    <main className="app-shell">
      <header className="app-top compact">
        <div>
          <p className="eyebrow">FootballSage</p>
          <h1>Sjekk om fantasy-laget er gyldig.</h1>
          <p>Tre steg: importer laget, bekreft 15 spillere, og få en ren regelsjekk. Ingen mekaniske råd eller “optimalisering” før AI-rådgiveren kobles inn.</p>
        </div>
        <SceneSteps scene={scene} />
      </header>

      {message && <p className="global-message">{message}</p>}

      {scene === "import" && (
        <section className="scene-card import-scene">
          <div className="scene-copy">
            <p className="eyebrow">Steg 1</p>
            <h2>Importer laget ditt</h2>
            <p>Bruk screenshot fra TV2 eller lim inn spillerlisten. Importen lager bare et forslag — eksisterende bekreftet lag endres ikke før du trykker “Bekreft lag”.</p>
          </div>

          <div className="import-grid">
            <article className="panel upload-panel">
              <PanelHeader title="Screenshot" subtitle="Anbefalt. OCR filtrerer bort overskrifter og støy før du bekrefter laget." />
              <label className="upload-zone">
                <input accept="image/*" type="file" onChange={(event) => void importScreenshot(event.target.files?.[0] ?? null)} />
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

      {scene === "verify" && importResult && (
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

          <div className="scene-actions">
            <button className="secondary-button" onClick={startNewImport}>Tilbake til import</button>
            <button disabled={!selectedDraftIsConfirmable} onClick={confirmSquad}>Bekreft lag</button>
          </div>
        </section>
      )}

      {scene === "analysis" && (
        <section className="analysis-scene">
          <div className="analysis-toolbar">
            <div>
              <p className="eyebrow">Steg 3</p>
              <h2>Regelsjekk av laget</h2>
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
            <button className="secondary-button" onClick={startNewImport}>Importer på nytt</button>
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
              <PanelHeader title="AI-rådgiver" subtitle="Dette er hovedområdet. Når AI kobles inn, kommer anbefalinger her basert på laget over." />
              <DecisionStack analysis={analysis} />
            </article>
          </section>
        </section>
      )}
    </main>
  );
}

function SceneSteps({ scene }: { scene: Scene }) {
  const steps: Array<[Scene, string]> = [["import", "Importer"], ["verify", "Bekreft"], ["analysis", "Sjekk"]];
  return (
    <ol className="scene-steps">
      {steps.map(([key, label], index) => <li className={scene === key ? "active" : ""} key={key}>{index + 1}. {label}</li>)}
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

function DecisionStack({ analysis }: { analysis: TeamAnalysis | null }) {
  if (!analysis) return <p className="empty">Bekreft laget først.</p>;
  return (
    <div className="decision-stack">
      <article className={analysis.issues.length ? "ai-placeholder blocked" : "ai-placeholder ready"}>
        <h4>{analysis.issues.length ? "Fiks varslene før AI-råd" : "Klar for AI-råd"}</h4>
        <p>{analysis.issues.length ? "AI bør ikke gi kaptein-, benk- eller bytteråd før laget er korrekt satt opp." : "Laget har 15 spillere, riktig start/benk/kaptein og ingen harde regelbrudd for valgt runde. Her kommer AI-anbefalingene senere."}</p>
      </article>
      {analysis.issues.map((issue) => <IssueCard issue={issue} key={`${issue.code}-${issue.player_id ?? issue.title}`} />)}
    </div>
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

function findDraftOption(importResult: ImportResponse | null, playerId: string) {
  for (const candidate of importResult?.candidates ?? []) {
    const option = candidate.alternatives.find((alternative) => alternative.player_id === playerId);
    if (option) return option;
    if (candidate.match?.player_id === playerId) return candidate.match;
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
