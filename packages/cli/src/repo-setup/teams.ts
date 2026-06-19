import type { LinearTeam } from "@milo/core";

/**
 * Fuzzy-match the inferred repo against the workspace's Linear teams to pre-select likely
 * mappings — a pure function so the preselection logic is unit-testable without the network.
 *
 * A team is pre-selected when its key or name shares a normalized token with the repo name or
 * GitHub slug (e.g. repo `milo-sandbox` ↔ team key `SBX` / name "Milo Sandbox"). Conservative:
 * single-character tokens are ignored to avoid spurious matches.
 */
export function preselectTeamKeys(
  teams: LinearTeam[],
  inferred: { name: string; githubRepo?: string },
): string[] {
  const repoTokens = tokenize([inferred.name, inferred.githubRepo?.split("/")[1] ?? ""].join(" "));
  if (repoTokens.size === 0) return [];
  return teams
    .filter((t) => {
      const teamTokens = tokenize(`${t.key} ${t.name}`);
      for (const rt of repoTokens) {
        for (const tt of teamTokens) {
          if (rt === tt || rt.startsWith(tt) || tt.startsWith(rt)) return true;
        }
      }
      return false;
    })
    .map((t) => t.key);
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1),
  );
}
