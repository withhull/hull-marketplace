#!/usr/bin/env tsx
/**
 * Validate every catalogue entry (and the examples) against the JSON Schemas
 * and the rules the Hull Extensions generators enforce when they publish.
 *
 * Usage: pnpm validate [repository-root]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import matter from "gray-matter";
import npa from "npm-package-arg";
import validateNpmName from "validate-npm-package-name";
import { parseDocument } from "yaml";

export type Kind = "mcps" | "agents" | "skills" | "plugins";

export const KINDS: readonly Kind[] = ["mcps", "agents", "skills", "plugins"];

const MANIFEST: Record<Kind, string> = {
  mcps: "MCP.yaml",
  agents: "AGENT_DEFINITION.md",
  skills: "SKILL.md",
  plugins: "PLUGIN.yaml",
};

const SCHEMA: Record<Kind, string> = {
  mcps: "mcp.schema.json",
  agents: "agent.schema.json",
  skills: "skill.schema.json",
  plugins: "plugin.schema.json",
};

// Files the Hull Extensions packaging step treats as internal to its own tree.
const RESERVED_SKILL_FILES = new Set(["local.patch", "local.remove", "evals"]);
const MAX_SKILL_BYTES = 10 * 1024 * 1024;

const SCHEMAS_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "schemas");

export type Entry = { kind: Kind; dir: string; rel: string };

function loadValidators(): Record<Kind, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats.default(ajv);
  for (const file of fs.readdirSync(SCHEMAS_DIR).filter((name) => name.endsWith(".schema.json"))) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(SCHEMAS_DIR, file), "utf8")), file);
  }
  return Object.fromEntries(
    KINDS.map((kind) => [kind, ajv.getSchema(SCHEMA[kind]) as ValidateFunction]),
  ) as Record<Kind, ValidateFunction>;
}

function visibleDirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** Lists entry directories for one kind. Plugins nest by npm scope or git identity. */
export function listEntries(kindRoot: string, kind: Kind): Entry[] {
  if (kind !== "plugins") {
    return visibleDirectories(kindRoot).map((name) => ({
      kind,
      dir: path.join(kindRoot, name),
      rel: name,
    }));
  }
  const found: Entry[] = [];
  const visit = (rel: string) => {
    const abs = rel === "" ? kindRoot : path.join(kindRoot, rel);
    if (rel !== "" && fs.existsSync(path.join(abs, MANIFEST.plugins))) {
      found.push({ kind, dir: abs, rel });
      return;
    }
    const children = visibleDirectories(abs);
    // A leaf directory without a manifest is reported by the manifest check.
    if (children.length === 0 && rel !== "") found.push({ kind, dir: abs, rel });
    for (const child of children) visit(rel === "" ? child : `${rel}/${child}`);
  };
  visit("");
  return found;
}

function parseStrictYaml(text: string, file: string, errors: string[]): unknown {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  for (const error of doc.errors) errors.push(`${file}: ${error.message}`);
  for (const warning of doc.warnings) errors.push(`${file}: ${warning.message}`);
  return doc.errors.length > 0 ? undefined : doc.toJS();
}

function readFrontMatter(file: string, errors: string[]): { data: unknown; body: string } {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    errors.push(`${file}: missing YAML front matter`);
    return { data: undefined, body: text };
  }
  const data = parseStrictYaml(match[1], file, errors);
  return { data, body: matter(text).content };
}

function formatSchemaError(file: string, error: ErrorObject): string {
  const where = error.instancePath || "/";
  const extra =
    error.keyword === "additionalProperties"
      ? ` (${String((error.params as { additionalProperty: string }).additionalProperty)})`
      : error.keyword === "enum"
        ? ` (${(error.params as { allowedValues: unknown[] }).allowedValues.join(", ")})`
        : "";
  return `${file}: ${where} ${error.message ?? "is invalid"}${extra}`;
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) files.push(abs);
    else if (entry.isDirectory()) files.push(...walkFiles(abs));
    else files.push(abs);
  }
  return files;
}

