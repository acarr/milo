import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunnerResult } from "../src/result.js";

// The optional `criteria: {passed, total}` field a workflow may ask the agent to report.

test("a well-formed criteria tally is passed through", () => {
  const r = parseRunnerResult(
    'MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"ok","criteria":{"passed":3,"total":4}}',
  );
  assert.deepEqual(r.criteria, { passed: 3, total: 4 });
  assert.equal(r.parseNote, undefined);
});

test("a malformed or missing criteria field is dropped, never trusted", () => {
  assert.equal(parseRunnerResult('MILO_RESULT={"outcome":"implemented","wroteCode":true,"prUrl":null,"summary":"ok"}').criteria, undefined);
  assert.equal(parseRunnerResult('MILO_RESULT={"outcome":"implemented","summary":"ok","criteria":"3/4"}').criteria, undefined);
  assert.equal(parseRunnerResult('MILO_RESULT={"outcome":"implemented","summary":"ok","criteria":{"passed":"3","total":4}}').criteria, undefined);
  assert.equal(parseRunnerResult('MILO_RESULT={"outcome":"implemented","summary":"ok","criteria":{"passed":-1,"total":4}}').criteria, undefined);
  assert.equal(parseRunnerResult('MILO_RESULT={"outcome":"implemented","summary":"ok","criteria":{"passed":1.5,"total":4}}').criteria, undefined);
});
