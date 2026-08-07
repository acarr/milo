import { logger } from "@milo/core";

/**
 * Typed client for the Conductor Cloud public API (`https://api.conductor.build/v0`).
 *
 * The API is **beta** — response shapes may move under us — so nothing here asserts on a shape it
 * doesn't strictly need. Unknown fields are ignored, and a missing cosmetic field degrades to a
 * sensible default rather than failing a job that is otherwise fine.
 *
 * Two non-obvious facts, both confirmed against the live API:
 *  - `GET /me` has **no `/v0` prefix** (it hangs off the origin).
 *  - The API sits behind a proxy that rejects some default client signatures — notably Node's
 *    `undici` — with a **403 that looks exactly like a bad API key**. A real `User-Agent` is
 *    mandatory, not cosmetic.
 */

export type ConductorAgent = "claude" | "codex" | "cursor" | "acp";
export type ConductorEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type SessionStatus = "idle" | "working" | "error";
export type WorkspaceStatus =
  | "initializing"
  | "ready"
  | "sleeping"
  | "archived"
  | "deleted"
  | "updating";

export interface CreateWorkspaceInput {
  /** `projectId` XOR `repositoryUrl`. With an ORG api key `repositoryUrl` is rejected unless the
   *  repo has been added to the org's machine, so `projectId` is the reliable choice. */
  projectId?: string;
  repositoryUrl?: string;
  /** Base branch the cloud clone starts from. */
  branch?: string;
  /** Names the workspace AND seeds its git branch (Conductor prefixes it, e.g. `conductor/<name>`). */
  name?: string;
  sessionName?: string;
  agent?: ConductorAgent;
  model?: string;
  effort?: ConductorEffort;
  env?: Record<string, string>;
}

export interface CreatedWorkspace {
  workspaceId: string;
  sessionId: string;
  deepLink: string;
}

export interface ConductorMessage {
  id: string;
  sessionId: string;
  sessionIndex: number;
  /** `agent` | `userMessage` (observed); treated as an open set. */
  type: string;
  /** Free-form. For the `claude` agent this carries `rawPayload` = verbatim Claude stream-json. */
  content: unknown;
  receivedAt: string;
}

export interface ConductorProject {
  id: string;
  name: string;
  gitRemote?: string;
}

/** The API's error envelope (`StructuredError`). `userMessage` is safe to show a human. */
export class ConductorError extends Error {
  readonly code: string | undefined;
  readonly userMessage: string;
  readonly debugMessage: string | undefined;
  readonly retryable: boolean;
  readonly source: string | undefined;
  readonly httpStatus: number;

  constructor(init: {
    httpStatus: number;
    code?: string;
    userMessage: string;
    debugMessage?: string;
    retryable?: boolean;
    source?: string;
  }) {
    super(init.userMessage);
    this.name = "ConductorError";
    this.httpStatus = init.httpStatus;
    this.code = init.code;
    this.userMessage = init.userMessage;
    this.debugMessage = init.debugMessage;
    this.source = init.source;
    // Explicit `retryable` wins; otherwise infer from the status class.
    this.retryable = init.retryable ?? (init.httpStatus === 429 || init.httpStatus >= 500);
  }
}

export interface ConductorClientOptions {
  apiKey: string;
  baseUrl?: string;
  userAgent?: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retry backoff schedule; length + 1 = total attempts. */
  backoffMs?: number[];
}

const DEFAULT_BACKOFF = [1_000, 3_000, 8_000];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

