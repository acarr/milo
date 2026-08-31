import { listOpenPrs, prComments, logger, type MiloConfig, type RepoConfig } from "@milo/core";
import type { JobIntent } from "./index.js";

const TRIGGER_LABEL = "milo";
const MENTION = /@milo\b/i;

/**
 * Only repos that explicitly opt in (a `githubRepo` slug in config) are polled for PR triggers.
 * This keeps Milo from hammering unrelated repos that share a clone dir with other tools, and makes the
 * attach surface intentional. `githubSlugForPath` is still used at processing time as a fallback.
 */
function slugFor(repo: RepoConfig): string | undefined {
  return repo.githubRepo;
}

/** True when the actor list is empty (no gate) or contains `actor`. */
function actorAllowed(config: MiloConfig, actor: string | undefined): boolean {
  const allow = config.trust.githubActors;
  if (!allow.length) return true;
  return actor ? allow.includes(actor) : false;
}

/** How many PR-comment fetches may be in flight at once (see the call site for why it is bounded). */
const COMMENT_FETCH_CONCURRENCY = 8;

/** `Promise.all`-style map with an upper bound on in-flight work; results keep input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Poll configured repos for open PRs that ask for Milo: a `milo` label, or a `@milo` mention in
 * a comment. Each becomes an attach-mode JobIntent. The contentHash carries the trigger signature
 * (latest mention timestamp, or "label") so a *new* mention re-triggers while a stale one dedupes.
 */
export async function pollGithub(config: MiloConfig): Promise<JobIntent[]> {
  if (config.transports.github.enabled === false) return [];
  const intents: JobIntent[] = [];

  for (const repo of config.repositories) {
    const slug = slugFor(repo);
    if (!slug) continue;
    let prs;
    try {
      prs = await listOpenPrs(slug);
    } catch (err) {
      logger.warn({ slug, err: (err as Error).message }, "github poll failed");
      continue;
    }

    // One `gh api .../comments` round-trip per unlabeled PR. Sequentially that is ~0.5s * every open
    // PR in every configured repo, every cycle — so fetch them with bounded concurrency instead. The
    // bound keeps us from opening dozens of sockets (and tripping GitHub's secondary rate limits) at
    // once, while the poll still finishes in seconds rather than a minute.
    const commentsByPr = await mapWithConcurrency(prs, COMMENT_FETCH_CONCURRENCY, async (pr) =>
      pr.labels.some((l) => l.toLowerCase() === TRIGGER_LABEL) ? [] : prComments(slug, pr.number),
    );

    for (const [i, pr] of prs.entries()) {
      const hasLabel = pr.labels.some((l) => l.toLowerCase() === TRIGGER_LABEL);
      const mentions = commentsByPr[i]!.filter((c) => MENTION.test(c.body));
      const latestMention = mentions[mentions.length - 1];

      if (!hasLabel && !latestMention) continue;
      const actor = latestMention?.author ?? pr.author;
      if (!actorAllowed(config, actor)) {
        logger.info({ slug, pr: pr.number, actor }, "github trigger ignored — actor not allowlisted");
        continue;
      }

      const triggerSig = latestMention ? latestMention.createdAt : "label";
      intents.push({
        source: "github",
        entityId: `${slug}#${pr.number}`,
        entityRef: `${repo.name}#${pr.number}`,
        triggerType: latestMention ? "pr.mention" : "pr.label",
        contentHash: `${slug}#${pr.number}:${triggerSig}`,
        mode: "attach",
        repo: repo.name,
        actor,
      });
    }
  }
  return intents;
}
