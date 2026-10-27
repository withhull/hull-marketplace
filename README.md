# Hull Marketplace

The public catalogue of extensions for [Hull Code](https://docs.withhull.com): MCP servers, agents, skills and plugins that people can browse and install from the Hull Code CLI, VS Code and JetBrains extensions, and desktop app.

## Categories

| Folder | What it lists | Entry file |
|---|---|---|
| [`mcps/`](mcps/) | **MCP servers** that connect agents to external tools and services. Each entry has one or more install methods (a local command or a remote URL) and the values to ask for at install time, such as API keys. | `mcps/<id>/MCP.yaml` |
| [`agents/`](agents/) | **Agents** (formerly *modes*): a prompt plus its mode, permissions and optional model settings. Hull Code 5.x modes are served from these. | `agents/<id>/AGENT_DEFINITION.md` |
| [`skills/`](skills/) | **Skills**: instructions and supporting files that teach an agent a workflow. The whole folder is packaged and installed as-is. | `skills/<id>/SKILL.md` |
| [`plugins/`](plugins/) | **Plugins** that extend Hull Code with hooks, tools, auth or model providers. Each entry points at an npm package or a git repository. | `plugins/<id>/PLUGIN.yaml` |

Every entry has a single primary `category`: `business`, `data`, `development`, `observability`, `productivity`, `search` or `web-automation`. Agents and skills can also use `creative-media`, and plugins can use `providers`.

The JSON Schemas in [`schemas/`](schemas/) define every field. [`examples/`](examples/) has one complete entry for each type. The examples are validated but never published.

## How entries reach Hull Code

1. An entry is merged into `main` here after the **Validate catalogue** check passes. The check covers the schemas, strict YAML, ID and directory rules, valid MCP configuration JSON, and npm or git identities for plugins.
2. Hull Extensions (Hull's publishing pipeline) syncs this repository, runs its catalogue generators, and opens a review pull request with the regenerated catalogues.
3. When that pull request is merged and published, the catalogues and skill archives are uploaded to the [`extensions-latest`](https://github.com/withhull/hullcode-releases/releases/tag/extensions-latest) release.
4. The Hull Code clients read the catalogues from `https://app.withhull.com/api/marketplace/{mcps,agents,skills,plugins}`.

Changes here therefore appear in Hull Code after they're synced, reviewed and published, not on merge.

## Checking entries locally

```bash
pnpm install
pnpm run check
```

`pnpm run check` typechecks and tests the validator, then validates every entry and example.

## Licensing

Licensing terms for this repository are coming soon. Each listed item keeps its own license. Skills record theirs in the `license` field of `SKILL.md`.
