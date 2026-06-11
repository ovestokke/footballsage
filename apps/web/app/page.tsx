const apiBase = process.env.API_INTERNAL_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

type Player = {
  player_id: string;
  name: string;
  team_abbr: string;
  position: string;
  price: number;
  expected_points: number;
  mapping_status: string | null;
  next_fixture: { opponent_code: string | null; difficulty: number | null; kickoff_utc: string } | null;
};

type Team = { id: string; name: string; fifa_code: string; group: string | null; fifa_ranking: number | null };
type Fixture = { id: string; match_number: number; home_team_code: string | null; away_team_code: string | null; kickoff_utc: string };

async function api<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${apiBase}${path}`, { next: { revalidate: 60 } });
    if (!response.ok) return fallback;
    return response.json();
  } catch {
    return fallback;
  }
}

export default async function Home() {
  const [players, teams, fixtures] = await Promise.all([
    api<Player[]>("/players?round=1&limit=96", []),
    api<Team[]>("/teams", []),
    api<Fixture[]>("/fixtures?limit=8", []),
  ]);

  const topPlayers = [...players].sort((a, b) => b.expected_points - a.expected_points).slice(0, 8);
  const matched = players.filter((player) => player.mapping_status === "matched").length;

  return (
    <main className="shell">
      <section className="hero">
        <div className="heroCopy">
          <p className="eyebrow">World Cup Fantasy intelligence desk</p>
          <h1>FootballSage</h1>
          <p className="lede">
            Official FIFA prices fused with the open World Cup dataset — ready for projections,
            optimizer logic and grounded AI answers.
          </p>
          <a className="heroAction" href="/import-team">Importer TV2-lag med OCR</a>
        </div>
        <div className="orbCard" aria-label="data status">
          <span className="orb" />
          <strong>{players.length || "—"}</strong>
          <p>priced players live from official fantasy JSON</p>
        </div>
      </section>

      <section className="metrics">
        <div>
          <span>Fantasy prices</span>
          <strong>Official</strong>
          <p>play.fifa.com JSON snapshot</p>
        </div>
        <div>
          <span>World Cup teams</span>
          <strong>{teams.length || "—"}</strong>
          <p>from emrbli/worldcup</p>
        </div>
        <div>
          <span>Matched context</span>
          <strong>{matched}/{players.length || "—"}</strong>
          <p>same-country player mapping</p>
        </div>
      </section>

      <section className="grid">
        <article className="panel picksPanel">
          <div className="panelHeader">
            <p>MD1 short list</p>
            <h2>High-signal picks</h2>
          </div>
          <div className="picks">
            {topPlayers.map((player, index) => (
              <div className="pick" key={player.player_id}>
                <span className="rank">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{player.name}</strong>
                  <p>
                    {player.team_abbr} · {player.position} · ${player.price.toFixed(1)}m
                  </p>
                </div>
                <div className="xp">
                  {player.expected_points.toFixed(2)}
                  <span>xP</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel fixturesPanel">
          <div className="panelHeader">
            <p>Data backbone</p>
            <h2>Opening fixtures</h2>
          </div>
          <div className="fixtures">
            {fixtures.map((fixture) => (
              <div className="fixture" key={fixture.id}>
                <span>#{fixture.match_number}</span>
                <strong>{fixture.home_team_code ?? "TBD"} <em>vs</em> {fixture.away_team_code ?? "TBD"}</strong>
                <time>{new Date(fixture.kickoff_utc).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</time>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="sourceStrip">
        <span>Official fantasy prices</span>
        <code>play.fifa.com/json/fantasy/players.json</code>
        <span>World Cup backbone</span>
        <code>github.com/emrbli/worldcup</code>
      </section>
    </main>
  );
}
