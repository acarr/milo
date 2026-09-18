import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIssueNode } from "@milo/core";

// The Linear issue node → LinearIssue mapping: comment ordering (the `last: 20` change), plus the
// attachments / parent / children the prompt now renders.

const base = {
  id: "uuid",
  identifier: "WAZ-9",
  title: "T",
  description: null,
  priorityLabel: null,
  url: "https://linear.app/x/issue/WAZ-9",
  state: { id: "s", name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "milo" }, { name: "class:chore" }] },
};

test("comments come out oldest → newest regardless of API order, with author fallbacks", () => {
  const issue = normalizeIssueNode({
    ...base,
    comments: {
      nodes: [
        { body: "third", createdAt: "2026-09-03T00:00:00Z", user: { name: "C" } },
        { body: "first", createdAt: "2026-09-01T00:00:00Z", user: null },
        { body: "second", createdAt: "2026-09-02T00:00:00Z", user: { name: "B" } },
      ],
    },
  });
  assert.deepEqual(
    issue.comments.map((c) => `${c.author}:${c.body}`),
    ["unknown:first", "B:second", "C:third"],
  );
  assert.deepEqual(issue.labels, ["milo", "class:chore"]);
  assert.equal(issue.description, "");
  assert.equal(issue.priorityLabel, "None");
});

test("attachments, parent and children map through; empty ones are omitted entirely", () => {
  const rich = normalizeIssueNode({
    ...base,
    comments: { nodes: [] },
    attachments: { nodes: [{ title: "Figma", url: "https://figma.com/f" }, { title: null, url: "https://x/y.png" }, { title: "no url", url: null }] },
    parent: { identifier: "WAZ-1", title: "Epic" },
    children: { nodes: [{ identifier: "WAZ-10", title: "child", state: { name: "In Progress" } }, { identifier: null }] },
  });
  assert.deepEqual(rich.attachments, [
    { title: "Figma", url: "https://figma.com/f" },
    { title: "", url: "https://x/y.png" },
  ]);
  assert.deepEqual(rich.parent, { identifier: "WAZ-1", title: "Epic" });
  assert.deepEqual(rich.children, [{ identifier: "WAZ-10", title: "child", state: "In Progress" }]);

  const bare = normalizeIssueNode({ ...base, comments: { nodes: [] }, attachments: { nodes: [] }, parent: null, children: { nodes: [] } });
  assert.equal("attachments" in bare, false);
  assert.equal("parent" in bare, false);
  assert.equal("children" in bare, false);

  // A lightweight node (the poller's list query) that lacks the fields entirely still maps.
  const light = normalizeIssueNode({ ...base, comments: { nodes: [] } });
  assert.equal(light.attachments, undefined);
  assert.deepEqual(light.comments, []);
});
