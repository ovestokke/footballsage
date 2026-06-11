"use client";

import { useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

type ImportPlayerOption = {
  player_id: string;
  name: string;
  team: string;
  team_abbr: string;
  position: string;
  price: number;
  worldcup_player_id: string | null;
};

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

type Selection = Record<number, string>;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function optionLabel(option: ImportPlayerOption) {
  return `${option.name} · ${option.team_abbr} · ${option.position} · ${option.price.toFixed(1)}m`;
}

export default function ImportTeamPage() {
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("Erling Haaland\nMohamed Salah\nMarcus Rashford");
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [selections, setSelections] = useState<Selection>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = useMemo(() => {
    if (!result) return [];
    return result.candidates
      .map((candidate, index) => {
        const selectedId = selections[index] ?? candidate.match?.player_id;
        return candidate.alternatives.find((option) => option.player_id === selectedId) ?? candidate.match;
      })
      .filter(Boolean) as ImportPlayerOption[];
  }, [result, selections]);

  async function postImport(path: string, body: object) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? "Import failed");
      setResult(payload);
      setSelections({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  async function importScreenshot() {
    if (!file) {
      setError("Velg et screenshot først.");
      return;
    }
    const imageBase64 = await readFileAsDataUrl(file);
    await postImport("/team/import-screenshot", { provider: "tv2", filename: file.name, image_base64: imageBase64 });
  }

  async function importText() {
    await postImport("/team/import-text", { provider: "tv2", text: pasteText });
  }

  return (
    <main className="shell importShell">
      <section className="importHero">
        <div>
          <p className="eyebrow">TV2 team intake</p>
          <h1>Importer laget</h1>
          <p className="lede">
            Start med screenshot eller limt tekst. OCR-resultatet brukes bare som forslag — du må
            bekrefte hver spiller før laget kan brukes til rating eller transfers.
          </p>
        </div>
        <a className="backLink" href="/">← Dashboard</a>
      </section>

      <section className="importGrid">
        <article className="panel importPanel">
          <div className="panelHeader">
            <p>Steg 1</p>
            <h2>Screenshot OCR</h2>
          </div>
          <label className="dropZone">
            <input type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
            <span>{file ? file.name : "Velg screenshot fra TV2-laget"}</span>
            <small>PNG/JPG/WebP opptil 8 MB. Crop rundt spillerkortene gir best treff.</small>
          </label>
          <button className="actionButton" disabled={loading || !file} onClick={importScreenshot}>
            {loading ? "Leser…" : "Kjør OCR"}
          </button>
        </article>

        <article className="panel importPanel">
          <div className="panelHeader">
            <p>Alternativ</p>
            <h2>Lim inn tekst</h2>
          </div>
          <textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} />
          <button className="actionButton ghost" disabled={loading || !pasteText.trim()} onClick={importText}>
            Match tekst mot TV2-priser
          </button>
        </article>
      </section>

      {error && <div className="errorBox">{error}</div>}

      {result && (
        <section className="panel verifyPanel">
          <div className="panelHeader">
            <p>Steg 2 · manuell verifikasjon</p>
            <h2>{result.candidates.length} OCR-forslag</h2>
          </div>

          <div className="verifySummary">
            <strong>{confirmed.length}</strong>
            <span>spillere valgt for foreløpig TV2-lag</span>
            <p>Ingen lagring skjer ennå. Neste steg blir save/rate endpoint.</p>
          </div>

          <div className="candidateList">
            {result.candidates.map((candidate, index) => (
              <div className={`candidate ${candidate.status}`} key={`${candidate.raw_text}-${index}`}>
                <div>
                  <span className="statusPill">{candidate.status}</span>
                  <strong>{candidate.raw_text}</strong>
                  <p>{Math.round(candidate.confidence * 100)}% confidence</p>
                </div>
                <select
                  value={selections[index] ?? candidate.match?.player_id ?? ""}
                  onChange={(event) => setSelections((current) => ({ ...current, [index]: event.target.value }))}
                >
                  {!candidate.match && <option value="">Velg spiller manuelt senere</option>}
                  {candidate.alternatives.map((option) => (
                    <option value={option.player_id} key={option.player_id}>{optionLabel(option)}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <details className="ocrRaw">
            <summary>Rå OCR-tekst</summary>
            <pre>{result.raw_text}</pre>
          </details>
        </section>
      )}
    </main>
  );
}
