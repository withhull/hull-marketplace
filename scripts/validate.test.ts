import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { gitPluginId, validateRepository } from "./validate.ts";

const REPO_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hull-marketplace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, rel: string, text: string) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

const MCP = `id: example
name: Example
description: Example MCP server.
author: Hull
url: https://example.com/mcp
category: development
content:
  - name: NPX
    content: |
      { "command": "npx", "args": ["-y", "example-mcp"], "env": { "TOKEN": "{{TOKEN}}" } }
    parameters:
      - name: Token
        key: TOKEN
        placeholder: tok_123
        secret: true
`;

const AGENT = `---
name: Reviewer
description: Reviews code.
category: development
mode: subagent
---

Review the diff.
`;

const SKILL = `---
name: notes
description: Writes notes.
metadata:
  category: productivity
---

# Notes
`;

const PLUGIN = (id: string, content: string) => `id: "${id}"
name: Plugin
description: A plugin.
category: providers
author: Hull
url: https://example.com/plugin
content: "${content}"
`;

test("the repository catalogue and examples are valid", () => {
  const { entries, errors } = validateRepository(REPO_ROOT);
  assert.deepEqual(errors, []);
  assert.ok(entries >= 4);
});

test("accepts one valid entry of each kind, including nested plugin ids", (t) => {
  const root = fixture(t);
  write(root, "mcps/example/MCP.yaml", MCP);
  write(root, "agents/reviewer/AGENT_DEFINITION.md", AGENT);
  write(root, "skills/notes/SKILL.md", SKILL);
  write(root, "skills/notes/references/guide.md", "Extra skill files are allowed.");
  write(root, "plugins/my-plugin/PLUGIN.yaml", PLUGIN("my-plugin", "my-plugin@^1.2.0"));
  write(root, "plugins/@scope/package/PLUGIN.yaml", PLUGIN("@scope/package", "@scope/package@latest"));
  write(
    root,
    "plugins/git/github.com/owner/repo/PLUGIN.yaml",
    PLUGIN("git/github.com/owner/repo", "git:github.com/owner/repo@v1"),
  );
  assert.deepEqual(validateRepository(root), { entries: 6, errors: [] });
});

test("rejects unknown fields, bad categories and tags", (t) => {
  const root = fixture(t);
  write(root, "mcps/example/MCP.yaml", MCP.replace("category: development", "category: games\ntags: [x]"));
  const { errors } = validateRepository(root);
  assert.ok(errors.some((error) => error.includes("additionalProperties") || error.includes("(tags)")));
  assert.ok(errors.some((error) => error.includes("/category")));
});

test("rejects duplicate YAML keys", (t) => {
  const root = fixture(t);
  write(root, "mcps/example/MCP.yaml", MCP.replace("name: Example", "name: Example\nname: Again"));
  assert.match(validateRepository(root).errors.join("\n"), /unique|duplicate/i);
});

test("requires ids to match directories", (t) => {
  const root = fixture(t);
  write(root, "mcps/other/MCP.yaml", MCP);
  write(root, "skills/renamed/SKILL.md", SKILL);
  const errors = validateRepository(root).errors.join("\n");
  assert.match(errors, /mcps\/other\/MCP\.yaml: id must match directory name/);
  assert.match(errors, /skills\/renamed\/SKILL\.md: name must match directory name/);
});

test("checks MCP configuration JSON and parameter placeholders", (t) => {
  const root = fixture(t);
  write(root, "mcps/example/MCP.yaml", MCP.replace('"{{TOKEN}}"', '"{{MISSING}}"').replace('"args"', "args"));
  const errors = validateRepository(root).errors.join("\n");
  assert.match(errors, /is not valid JSON/);
  assert.match(errors, /\{\{MISSING\}\} without a matching parameter/);
});

test("requires prompt bodies and rejects extra files in single-manifest entries", (t) => {
  const root = fixture(t);
  write(root, "agents/reviewer/AGENT_DEFINITION.md", AGENT.replace("Review the diff.\n", ""));
  write(root, "agents/reviewer/script.sh", "echo hi");
  write(root, "skills/notes/SKILL.md", SKILL);
  write(root, "skills/notes/local.patch", "internal");
  const errors = validateRepository(root).errors.join("\n");
  assert.match(errors, /agent prompt body is required/);
  assert.match(errors, /agents entries contain only AGENT_DEFINITION\.md/);
  assert.match(errors, /"local\.patch" is reserved/);
});

test("rejects symbolic links", (t) => {
  const root = fixture(t);
  write(root, "skills/notes/SKILL.md", SKILL);
  fs.symlinkSync("/etc/hosts", path.join(root, "skills/notes/hosts"));
  assert.match(validateRepository(root).errors.join("\n"), /symbolic links are not allowed/);
});

for (const [content, reason] of [
  ["other-plugin@1.0.0", "a different package"],
  ["my-plugin@npm:other@1.0.0", "an npm alias"],
  ["my-plugin@file:../plugin", "a local path"],
  ["my-plugin@https://example.com/p.tgz", "a tarball URL"],
] as const) {
  test(`rejects plugin content that is ${reason}`, (t) => {
    const root = fixture(t);
    write(root, "plugins/my-plugin/PLUGIN.yaml", PLUGIN("my-plugin", content));
    assert.match(validateRepository(root).errors.join("\n"), /content (must be|is not)/);
  });
}

test("requires git plugin ids to equal the normalized git identity", (t) => {
  const root = fixture(t);
  write(
    root,
    "plugins/git/github.com/owner/other/PLUGIN.yaml",
    PLUGIN("git/github.com/owner/other", "git:github.com/owner/repo"),
  );
  assert.match(
    validateRepository(root).errors.join("\n"),
    /id must equal the git source identity \(git\/github\.com\/owner\/repo\)/,
  );
});

test("reports plugin directories without a manifest", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "plugins/@scope/empty"), { recursive: true });
  assert.match(validateRepository(root).errors.join("\n"), /missing PLUGIN\.yaml/);
});

test("normalizes git plugin identities", () => {
  assert.equal(gitPluginId("git:github.com/owner/repo"), "git/github.com/owner/repo");
  assert.equal(gitPluginId("git:github.com/owner/repo@v1.2.0#plugins/x"), "git/github.com/owner/repo/plugins/x");
  assert.equal(gitPluginId("git:https://gitlab.com/group/repo.git@main"), "git/gitlab.com/group/repo");
  for (const bad of [
    "git:",
    "git:github.com/owner",
    "git:github.com/owner/repo@-bad",
    "git:github.com/owner/repo@a..b",
    "git:github.com/owner/repo#../escape",
    "git:http://example.com/repo",
    "git:file:///tmp/repo",
  ]) {
    assert.equal(gitPluginId(bad), undefined, bad);
  }
});