export class ConductorClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly origin: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly backoffMs: number[];

  constructor(opts: ConductorClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.conductor.build/v0").replace(/\/+$/, "");
    // `/me` is not under /v0 — derive the origin once so it can hang off the root.
    this.origin = new URL(this.baseUrl).origin;
    this.userAgent = opts.userAgent ?? "milo (+https://github.com/acarr/milo)";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
  }

  // ---------------------------------------------------------------- transport

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; absolute?: boolean } = {},
  ): Promise<T> {
    const url = opts.absolute ? `${this.origin}${path}` : `${this.baseUrl}${path}`;
    const attempts = this.backoffMs.length + 1;
    let last: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(this.jitter(this.backoffMs[attempt - 1]!));
      try {
        return await this.once<T>(method, url, opts.body);
      } catch (err) {
        last = err;
        const retryable =
          err instanceof ConductorError
            ? err.retryable
            : true; // network/abort errors are always worth one more go
        if (!retryable || attempt === attempts - 1) throw err;
        logger.warn(
          {
            url,
            attempt: attempt + 1,
            status: err instanceof ConductorError ? err.httpStatus : undefined,
            code: err instanceof ConductorError ? err.code : undefined,
            debug: err instanceof ConductorError ? err.debugMessage : (err as Error).message,
          },
          "conductor request failed — retrying",
        );
      }
    }
    throw last;
  }

  /** ±20% so a fleet of retries doesn't resonate. */
  private jitter(ms: number): number {
    return Math.round(ms * (0.8 + Math.random() * 0.4));
  }

  private async once<T>(method: string, url: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) throw this.toError(res.status, parsed, text);
    return parsed as T;
  }

  private toError(status: number, parsed: unknown, raw: string): ConductorError {
    if (isRecord(parsed) && str(parsed["userMessage"])) {
      return new ConductorError({
        httpStatus: status,
        code: str(parsed["code"]),
        userMessage: str(parsed["userMessage"])!,
        debugMessage: str(parsed["debugMessage"]),
        retryable: typeof parsed["retryable"] === "boolean" ? parsed["retryable"] : undefined,
        source: str(parsed["source"]),
      });
    }
    return new ConductorError({
      httpStatus: status,
      userMessage: `Conductor API returned HTTP ${status}`,
      debugMessage: raw.slice(0, 500),
    });
  }

  // ---------------------------------------------------------------- endpoints

  /** Verify the API key. Note the deliberate lack of a `/v0` prefix. */
  me(): Promise<{ userId: string; email: string; organizationId: string }> {
    return this.request("GET", "/me", { absolute: true });
  }

  async listProjects(): Promise<ConductorProject[]> {
    const out: ConductorProject[] = [];
    let offset = 0;
    // Drain the {data, offset, hasMore} pagination envelope.
    for (;;) {
      const page = await this.request<{ data?: ConductorProject[]; hasMore?: boolean }>(
        "GET",
        `/projects?limit=100&offset=${offset}`,
      );
      const batch = Array.isArray(page?.data) ? page.data : [];
      out.push(...batch);
      if (!page?.hasMore || batch.length === 0) break;
      offset += batch.length;
    }
    return out;
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<CreatedWorkspace> {
    const res = await this.request<Record<string, unknown>>("POST", "/workspaces", { body: input });
    const workspaceId = str(res?.["workspaceId"]);
    const sessionId = str(res?.["sessionId"]);
    if (!workspaceId || !sessionId) {
      throw new ConductorError({
        httpStatus: 200,
        userMessage: "Conductor created a workspace but returned no workspaceId/sessionId.",
        debugMessage: JSON.stringify(res).slice(0, 500),
        retryable: false,
      });
    }
    // deepLink is cosmetic — synthesize rather than fail a workspace that exists.
    const deepLink = str(res?.["deepLink"]) ?? `conductor://workspace?id=${workspaceId}`;
    return { workspaceId, sessionId, deepLink };
  }

  /** Open an additional session in an existing (warm) workspace — used on retry. */
  async createSession(input: {
    workspaceId: string;
    agent?: ConductorAgent;
    model?: string;
    effort?: ConductorEffort;
    name?: string;
  }): Promise<{ sessionId: string; deepLink?: string }> {
    const res = await this.request<Record<string, unknown>>("POST", "/sessions", { body: input });
    const sessionId = str(res?.["id"]) ?? str(res?.["sessionId"]);
    if (!sessionId) {
      throw new ConductorError({
        httpStatus: 200,
        userMessage: "Conductor created a session but returned no id.",
        debugMessage: JSON.stringify(res).slice(0, 500),
        retryable: false,
      });
    }
    return { sessionId, deepLink: str(res?.["deepLink"]) };
  }

  /**
   * Send a prompt. `messageId` is a client-supplied idempotency key (confirmed echoed back by the
   * API), so a retried send after a network blip can't double-prompt the agent.
   */
  sendMessage(
    sessionId: string,
    message: string,
    messageId?: string,
  ): Promise<{ messageId: string; state: string }> {
    return this.request("POST", `/sessions/${sessionId}/messages`, {
      body: messageId ? { message, messageId } : { message },
    });
  }

  sessionStatus(
    sessionId: string,
  ): Promise<{ status: SessionStatus; updatedAt?: string; errorMessage?: string; lastError?: string }> {
    return this.request("GET", `/sessions/${sessionId}/status`);
  }

  workspaceStatus(
    workspaceId: string,
  ): Promise<{ status: WorkspaceStatus; lifecycleStep?: string; errorMessage?: string }> {
    return this.request("GET", `/workspaces/${workspaceId}/status`);
  }

  /** Incremental transcript read. `after` and `limit/offset` are mutually exclusive per the spec. */
  async sessionMessages(
    sessionId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<{ data: ConductorMessage[]; hasMore: boolean }> {
    const q = opts.after
      ? `after=${encodeURIComponent(opts.after)}`
      : `limit=${opts.limit ?? 200}`;
    const page = await this.request<{ data?: ConductorMessage[]; hasMore?: boolean }>(
      "GET",
      `/sessions/${sessionId}/messages?${q}`,
    );
    return { data: Array.isArray(page?.data) ? page.data : [], hasMore: page?.hasMore === true };
  }

  /** Cancellation completes ASYNCHRONOUSLY — poll status to `idle` to confirm. */
  async cancelSession(sessionId: string): Promise<void> {
    await this.request("POST", `/sessions/${sessionId}/cancel`, { body: {} });
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    await this.request("POST", `/workspaces/${workspaceId}/archive`, { body: {} });
  }

  async sleepWorkspace(workspaceId: string): Promise<void> {
    await this.request("POST", `/workspaces/${workspaceId}/sleep`, { body: {} });
  }
}
