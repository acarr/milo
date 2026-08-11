import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunnerResult } from "../src/result.js";

/**
 * MILO_RESULT parsing must not throw a good summary away over a formatting slip.
 *
 * Live evidence (2026-08-06/08-03, wazzon): two runs finished cleanly — `is_error:false`,
 * `stop_reason:"end_turn"` — but their final `MILO_RESULT={…}` line ended at the closing quote of
 * `summary` with the `}` missing. The old parser's `JSON.parse` threw, the catch fell through to a
 * bare PR-URL grep, and ~450 characters of summary became `""` with nothing logged. That is how
 * PR #700 got a blank Linear report and PR #707 got a body reading only "Implements WAZ-1150".
 */

const line = (json: string) => `Some narration first.\nMILO_RESULT=${json}`;

test("parses a well-formed MILO_RESULT line", () => {
  const r = parseRunnerResult(
    line('{"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/o/r/pull/1","summary":"Did the thing."}'),
  );
  assert.equal(r.outcome, "implemented");
  assert.equal(r.wroteCode, true);
  assert.equal(r.prUrl, "https://github.com/o/r/pull/1");
  assert.equal(r.summary, "Did the thing.");
  assert.equal(r.parseNote, undefined, "a clean parse leaves no note");
});

test("recovers the summary from a payload truncated before its closing brace (the live WAZ-1107 shape)", () => {
  const truncated =
    '{"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/octave-partners/wazzon/pull/700",' +
    '"summary":"Gated the take fields on a crew-union-self audience in both scopes; verified by curl repro, on the iOS sim, and with 3 new in-process tests."';
  const r = parseRunnerResult(line(truncated));
  assert.equal(r.outcome, "implemented");
  assert.equal(r.prUrl, "https://github.com/octave-partners/wazzon/pull/700");
  assert.match(r.summary, /crew-union-self audience/);
  assert.match(r.summary, /3 new in-process tests\.$/, "the whole summary survives, not a prefix");
  assert.match(r.parseNote ?? "", /truncated/);
});

test("recovers when the truncation lands mid-string", () => {
  const r = parseRunnerResult(line('{"outcome":"discovery","wroteCode":false,"summary":"Found the cause but ran out of'));
  assert.equal(r.outcome, "discovery");
  assert.equal(r.wroteCode, false);
  assert.equal(r.summary, "Found the cause but ran out of");
});

test("drops a dangling key rather than emitting invalid JSON", () => {
  const r = parseRunnerResult(line('{"outcome":"blocked","wroteCode":false,"summary":"Infra is down","prUrl":'));
  assert.equal(r.outcome, "blocked");
  assert.equal(r.summary, "Infra is down");
  assert.equal(r.prUrl, null);
});

test("scrapes the summary out of a payload too mangled to close", () => {
  // A stray unescaped control break inside the object — unbalanced in a way bracket-closing can't fix.
  const r = parseRunnerResult(line('{"outcome":"implemented" "wroteCode":true,"summary":"Shipped the endpoint."}'));
  assert.equal(r.summary, "Shipped the endpoint.");
  assert.equal(r.outcome, "implemented");
  assert.match(r.parseNote ?? "", /scraping/);
});

test("unescapes JSON escapes when scraping", () => {
  const r = parseRunnerResult(line('{"outcome":"implemented" "summary":"Quoted \\"thing\\" and a\\nnewline."}'));
  assert.equal(r.summary, 'Quoted "thing" and a\nnewline.');
});

test("no MILO_RESULT at all still falls back to a PR-URL grep, with no note", () => {
  const r = parseRunnerResult("I opened https://github.com/o/r/pull/42 for this.");
  assert.equal(r.prUrl, "https://github.com/o/r/pull/42");
  assert.equal(r.outcome, "implemented");
  assert.equal(r.wroteCode, true);
  assert.equal(r.parseNote, undefined, "an absent line is not a parse failure");
});

test("a crashed run with no result and no PR reports discovery, and says nothing was recoverable", () => {
  const r = parseRunnerResult("API Error: Connection closed mid-response. The response above may be incomplete.");
  assert.equal(r.outcome, "discovery");
  assert.equal(r.wroteCode, false);
  assert.equal(r.summary, "");
  assert.equal(r.parseNote, undefined);
});

test("an unrecoverable MILO_RESULT records why it was lost", () => {
  const r = parseRunnerResult(line("not json at all {{{"));
  assert.equal(r.summary, "");
  assert.match(r.parseNote ?? "", /unrecoverable/);
});

test("the last MILO_RESULT wins when the agent echoed the prompt's example earlier", () => {
  const out = [
    'The instructions said to print MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":"https://github.com/OWNER/repo/pull/123","summary":"Added X and Y."}',
    'MILO_RESULT={"outcome":"discovery","wroteCode":false,"prUrl":null,"summary":"The real answer."}',
  ].join("\n");
  assert.equal(parseRunnerResult(out).summary, "The real answer.");
});
