import { readFileSync, writeFileSync } from "node:fs";
import { configPath } from "./paths.js";
import { logger } from "./logger.js";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const LINEAR_OAUTH_TOKEN = "https://api.linear.app/oauth/token";

export interface LinearIssue {
  id: string; // uuid
  identifier: string; // e.g. SBX-1
  title: string;
  description: string;
  priorityLabel: string;
  url: string;
  state: { id: string; name: string; type: string };
  labels: string[];
  comments: { author: string; createdAt: string; body: string }[];
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearCredentials {
  token: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Reads Linear credentials from the config file (legacy milo.sh layout). */
export function loadLinearCredentials(path = configPath()): LinearCredentials {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  if (!raw["linearToken"]) throw new Error(`No linearToken in ${path}`);
  return {
    token: raw["linearToken"],
    refreshToken: raw["linearRefreshToken"],
    clientId: raw["linearClientId"],
    clientSecret: raw["linearClientSecret"],
  };
}

/** Persists refreshed tokens back into the config file, preserving other fields. */
function persistTokens(path: string, token: string, refreshToken?: string): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw["linearToken"] = token;
  if (refreshToken) raw["linearRefreshToken"] = refreshToken;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

export class LinearClient {
  private token: string;
  private readonly creds: LinearCredentials;
  private readonly path: string;

  constructor(creds: LinearCredentials, path = configPath()) {
    this.creds = creds;
    this.token = creds.token;
    this.path = path;
  }

  static fromConfig(path = configPath()): LinearClient {
    return new LinearClient(loadLinearCredentials(path), path);
  }

  /** POST a GraphQL query, transparently refreshing the OAuth token once on auth error. */
  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res = await this.post(query, variables);
    if (this.isAuthError(res)) {
      logger.warn("Linear token expired — refreshing");
      await this.refresh();
      res = await this.post(query, variables);
    }
    if (res.errors) {
      throw new Error(`Linear GraphQL error: ${JSON.stringify(res.errors)}`);
    }
    return res.data as T;
  }

  private async post(query: string, variables: Record<string, unknown>): Promise<any> {
    const r = await fetch(LINEAR_GRAPHQL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    return (await r.json()) as any;
  }

  private isAuthError(res: any): boolean {
    return Array.isArray(res?.errors)
      ? res.errors.some((e: any) => e?.extensions?.code === "AUTHENTICATION_ERROR")
      : false;
  }

  private async refresh(): Promise<void> {
    if (!this.creds.refreshToken || !this.creds.clientId || !this.creds.clientSecret) {
      throw new Error("Cannot refresh Linear token: missing refreshToken/clientId/clientSecret");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.creds.refreshToken,
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    });
    const r = await fetch(LINEAR_OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await r.json()) as { access_token?: string; refresh_token?: string; error?: string };
    if (!json.access_token || !json.access_token.startsWith("lin_oauth_")) {
      throw new Error(`Failed to refresh Linear token: ${json.error ?? "unknown error"}`);
    }
    this.token = json.access_token;
    this.creds.token = json.access_token;
    if (json.refresh_token) this.creds.refreshToken = json.refresh_token;
    persistTokens(this.path, this.token, this.creds.refreshToken);
    logger.info("Linear token refreshed");
  }

  async fetchIssue(identifier: string): Promise<LinearIssue> {
    const data = await this.query<{ issue: any }>(
      `query($id: String!) {
        issue(id: $id) {
          id identifier title description priority priorityLabel url
          state { id name type }
          labels { nodes { name } }
          comments(first: 20) { nodes { body createdAt user { name } } }
        }
      }`,
      { id: identifier },
    );
    const issue = data.issue;
    if (!issue) throw new Error(`Issue ${identifier} not found in Linear`);
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      priorityLabel: issue.priorityLabel ?? "None",
      url: issue.url,
      state: issue.state,
      labels: (issue.labels?.nodes ?? []).map((n: any) => n.name),
      comments: (issue.comments?.nodes ?? []).map((n: any) => ({
        author: n.user?.name ?? "unknown",
        createdAt: n.createdAt,
        body: n.body,
      })),
    };
  }

  /**
   * The issues that block `identifier` (its `blockedBy` relations). In Linear a "blocks" relation
   * is stored on the blocker's side, so from the dependent's perspective they appear as
   * `inverseRelations` of type `blocks` (the `issue` field is the blocker). Returns the dependent
   * issue's own uuid (needed to post a comment) alongside each blocker's identifier + state type.
   * Throws on a GraphQL/permission error so callers can fall back to parallel behavior.
   */
  async blockedBy(
    identifier: string,
  ): Promise<{ issueId: string; blockers: { identifier: string; stateType: string }[] }> {
    const data = await this.query<{ issue: any }>(
      `query($id: String!) {
        issue(id: $id) {
          id
          inverseRelations(first: 50) {
            nodes { type issue { identifier state { type } } }
          }
        }
      }`,
      { id: identifier },
    );
    const issue = data.issue;
    if (!issue) throw new Error(`Issue ${identifier} not found in Linear`);
    const blockers = (issue.inverseRelations?.nodes ?? [])
      .filter((n: any) => n.type === "blocks" && n.issue?.identifier)
      .map((n: any) => ({ identifier: n.issue.identifier as string, stateType: n.issue.state?.type ?? "unknown" }));
    return { issueId: issue.id, blockers };
  }

