# Tack

Tack is a thin command line over
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The agent
loop, tools, sessions, web shell, and plugins are DeepSeek Harness's, pinned to
one exact version. Tack adds its own home, default model, profiles, browser
brand, and a small set of Molab research tools.
Pieces of that runtime get replaced with Tack's own only after they have been
used as published.

## Install (from source)

Requires Node 22.12 or newer and git.

```sh
git clone https://github.com/MolCrafts/Tack && cd Tack
npm run setup            # npm ci, build, link `tack` onto your PATH, run `tack doctor`
```

If linking needs permissions you don't have, set a user prefix first
(`npm config set prefix ~/.local`) or run `node packages/tack/lib/bin.js` directly.

## First test

With a DeepSeek key (Tack's default provider):

```sh
printf %s "$DEEPSEEK_API_KEY" | tack auth set DEEPSEEK_API_KEY
tack doctor              # ends with "Ready       yes"
tack run "list the files in this directory"
tack web                 # Tack's browser UI over DSH, on Tack's home
```

Any other provider works the same way, e.g.
`tack provider add anthropic --api-key-env ANTHROPIC_API_KEY` then
`tack model use anthropic/<model>` (see `tack model list`).

Without any key, the end-to-end suites run against a scripted local model:

```sh
npm run test:agent       # tack run: text, tools, stdin, plugins, delegation
npm run test:install     # a clean install from source, then the installed tack
DEEPSEEK_API_KEY=... npm run test:live   # one real turn (skips without a key)
```

## Usage

```sh
tack                     # help
tack run "task"          # answer one task and exit (`-` reads stdin)
tack web                 # serve Tack's DSH-based UI (`--port`, `--no-open` are DSH flags)
tack version             # Tack and runtime versions
tack doctor              # runtime, home, and profile state
tack doctor --dump-config
tack doctor --tools      # tools registered in a profile

tack model                               # default model of each profile
tack model list [--provider <id>]        # providers and their models
tack model use <provider>/<model>        # switch the default (every profile)
tack provider add anthropic --api-key-env ANTHROPIC_API_KEY
tack provider add gw --api openai-completions --base-url https://gw/v1 --model m
printf %s "$KEY" | tack auth set ANTHROPIC_API_KEY
tack run --model openai/gpt-5 "task"     # another model for one run

tack plugin add <package|tarball|path>   # install into the default profile
tack plugin list | enable | disable | remove
tack plugin add <package> --profile supervise  # plugins for delegated execution
```

Tack flags (`--profile`, `--patch`, `--model` for `run`) come first; the first
unrecognised token starts the app's own arguments, which are forwarded
verbatim (`tack run --help`, `tack web --port 0 --no-open`).

## Plugins

A Tack plugin is an npm package that declares a bundle layer and, optionally,
the Tack versions it supports:

```json
{
  "keywords": ["tack-plugin"],
  "tack": { "compat": ">=0.2.0 <1.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`examples/plugin-echo` is a complete one-tool plugin. Tack bundles its own
package manager for plugin installs; nothing else needs to be on `PATH`.

## Subagents (Claude Code and Codex)

Claude Code is DeepSeek Harness's own plugin,
`@deepseek-ai/dsh-subagent-claude-code`, pinned to the same runtime version as
the rest of DSH. Codex is Tack's `@tack/codex`: a provider that speaks the
official `codex app-server` protocol to the current Codex release it depends
on, behind DSH's own subagent tool. It replaces
`@deepseek-ai/dsh-subagent-codex`, which pins an old Codex client that current
ChatGPT-account models refuse and reports failures only as categories.
`@tack/codex` passes Codex's own error message, error code and model through,
and supports an output schema. Tack puts both on every profile and loads each
package's own `cordis.patch.yml`; existing profiles move from the DSH plugin
to `@tack/codex` when they next load.

The plugins register `subagent_claude_code` (provider `claude-code`) and
`subagent_codex` (provider `codex`). A call starts the child and returns its
id; the runtime delivers the result back to the parent. Tack's
`@tack/subagents` layer, on every profile after the providers, sets two
things. Claude Code runs in `auto` mode: the provider's own default, `dontAsk`,
denies every permission prompt, so a child could neither write a file nor run
a command; `auto` hands each request to Claude Code's permission classifier,
and the child's own user and project settings (hooks included) still apply.
And while an agent has a subagent or a background job running, a shell
`sleep` is refused with the way to wait: end the turn (the completion notice
opens the next one, and a headless run stays up until its children finish) or
`job_output` with `wait: true`. The `supervise`
profile cannot edit files or run commands itself, and it hands that work to
one of those tools.

```sh
tack run --profile supervise "npm test fails; get it passing"
```

A research session (`tack web --profile research`) uses the same subagent
tools for its workers, plus the in-process `subagent`.

## Research (Molab)

`tack web --profile research` works on research bound to one Molab scope.
Start `molab serve` at the node the work belongs to (a project, experiment or
run); that node is the scope, and molab refuses anything above it.

```sh
molab serve ~/lab/projects/polymer --port 8000   # the bound scope
MOLAB_URL=http://localhost:8000 tack web --profile research
```

New sessions start in the **Research** preset. `@tack/research` registers
plain Molab tools and nothing else; everything around them is DeepSeek
Harness's own:

| Need | Tool | Owner |
| --- | --- | --- |
| Read what exists (projects, experiments, workflows, recent/failed/running runs, assets, knowledge), each entry with the `molab:` ref the tools take; `query` searches knowledge; `section`, `offset`, `limit` page it | `molab_context` | `@tack/research` |
| Preview a workflow without executing: waves, branches, declared runs (`source: stored` inspects saved IR and historical inventory) | `molab_dry_run` | `@tack/research` |
| Create an experiment or a run | `molab_create_experiment`, `molab_create_run` | `@tack/research` |
| Start one attempt of a run, after the person approves it | `molab_start_execution` | `@tack/research` over DSH approval |
| Cancel an attempt | `molab_cancel_execution` | `@tack/research` |
| Read an attempt's results, assets, evidence and logs, paged | `molab_read_outputs` | `@tack/research` |
| Write a `Note`, `Literature`, `Report`, `Finding`, `Plan`, `Observation` or `Hypothesis` with its sources; the same name under the same host rewrites it in place | `molab_write_knowledge` | `@tack/research` |
| Delete a document written in error (molab's history keeps it) | `molab_delete_knowledge` | `@tack/research` |
| Ask the person a question | `ask_user_question` | DSH |
| Hand work to a worker | `subagent`, `subagent_claude_code`, `subagent_codex` | DSH, `@tack/codex` |
| Come back when compute should be done | `schedule_create` | DSH |
| Look at a chart or a structure during the session | `molplot_chart`, `molplot_serve`, `molvis_stage`, `molvis_sketch` | `@tack/molplot`, `@tack/molvis` |

**Approval before compute.** `molab_start_execution` first dry-runs the
experiment's current workflow source, then asks the person through DSH's
approval seam (`ctx.approval`, `@deepseek-ai/dsh-user-approval`) with a
request that names the run, the mode, the target and the dry run's waves and
runs. Only a one-shot `allowed-once` starts the attempt; a rejection, a
withdrawn request, a missing approval service or an absent answerer starts
nothing. Every request and outcome is audited in the session log. In the web
profile the browser answers; a headless `tack run` has no answerer, so it
fails closed there, as it does under the `never` approval policy.

**Waiting on compute.** The Research preset mounts DSH's schedule tools: after
starting an attempt the agent schedules its own check, and the web host's
schedule service delivers it back to the same session, across restarts. Tack
polls nothing and writes no wait record.

**Records.** A knowledge document's sources are `molab:` refs (an execution is
cited as its run), URLs or DOIs, and workspace files; other knowledge document
paths become `cites` edges. A `Report` or `Finding` cites at least one
`molab:` ref, its body is Markdown molab renders (no HTML page), and nothing
links a page served from this machine: the MolPlot and MolVis pages are for
looking during the session.

`tack run --profile research-run` mounts the same tools and persona on the
headless stack for reading and recording; it cannot start compute (no
answerer) or schedule a check (no schedule service).

`MOLAB_TOKEN` carries a bearer token when molab runs with `--auth`. The
`tack-research` row config sets `molab.url`, `molab.tokenEnv` and
`createdBy` (the author recorded on molab writes). `MOLPLOT_PYTHON` selects
the MolPlot interpreter; `doctor` checks that the viewer tools register.

## Runtime updates

The runtime is pinned to one exact version, set by hand. To move to a new
release (Node 22.18 or newer runs the TypeScript scripts directly):

1. Set every `@deepseek-ai/*` pin in the runtime and plugin package manifests
   to the same exact version; the isolation test rejects ranges and mixed versions.
2. `npm install`
3. `node scripts/runtime-closure.ts diff` lists new and removed runtime
   packages; review them and record the decisions with
   `node scripts/runtime-closure.ts write` (check its output before committing).
4. `npm run lint && npm run typecheck && npm test`

Every runtime package Tack installs is reviewed in `packages/tack/runtime-closure.json`
(source group, class, and decision: use, compose, disable, or forbidden).
A new upstream package fails verification until it is classified. The web shell
and its plugins are used as published, with Tack's browser extensions composed
through their public slots. Experimental packages are not installed.
DeepSeek's account, telemetry, and feedback rows stay disabled. Installed
package files are not patched.

The pin is one version for every `@deepseek-ai/*` package. Use the version of
`@deepseek-ai/dsh` on the npm `latest` tag (currently `0.2.1-rc.5`). The
`latest` tag on individual packages is stale and is not the runtime version.
`0.2.2-alpha.3` is the `alpha` tag, not this pin.

## Environment

| Variable | Meaning |
| --- | --- |
| `TACK_HOME` | Tack home; profiles, sessions, and settings live here. Default `~/.tack`. |
| `DEEPSEEK_API_KEY` | Key for the default provider (DeepSeek). Other providers use their own names, e.g. `ANTHROPIC_API_KEY`; `tack auth set` stores them in `$TACK_HOME`. |
| `DEEPSEEK_BASE_URL` | Optional provider base URL. |

A `.env` file in the working directory or in `$TACK_HOME` is also read.
