import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { configPath } from "@milo/core";

/**
 * Register Milo as a Linear *agent* (app user).
 *
 * Prereq: an admin has created a Linear OAuth application (Settings > API > Applications),
 * enabled "Agent session events" (optional until Phase 6), and set a redirect URI of
 * http://localhost:8989/callback.
 *
 * The OAuth flow itself lives in `runLinearOAuth` — a pure(ish) function that takes credentials
 * and returns tokens, so both the `milo linear-auth` command and the `milo init` wizard's
 * in-wizard Authenticate button can drive it. It never reads or writes config and never throws.
 */

const REDIRECT_PORT = 8989;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

export interface LinearAuthCreds {
  clientId: string;
  clientSecret: string;
}

export type LinearOAuthResult =
  | { ok: true; token: string; refreshToken: string; actorName: string; orgName: string }
  | { ok: false; error: string };

/**
 * Run the `actor=app` authorization flow: open the browser, wait for the localhost callback,
 * exchange the code, confirm identity. Resolves (never rejects) with tokens or an error.
 * `opts.signal` aborts the flow and frees port 8989 (e.g. Esc in the init wizard).
 */
export async function runLinearOAuth(
  creds: LinearAuthCreds,
  opts: { signal?: AbortSignal; onUrl?: (url: string) => void; openBrowser?: boolean } = {},
): Promise<LinearOAuthResult> {
  const { signal, onUrl, openBrowser = true } = opts;
  try {
    const state = Math.random().toString(36).slice(2);
    const authUrl =
      `https://linear.app/oauth/authorize?` +
      new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES.join(","),
        state,
        actor: "app",
        prompt: "consent",
      }).toString();

    onUrl?.(authUrl);

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", REDIRECT_URI);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const returnedCode = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          returnedCode
            ? "<h2>Milo authorized ✓</h2>You can close this tab and return to the terminal."
            : "<h2>Authorization failed</h2>No code returned.",
        );
        cleanup();
        if (!returnedCode) return reject(new Error("No authorization code returned"));
        if (returnedState !== state) return reject(new Error("OAuth state mismatch"));
        resolve(returnedCode);
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for authorization (5 min)"));
      }, 300_000);
      const onAbort = () => {
        cleanup();
        reject(new Error("cancelled"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        server.close();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      server.on("error", (err) => {
        cleanup();
        reject(err);
      });
      server.listen(REDIRECT_PORT, () => {
        if (!openBrowser) return;
        spawn("open", [authUrl], { stdio: "ignore" }).on("error", () => {
          /* user can paste the URL manually */
        });
      });
    });

    const tokenRes = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    });
    const tok = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tok.access_token) {
      return { ok: false, error: `Token exchange failed: ${tok.error_description ?? tok.error ?? "unknown"}` };
    }

    // Confirm identity (the agent's app-user / workspace).
    const viewer = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { viewer { id name } organization { name urlKey } }" }),
    });
    const who = (await viewer.json()) as {
      data?: { viewer?: { name?: string }; organization?: { name?: string } };
    };

    return {
      ok: true,
      token: tok.access_token,
      refreshToken: tok.refresh_token ?? "",
      actorName: who?.data?.viewer?.name ?? "?",
      orgName: who?.data?.organization?.name ?? "?",
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function readCreds(argv: string[]): LinearAuthCreds {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, string>;
  const clientId = flag("--client-id") ?? cfg["linearClientId"];
  const clientSecret = flag("--client-secret") ?? cfg["linearClientSecret"];
  if (!clientId || !clientSecret) {
    throw new Error(
      "Need a client id + secret. Pass --client-id <id> --client-secret <secret>, " +
        "or put linearClientId/linearClientSecret in ~/.milo/config.json first.",
    );
  }
  return { clientId, clientSecret };
}

function writeTokens(token: string, refreshToken: string, creds: LinearAuthCreds): void {
  const path = configPath();
  const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  cfg["linearClientId"] = creds.clientId;
  cfg["linearClientSecret"] = creds.clientSecret;
  cfg["linearToken"] = token;
  cfg["linearRefreshToken"] = refreshToken;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

/** The `milo linear-auth` command: read creds (flags or config), run the flow, persist tokens. */
export async function linearAuth(argv: string[]): Promise<number> {
  const creds = readCreds(argv);

  console.log("\nMilo — Linear agent authorization");
  console.log("Opening your browser to authorize the Milo app (admin approval required).");

  const result = await runLinearOAuth(creds, {
    openBrowser: true,
    onUrl: (url) => console.log("If it doesn't open, paste this URL:\n\n" + url + "\n"),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }

  writeTokens(result.token, result.refreshToken, creds);
  console.log("\n[milo] ✓ agent token written to ~/.milo/config.json");
  console.log(`[milo] acting as: ${result.actorName} in ${result.orgName}`);
  console.log("[milo] Milo is now an assignable/mentionable agent in the granted teams.\n");
  return 0;
}