  private viewerIdCache: string | undefined;

  /** The Milo app user's id (cached). Used to scope agent-session delegation polling. */
  async viewerId(): Promise<string> {
    if (this.viewerIdCache) return this.viewerIdCache;
    const data = await this.query<{ viewer: { id: string } }>(`{ viewer { id } }`);
    this.viewerIdCache = data.viewer.id;
    return this.viewerIdCache;
  }

  private mapIssueNode(issue: any): LinearIssue {
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      priorityLabel: issue.priorityLabel ?? "None",
      url: issue.url,
      state: issue.state,
      labels: (issue.labels?.nodes ?? []).map((n: any) => n.name),
      comments: (issue.comments?.nodes ?? []).map((n: any) => ({
        author: n.user?.name ?? "unknown",
        createdAt: n.createdAt,
        body: n.body,
      })),
    };
  }

  /**
   * Issues carrying the trigger label (default `milo`) in a live state (unstarted|started),
   * updated within `sinceDays`, excluding any with `milo:ignore`. This is the controllable
   * "delegate this to Milo" signal — app users can't be set as a normal assignee, so a label
   * is the reliable hand-off. (Agent-session delegation is handled by `pendingAgentSessions`.)
   */
  async labeledIssues(label = "milo", sinceDays = 14): Promise<LinearIssue[]> {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
    const data = await this.query<{ issues: { nodes: any[] } }>(
      `query($label: String!, $since: DateTimeOrDuration!) {
        issues(
          first: 50
          filter: {
            labels: { name: { eq: $label } }
            state: { type: { in: ["unstarted", "started"] } }
            updatedAt: { gt: $since }
          }
        ) {
          nodes {
            id identifier title description priority priorityLabel url
            state { id name type }
            labels { nodes { name } }
            comments(first: 20) { nodes { body createdAt user { name } } }
          }
        }
      }`,
      { label, since },
    );
    return (data.issues?.nodes ?? [])
      .map((n) => this.mapIssueNode(n))
      .filter((i) => !i.labels.some((l) => l.toLowerCase() === "milo:ignore"));
  }

  /**
   * Agent sessions delegated to Milo that are awaiting work (status `pending`). This is the
   * native Linear "delegate to agent" hand-off (UI or @mention). Returns the session id (for
   * idempotency / future activity replies) alongside the issue identifier.
   */
  async pendingAgentSessions(): Promise<{ sessionId: string; issueIdentifier: string }[]> {
    const data = await this.query<{ agentSessions: { nodes: any[] } }>(
      `{ agentSessions(first: 50) {
          nodes { id status appUser { id } issue { identifier } }
      } }`,
    );
    const me = await this.viewerId();
    return (data.agentSessions?.nodes ?? [])
      .filter((s) => s.status === "pending" && s.appUser?.id === me && s.issue?.identifier)
      .map((s) => ({ sessionId: s.id, issueIdentifier: s.issue.identifier }));
  }

  /**
   * The most relevant agent session for an issue delegated to Milo: prefer a live one
   * (pending/active/awaitingInput), else the most recent. Returns its id, or undefined if the
   * issue was never delegated to the agent (e.g. it came in purely via the `milo` label).
   */
  async agentSessionForIssue(issueIdentifier: string): Promise<string | undefined> {
    const me = await this.viewerId();
    const data = await this.query<{ agentSessions: { nodes: any[] } }>(
      `{ agentSessions(first: 50) { nodes { id status createdAt appUser { id } issue { identifier } } } }`,
    );
    const mine = (data.agentSessions?.nodes ?? [])
      .filter((s) => s.appUser?.id === me && s.issue?.identifier === issueIdentifier)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
    if (!mine.length) return undefined;
    const live = ["pending", "active", "awaitingInput"];
    return (mine.find((s) => live.includes(s.status)) ?? mine[0]).id;
  }

  /** Milo's agent sessions with their activity timelines (id + createdAt + typed content body). */
  private async sessionsWithActivities(): Promise<
    { sessionId: string; issueIdentifier: string; activities: { id: string; createdAt: string; type: string; body: string }[] }[]
  > {
    const me = await this.viewerId();
    // Keep query complexity under Linear's 10k cap: fewer sessions × the most-recent activities.
    // `last: N` returns the newest N in chronological (oldest→newest) order, which is what the
    // follow-up detection below relies on (it inspects the final activity).
    const data = await this.query<{ agentSessions: { nodes: any[] } }>(
      `{ agentSessions(first: 30) {
          nodes {
            id appUser { id } issue { identifier }
            activities(last: 12) {
              nodes {
                id createdAt
                content {
                  __typename
                  ... on AgentActivityPromptContent { body }
                  ... on AgentActivityResponseContent { body }
                  ... on AgentActivityElicitationContent { body }
                }
              }
            }
          }
      } }`,
    );
    return (data.agentSessions?.nodes ?? [])
      .filter((s) => s.appUser?.id === me && s.issue?.identifier)
      .map((s) => ({
        sessionId: s.id,
        issueIdentifier: s.issue.identifier,
        activities: (s.activities?.nodes ?? [])
          .map((a: any) => ({
            id: a.id,
            createdAt: a.createdAt,
            type: (a.content?.__typename ?? "").replace(/^AgentActivity/, "").replace(/Content$/, ""),
            body: a.content?.body ?? "",
          }))
          .sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : 1)),
      }));
  }

  /**
   * Follow-up prompts awaiting Milo: an agent session whose LATEST activity is a user `Prompt` and
   * which already contains a prior agent `Response` — i.e. the user replied *after* Milo finished, so
   * it's a revision request (not the opening delegation, which `pendingAgentSessions` handles). Keyed
   * on the prompt activity id so each distinct reply re-triggers exactly once.
   */
  async pendingFollowupPrompts(): Promise<{ sessionId: string; issueIdentifier: string; promptId: string; body: string }[]> {
    const sessions = await this.sessionsWithActivities();
    const out: { sessionId: string; issueIdentifier: string; promptId: string; body: string }[] = [];
    for (const s of sessions) {
      const latest = s.activities[s.activities.length - 1];
      if (!latest || latest.type !== "Prompt") continue;
      if (!s.activities.some((a) => a.type === "Response")) continue; // require a prior reply → genuine follow-up
      out.push({ sessionId: s.sessionId, issueIdentifier: s.issueIdentifier, promptId: latest.id, body: latest.body });
    }
    return out;
  }

  /** The most recent user `Prompt` body in a session (the latest revision instruction), if any. */
  async latestPromptBody(sessionId: string): Promise<string | undefined> {
    const sessions = await this.sessionsWithActivities();
    const s = sessions.find((x) => x.sessionId === sessionId);
    if (!s) return undefined;
    const prompts = s.activities.filter((a) => a.type === "Prompt");
    return prompts.length ? prompts[prompts.length - 1]!.body : undefined;
  }

  /** Post an activity to an agent session (drives the Linear "chat" transcript). Best-effort. */
  async emitAgentActivity(sessionId: string, content: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await this.query<{ agentActivityCreate: { success: boolean } }>(
        `mutation($i: AgentActivityCreateInput!){ agentActivityCreate(input: $i){ success } }`,
        { i: { agentSessionId: sessionId, content } },
      );
      return res.agentActivityCreate?.success ?? false;
    } catch (err) {
      logger.warn({ sessionId, err: (err as Error).message }, "agent activity emit failed");
      return false;
    }
  }

  /** A `thought` activity — narrates progress; also revives a session that had gone stale. */
  agentThought(sessionId: string, body: string): Promise<boolean> {
    return this.emitAgentActivity(sessionId, { type: "thought", body });
  }

  /** An `action` activity — records a tool-call-style step (e.g. opened a PR). */
  agentAction(sessionId: string, action: string, parameter: string, result?: string): Promise<boolean> {
    return this.emitAgentActivity(sessionId, { type: "action", action, parameter, ...(result ? { result } : {}) });
  }

  /** A terminal `response` activity — Milo's final reply; transitions the session to `complete`. */
  agentResponse(sessionId: string, body: string): Promise<boolean> {
    return this.emitAgentActivity(sessionId, { type: "response", body });
  }

  /** A terminal `error` activity — surfaces a blocker/failure in the chat. */
  agentError(sessionId: string, body: string): Promise<boolean> {
    return this.emitAgentActivity(sessionId, { type: "error", body });
  }

  /** All teams the agent can see (id/key/name), sorted by key. Used by `milo add-repo`. */
  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.query<{ teams: { nodes: LinearTeam[] } }>(
      `{ teams(first: 250) { nodes { id key name } } }`,
    );
    return (data.teams?.nodes ?? [])
      .map((t) => ({ id: t.id, key: t.key, name: t.name }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async getTeamStates(teamKey: string): Promise<WorkflowState[]> {
    const data = await this.query<{ teams: { nodes: { states: { nodes: WorkflowState[] } }[] } }>(
      `query($tk: String!) {
        teams(filter: { key: { eq: $tk } }) {
          nodes { states { nodes { id name type } } }
        }
      }`,
      { tk: teamKey },
    );
    return data.teams.nodes[0]?.states.nodes ?? [];
  }

  /** Find a state id by (preferred) name, falling back to the first state of `type`. */
  async findStateId(teamKey: string, name: string, type: string): Promise<string | undefined> {
    const states = await this.getTeamStates(teamKey);
    return (
      states.find((s) => s.type === type && s.name === name)?.id ??
      states.find((s) => s.type === type)?.id
    );
  }

  async setIssueState(issueUuid: string, stateId: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $sid: String!) {
        issueUpdate(id: $id, input: { stateId: $sid }) { success }
      }`,
      { id: issueUuid, sid: stateId },
    );
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.query(
      `mutation($id: String!, $body: String!) {
        commentCreate(input: { issueId: $id, body: $body }) { success }
      }`,
      { id: issueId, body },
    );
  }
}