const GIT_REPO = /^(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9_.-]+)+)$/;
const GIT_REF = /^(?![-.])(?!.*\.\.)(?!.*@\{)(?!.*\.lock$)[A-Za-z0-9._/-]+(?<![./])$/;
const GIT_SUBPATH = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Returns the catalogue id a git: plugin spec must use, or undefined when the spec is malformed. */
export function gitPluginId(content: string): string | undefined {
  if (!content.startsWith("git:")) return undefined;
  let body = content.slice("git:".length);
  let subpath: string | undefined;
  const hash = body.indexOf("#");
  if (hash !== -1) {
    subpath = body.slice(hash + 1);
    body = body.slice(0, hash);
    if (!GIT_SUBPATH.test(subpath)) return undefined;
  }
  const at = body.lastIndexOf("@");
  if (at !== -1) {
    if (!GIT_REF.test(body.slice(at + 1))) return undefined;
    body = body.slice(0, at);
  }
  if (!GIT_REPO.test(body)) return undefined;
  const repo = body.replace(/^https:\/\//, "").replace(/\.git$/i, "");
  return `git/${subpath ? `${repo}/${subpath}` : repo}`;
}

function checkPluginIdentity(file: string, rel: string, item: Record<string, unknown>, errors: string[]) {
  const id = String(item.id);
  const content = String(item.content);
  if (id !== rel) errors.push(`${file}: id must equal the directory path (${rel})`);
  if (content.startsWith("git:")) {
    const expected = gitPluginId(content);
    if (!expected) errors.push(`${file}: invalid git content spec "${content}"`);
    else if (expected !== id) errors.push(`${file}: id must equal the git source identity (${expected})`);
    return;
  }
  if (!validateNpmName(id).validForNewPackages) {
    errors.push(`${file}: id must be a valid npm package name or a git/ identity`);
    return;
  }
  try {
    const spec = npa(content);
    if (spec.name !== id || !spec.registry || !["version", "range", "tag"].includes(spec.type)) {
      errors.push(`${file}: content must be the ${id} registry package with an optional version, range, or tag`);
    }
  } catch {
    errors.push(`${file}: content is not a valid npm package spec`);
  }
}

function checkMcpConfigs(file: string, item: Record<string, unknown>, errors: string[]) {
  const topLevel = Array.isArray(item.parameters) ? (item.parameters as Array<{ key: string }>) : [];
  const methods =
    typeof item.content === "string"
      ? [{ name: "content", content: item.content, parameters: [] as Array<{ key: string }> }]
      : (item.content as Array<{ name: string; content: string; parameters?: Array<{ key: string }> }>);
  const names = new Set<string>();
  for (const method of methods) {
    if (names.has(method.name)) errors.push(`${file}: duplicate installation method name "${method.name}"`);
    names.add(method.name);
    try {
      const parsed = JSON.parse(method.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push(`${file}: installation method "${method.name}" must be a JSON object`);
      }
    } catch {
      errors.push(`${file}: installation method "${method.name}" is not valid JSON`);
    }
    const keys = new Set([...topLevel, ...(method.parameters ?? [])].map((parameter) => parameter.key));
    for (const match of method.content.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      if (!keys.has(match[1])) {
        errors.push(`${file}: installation method "${method.name}" uses {{${match[1]}}} without a matching parameter`);
      }
    }
  }
}

function checkEntryFiles(entry: Entry, manifest: string, errors: string[]) {
  const files = walkFiles(entry.dir);
  for (const file of files) {
    if (fs.lstatSync(file).isSymbolicLink()) errors.push(`${file}: symbolic links are not allowed`);
  }
  if (entry.kind !== "skills") {
    for (const file of files) {
      if (path.basename(file) !== MANIFEST[entry.kind] || path.dirname(file) !== entry.dir) {
        errors.push(`${file}: ${entry.kind} entries contain only ${MANIFEST[entry.kind]}`);
      }
    }
    return;
  }
  let bytes = 0;
  for (const file of files) {
    bytes += fs.lstatSync(file).size;
    const first = path.relative(entry.dir, file).split(path.sep)[0];
    if (RESERVED_SKILL_FILES.has(first)) errors.push(`${file}: "${first}" is reserved and would not be packaged`);
  }
  if (bytes > MAX_SKILL_BYTES) errors.push(`${manifest}: skill directory exceeds ${MAX_SKILL_BYTES} bytes`);
}

export function validateEntry(entry: Entry, validators: Record<Kind, ValidateFunction>): string[] {
  const errors: string[] = [];
  const manifest = path.join(entry.dir, MANIFEST[entry.kind]);
  if (!fs.existsSync(manifest)) return [`${entry.dir}: missing ${MANIFEST[entry.kind]}`];
  checkEntryFiles(entry, manifest, errors);

  let data: unknown;
  let body = "";
  if (entry.kind === "mcps" || entry.kind === "plugins") {
    data = parseStrictYaml(fs.readFileSync(manifest, "utf8"), manifest, errors);
  } else {
    ({ data, body } = readFrontMatter(manifest, errors));
  }
  if (data === undefined) return errors;

  const validate = validators[entry.kind];
  if (!validate(data)) {
    for (const error of validate.errors ?? []) errors.push(formatSchemaError(manifest, error));
    return errors;
  }

  const item = data as Record<string, unknown>;
  switch (entry.kind) {
    case "mcps":
      if (item.id !== entry.rel) errors.push(`${manifest}: id must match directory name (${entry.rel})`);
      checkMcpConfigs(manifest, item, errors);
      break;
    case "agents":
      if (item.id !== undefined && item.id !== entry.rel) {
        errors.push(`${manifest}: id must match directory name (${entry.rel})`);
      }
      if (body.trim().length === 0) errors.push(`${manifest}: the agent prompt body is required`);
      break;
    case "skills":
      if (item.name !== entry.rel) errors.push(`${manifest}: name must match directory name (${entry.rel})`);
      if (body.trim().length === 0) errors.push(`${manifest}: the skill instructions body is required`);
      break;
    case "plugins":
      checkPluginIdentity(manifest, entry.rel, item, errors);
      break;
  }
  return errors;
}

/** Validates the catalogue directories and the examples under the given root. */
export function validateRepository(root: string): { entries: number; errors: string[] } {
  const validators = loadValidators();
  const errors: string[] = [];
  let entries = 0;
  for (const base of [root, path.join(root, "examples")]) {
    for (const kind of KINDS) {
      const seen = new Map<string, string>();
      for (const entry of listEntries(path.join(base, kind), kind)) {
        entries++;
        const previous = seen.get(entry.rel.toLowerCase());
        if (previous) errors.push(`${entry.dir}: duplicate ${kind} id also declared in ${previous}`);
        seen.set(entry.rel.toLowerCase(), entry.dir);
        errors.push(...validateEntry(entry, validators));
      }
    }
  }
  return { entries, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(process.argv[2] ?? path.join(SCHEMAS_DIR, ".."));
  const { entries, errors } = validateRepository(root);
  for (const error of errors) console.error(error);
  console.log(`Validated ${entries} entries: ${errors.length} problem(s).`);
  process.exitCode = errors.length > 0 ? 1 : 0;
}
