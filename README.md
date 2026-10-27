# dsh-at-file-everything

Everything-index search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Windows, through `es.exe`: instant `@file` completion for a human, and a `find_files` tool for the model — both answered from the same [Everything](https://www.voidtools.com/) index.

> 中文说明见 [README.zh.md](README.zh.md)。

## Why

Two callers need to find files, and neither is served well by walking the tree.

**The human typing `@`.** The shipped `@deepseek-ai/dsh-file-reference-local` provider answers from a workspace walk it performs itself, bounded by `maxEntries`. In a large tree that walk is both slow and lossy. On the Unity project this plugin was written for:

| | upstream walk | this plugin |
|---|---|---|
| what it searches | every file under the workspace root | Everything's index, scoped with `-path` |
| entry budget | `maxEntries` (50 000 by default) | none |
| first `@` of a session | full traversal | ~80 ms |
| warm query | re-ranks a bounded index | ~70–80 ms |
| coverage | ~469 k of ~1.5 M files, after tuning | the whole scope |
| heap | ~99 MB for the index | none held by the provider |

A concrete failure the upstream budget caused: ~1.2 M files under `Library/` and ~270 k under `Output/` exhausted the index before any `Assets/` source was reached, so `@PlayablePrefab` answered `Library/*` noise while the real file was missing.

**The model resolving a path.** It has `glob` and the shell, and both walk the tree with the same budget problem. `find_files` answers from the index instead — the same lookup that makes `@` fast, exposed where the agent can call it.

Everything already maintains that index machine-wide as a Windows service, so both surfaces answer from it and walk nothing.

## The `find_files` tool

| Parameter | Meaning |
|---|---|
| `query` | File or folder name, or any contiguous fragment of one. Case-insensitive. `*` or omitted means "everything in scope". |
| `path` | Absolute folder to confine the search to, including subfolders. Omitted searches every indexed drive. |
| `foldersOnly` / `filesOnly` | Restrict the kind of entry returned. |
| `limit` | Page size (default 50, at most 500). |

The tool returns absolute paths, one per line, and says how the page relates to the match set:

```
2 match(es) under Y:\pm-devs:
Y:\pm-devs\Assets\Scripts\Behaviour.Editor\
Y:\pm-devs\Assets\Scripts\Deep.ts
(more than 2 matched; raise `limit`, or narrow `query`/`path`)
```

That last line matters: without it a truncated page reads as a complete answer and the model reports a file as missing. A full page is the only thing that sets it, so a short page is a real "these are all of them".

**It is deliberately not scoped to the workspace.** The `@` provider confines itself to one working directory because a completion box must never surface a file from a sibling checkout the user cannot see. A model asked to find a file has the opposite need: on a machine holding several copies of one project, confining it would make the tool answer the wrong copy or nothing. It returns absolute paths and lets the model decide what to read.

It shares the `esClient` adapter with the provider but not its ranking: the provider ranks for human keystrokes and returns relative paths; the tool returns every match it was asked for, in absolute form. Each answers its own caller rather than compromising on one.

The tool is registered only where a `tools` service exists, so a composition without one still gets `@` completion.

### Nothing to configure

A tool description alone does not make a model use a tool. It sees `glob`, `grep`
and `find_files` side by side and picks by habit — which in practice means `glob`,
the one that walks the tree and gives up. So the plugin also contributes a system
prompt section that states **which of the three answers which question**: use
`find_files` to locate a file by name (especially outside the workspace or inside
ignored trees), `glob` for a path pattern that must respect ignore rules, `grep`
for contents.

That section is installed whenever the tool is registered, with **no setting of
its own**. There is nothing for a user to turn on: a user who has never heard of
the tool still gets a model that knows to call it. It sits immediately before the
host's own `glob` guidance, so the two read as one decision rather than as
unrelated capabilities.

`installPrompt` still exists, but it governs only the `@path` reference section —
turning it off does not hide the tool from the model.

## Install

```powershell
# once per machine
winget install voidtools.Everything

# once per profile
dsh plugin --profile <profile> add dsh-at-file-everything
```

`es.exe` is **not** a separate prerequisite: the package ships a pinned copy in
`bin/`, used whenever the machine has no client of its own. If you prefer your
own ES (it tracks your Everything build) install it and leave it on `PATH`; a
working `es.exe` on `PATH` always outranks the bundled one.

```powershell
# optional: use your own client instead of the bundled copy
winget install voidtools.Everything.Cli
```

The bundled `cordis.patch.yml` then:

1. inserts the `file-reference-everything` row (this plugin), and
2. disables `file-reference-local`, so exactly one owner provides `ctx.fileReferences`.

Restart the Harness profile afterwards. Nothing else in the composition changes: the Session Controller's `fileReferences/list` Remote and the Web composer keep resolving the same service.

The published tarball ships the built `lib/`, so there is nothing to compile first.

### From a local checkout

While developing, install this repository directly instead:

```powershell
dsh plugin --profile <profile> add link:<path to this repository>
```

> **Updating a `link:` install.** Under this profile's pnpm settings a `link:` dependency is materialised as a *copy*, not a symlink, so rebuilding `lib/` is not enough — the installed copy keeps serving the old bundle until you re-run `dsh plugin --profile <profile> add link:<path>` (or delete `<profile>/node_modules/dsh-at-file-everything` and re-add it). This bites during development: the plugin can look like it ignored a change.

## Requirements

- **Windows.** The plugin declares `os: win32`; on other platforms Everything does not exist and the plugin has nothing to answer from.
- **Everything running and indexing.** The plugin queries it; it does not bundle or start it.

Check the environment before blaming the plugin:

```powershell
es -get-everything-version   # the Everything service answering
es -version                  # the command-line client
```

### Where `es.exe` comes from

Everything and its command-line client are **two separate downloads**: the
service and its index are one installer, `es.exe` is another. A machine that has
run Everything for years very often has no client at all, so the plugin resolves
one rather than assuming it:

1. `esCommand`, when it names an absolute path — an explicit answer always wins.
2. A bare `esCommand` (default `es.exe`) through `extraPathDirectories`, then `PATH`.
3. The bundled `bin/es.exe`.

A candidate that exists but cannot be spawned falls through to the next one, so a
configured path that has since been uninstalled costs one failed launch rather
than a dead completion list. The card reports both the effective path and the
rest of the chain, so this fallthrough is visible rather than silent.

**The bundled copy is a fallback, not an override.** Its place *after* `PATH` is
deliberate: a user who installed ES should get their own client, which is the one
matched to their Everything build. The bundled copy exists for the machine that
has the service and no client.

It is pinned to **ES 1.1.0.34**, which is not the newest release. From 1.1.0.35
on, `-n` is applied as a `count:` filter, and against Everything 1.4 that costs
~300 ms per query before the first row returns — every keystroke pays it. The
measured table and the reasoning are in [`bin/README.md`](bin/README.md);
1.1.0.34 is the last release that keeps `-n` cheap while still supporting `--`,
`-get-result-count`, and Everything 1.5's IPC3.

That measured difference is measured *on this plugin's argument vector*, so it is
worth re-running if you change which switches are emitted.

If a deployment wants a specific client — an offline image, a locked-down
machine — point `esCommand` at it; an explicit path always wins:

```yaml
    esCommand: 'C:\Program Files\MyImage\tools\es.exe'
```

`es.exe` itself is MIT-licensed, so vendoring is permitted; the notice travels
with the binary in `bin/LICENSE-ES.txt`.

## Configuration

**Settings → Plugins → `dsh-at-file-everything`** shows this bundle's card, next
to the other bundles' pages.

| Control | Field | Default | Meaning |
|---|---|---|---|
| **es.exe path** | `esCommand` | empty | Empty auto-detects. Fill in an absolute path to pin one client. |
| **Exclude folders** | `excludeInQuery` | empty | Folder names or patterns, pruned inside the Everything query. |
| **Exclude files** | `excludeFilePatterns` | empty | File names or patterns, also pruned inside the query. |
| **Exclude from results only** | `excludedDirectories` | empty | Folder names or patterns filtered out of the returned rows. Free at query time, but those rows already consumed the budget. |

### Why the card must also be claimed on the Host

A browser card alone is not enough. The Plugins page asks the Host whether the
namespace still wants its page auto-generated:

```js
const autoGenerate = presentations.get(fiber)?.auto ?? true
```

The default is `true`, so a plugin that only registers a slot in
`plugins.bundle.config` gets a **generic form built from its Config schema**, and
its own card is never drawn. With a volatile-only schema that generic form has
nothing useful to render, which is how a blank-looking page happens.

So the Host half claims the page explicitly, exactly as every first-party plugin
with a custom page does:

```ts
ctx.inject(['settings'], (scope) => {
  scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
})
```

Three consequences worth remembering:

- **Claim it only if the card actually exists.** With `auto: false` and no
  registered card the page is empty — worse than the generic form. That is why the
  browser half now registers on both slots unconditionally, wraps each in
  `try`/`catch`, and does not bail out when `configForms` is unreachable; the card
  renders its own "not available" notice instead.
- **The slot key is the package name**, while the *settings namespace* is the
  Loader entry id (`file-reference-everything` here). Both strings are needed:
  `plugins.bundle.config` matches the page's inventory by package name, and
  `configForms.get()` takes the entry id.
- **`ctx.locale.bind(ns)` returns a lookup function, not a copy table.** It answers
  `t('some.key')`; reading its result as `{ label, hint }` yields `undefined` for
  every caption while data-driven inputs still render — a card of empty boxes that
  reads like a layout bug. This plugin therefore keeps its copy as a literal table
  in `src/client.ts` and asks the locale service only *which language* to use.
  `test/render.test.js` expands the component the way React does and fails when any
  caption goes missing, which is the check that would have caught it.

### Writing an exclusion

Type the **name or the pattern**, not Everything syntax:

```
Exclude folders   [ Library        ]
                  [ Lib*           ]
                  [ Temp?          ]

Exclude files     [ *.meta         ]
                  [ Thumbs.db      ]
```

- **No leading `!`.** The plugin builds the query term itself. A pasted `!Library` is accepted and the marker stripped, so copying from an Everything query does not produce an error.
- **`*` and `?` work in both lists.** `Lib*` is a prefix; `Temp?` is one character. Everything else is literal — a folder named `a+b` matches `a+b`, not `aab`.
- **Folders prune their contents; files are excluded by name.** Entering `Library` hides the folder *and* everything under it while keeping `Library.txt`, because the two lists emit different query terms.

The reasoning behind the last point is in the query-syntax table below; the short version is that Everything parses a folder exclusion and a file exclusion differently, so one merged list would mean guessing which the user meant.

### The path field

The field shows the path **actually in effect** as its placeholder, and the line
underneath names which tier supplied it:

```
es.exe path   [ (empty)                                    ] [ Re-check ]

Now using: C:\Program Files\Everything\es.exe (system PATH)
Client version 1.1.0.34
```

The version line comes from `es.exe -version`, which needs neither Everything nor
its service, so it still answers when the index does not. It is worth showing next
to the path because those are two different facts: the path says *which* client
runs, the version says *how old* it is — and a build that predates a switch
explains behaviour the path cannot. On this machine `PATH` holds 1.1.0.26 while the
bundled fallback is 1.1.0.34, so the line immediately answers "which one am I
actually getting".

The line is set in a monospace face once a path is known, because it is the one
runtime fact on the card and something users copy. Three outcomes are kept
distinct — *still checking*, *could not ask the Host*, and *nothing detected* —
because only the last one means ES needs installing; a route that never answered is
a different problem, and the line says so instead of blaming the install.

That line is the point of the control. "Your own install" and "the copy we
shipped" are **not** interchangeable — the bundled client is pinned to one
release, and a machine whose Everything upgrades may want its own client instead.
A bare path in a text box cannot say which one is running, so the card asks the
host, which owns the resolution chain and the filesystem.

It also reports the awkward states honestly:

- **Nothing detected** — "No es.exe detected: install Everything's ES, or fill in a
  path above." This is a different problem from "Everything is not running", and
  the message says which.
- **The Host could not be asked** — the status route did not answer, so the card
  says that instead of claiming nothing was found.
- **A pinned path that no longer exists** — the chain falls through and the line
  says so: `That path does not exist; currently falling back to … (bundled copy)`.
  The alternative is a field showing one path while a different one runs.

Leaving the field empty is how you keep auto-detection; it stores the bare
default `es.exe` rather than writing a path you never chose. **Re-check** re-runs
detection without saving — useful after editing `PATH` or installing ES. A save
also re-checks, so the line never lags behind the configuration.

The route is registered through `inject(['webServer'])` rather than probed once
with `ctx.get`. A Web server provided after this plugin loads would otherwise never
see the route, and the card would sit on "could not ask the Host" forever — which
is exactly the failure this control is meant to rule out.

There is no file-picker button. The host's picker chooses a **directory**, not a
file (`directoryPicker` exposes `pick` and listing primitives over directories),
so a wrong pick would mean guessing that `<dir>\es.exe` is the client. Typing or
pasting the path is one step and cannot guess wrong.

### The exclusion lists

The card explains the trade-off inline, because it is not obvious from the field
names: query-level exclusion is what keeps a real match behind a huge `Library/`
findable, and it costs a few milliseconds per query; row-level exclusion is free
but cannot recover budget already spent.

Both query-level lists accept **one entry per line**. A folder entry is embedded as
`!path:*\<pattern>\*`, which prunes the folder and its contents while leaving
`Library.txt` and `LibraryBeta` alone; a file entry is embedded as `!<pattern>`.
Only a path separator or an Everything operator is refused — `*` and `?` are the
point.

The rest of the configuration stays in the profile patch, since it is set once
and not tuned per project:

```yaml
- id: file-reference-everything
  name: dsh-at-file-everything
  config:
    esCommand: es.exe
    maxResults: 20
    maxCandidates: 300
    timeoutMs: 10000
    deadlineMs: 25000
    fuzzyFallback: true
    excludeInQuery: []
    excludeFilePatterns: []
    excludedDirectories: []
    extraPathDirectories: []
    installPrompt: true
```

| Field | Default | Meaning |
|---|---|---|
| `esCommand` | `es.exe` | Absolute path, or a bare name resolved through `extraPathDirectories` then `PATH`. The bundled `bin/es.exe` answers when neither finds one. |
| `maxResults` | `20` | Ranked candidates returned for one query. |
| `maxCandidates` | `300` | Rows requested from Everything before ranking. Raising this costs roughly linearly (measured ≈ +0.3 ms/row on a 470 k-entry tree). |
| `timeoutMs` | `10000` | How long `es.exe` waits for the Everything database to load (`-timeout`). Raise it on a cold, large index. |
| `deadlineMs` | `25000` | Deadline for one `es.exe` invocation, including process start. Must exceed `timeoutMs`; a timeout degrades to an empty completion list, never to an error in the composer. |
| `fuzzyFallback` | `true` | When a contiguous search matches nothing, retry as a subsequence (`pbin` → `PlayButton`). |
| `extraPathDirectories` | `[]` | Searched for a bare `esCommand` before `PATH`, for a portable Everything install. |
| `installPrompt` | `true` | Contribute the seam's `@path` guidance while the agent can call `read`. |

`timeoutMs` and `deadlineMs` are separate on purpose. `timeoutMs` is handed to
`es.exe` as its own wait for the database; `deadlineMs` is when this process kills
the child. One shared value would have to cover a cold-index load, so a healthy
query would be killed at the same moment the client gave up — and the failure
would read as a timeout rather than "the index was still loading".

### Why the lists are empty by default

What should be hidden is a property of the project, not of the plugin. A Unity
tree wants `Library` and `Output`, a Rust one `target`, a monorepo neither — and a
shipped default silently hides real sources on the first two while doing nothing
useful on the third. The card is where this is decided.

### Why two query-level lists instead of one

Everything parses the two differently. A folder is named by its exact path
segment (`!\Library\`), while a file is named by a pattern (`!*.meta`). There are
also two other spellings that look right and are not:

| Term | What it actually does |
|---|---|
| `!path:Library` | Matches the *string* anywhere in the path, so it also drops `Library.txt` and `LibraryBeta`. |
| `!folder:Library` | Matches the folder row but **not** its contents, so the subtree stays. |
| `!\Library\` | Prunes the folder and its contents, and `Library.txt` survives — but a *pattern* cannot go here: `!\Lib*\` matches nothing. |
| `!path:*\Lib*\*` | Prunes any folder whose name matches the pattern, contents included. This is what the card writes. |

The last row is why the card can accept a plain `Lib*`: the leading `*` lets the
segment match at any depth, and the trailing `\*` is what actually reaches the
contents. A `?` inside a path segment behaves inconsistently in Everything, so the
card's help text points at `*` rather than promising more.

If you want a Unity recipe to start from:

```yaml
    excludeInQuery: [Library, Output]
    excludeFilePatterns: ['*.meta']
```

Measured cost of the query-level terms: 56 ms with none, 83 ms with one, 115 ms
with two on a 470 k-entry tree (client 1.1.0.26). Keep the fattest two or three.

## Behaviour

`@` opens completion; typing filters; picking inserts an ordinary `@path` mention. A directory candidate keeps the quote open with a trailing slash so completion can descend another level. Selecting a file never reads its contents — the model still has to call `read`.

- **Bare query** (`@Archive`) searches the whole working directory.
- **Directory query** (`@Assets/Scripts/`) lists that one directory, one cheap lookup per level. The fragment after the last `/` is sent to Everything as a term, so a directory holding more children than `maxCandidates` still answers correctly — filtering the page afterwards would lose every entry whose name sorts past the cap.
- **Exclusion** is decided by the card: `excludeInQuery` and `excludeFilePatterns` prune inside the query, `excludedDirectories` filters the returned rows. All three are empty until configured.
- **Hidden entries** stay out of results until the query itself starts with `.`.
- **Scoped to the working directory.** A bare query carries `-path <cwd>` and every result is re-checked against the root before it is rendered, so nothing outside the workspace can appear. Directory descent is guarded too: `@../sibling/` or `@D:\elsewhere\` resolves outside the root and answers nothing rather than listing another tree. This matters on machines that hold several copies of the same project — one workspace can never surface or select a file from another.
- **A down Everything is reported, not disguised.** ES exit code 8 means the service is not running; that is logged as its own cause, because an empty `@` list would otherwise look like "no such file" when the index is complete and merely unanswered.

Ranking reproduces the upstream tiers exactly, so switching providers does not change which file a keystroke sequence selects: exact basename > prefix > substring > directory-segment > subsequence, directories before files at equal scores, then shorter paths, then code-unit order.

## How it works

Six properties of `es.exe`, each established by probing the real client, shape the implementation:

1. **Every argv element is an independent AND-ed term.** A single argument containing spaces (`"package json"`) matches nothing, while `package` and `json` match `package.json`. Terms are never space-joined, and a literal space inside a pattern becomes `?`.
2. **Everything indexes file names by default; `-p` widens a term to the full path.** Filename matching is also the fast path: the wildcard form answers in ~70–150 ms on a 470 k-entry workspace, whereas a `regex:` term over the full path costs 0.6–44 s because it scans the whole index. Queries therefore stay filename-scoped, and `-path` supplies the scoping.
3. **Standard output is not UTF-8.** `es.exe` writes results in the process ANSI/OEM code page, so CJK and kana names arrive as mojibake on a zh-CN host. The only code-page-independent channel is `-export-csv <file>` with `-utf8-bom`, which writes real UTF-8 to a file the plugin owns. It costs about as much as stdout (~110 ms vs ~100 ms), so every query takes it.
4. **The exported CSV column order is not what the arguments suggest.** `-csv -attributes` writes `Filename,Attributes` — filename first — so a parser that reads by position swaps every path for an attribute string and returns nonsense without failing. The parser locates columns by the header line instead.
5. **`Attributes` is a decimal bitmask, not a letter.** A directory exports as `16` (`FILE_ATTRIBUTE_DIRECTORY`), an ordinary file as `32`. Testing for the letter `D` (which the documentation implies) classifies *every* row as a file, and completion then renders no trailing slash on any directory.
6. **The client version decides what a switch costs.** `-n` is a page limit up to 1.1.0.34 and a `count:` filter from 1.1.0.35 on, which costs ~300 ms per query against Everything 1.4. This is why the bundled client is pinned rather than tracking newest; see [`bin/README.md`](bin/README.md).

Directory-versus-file comes from the exported `Attributes` column (the `0x10` bit), avoiding a second filesystem round trip.

## Verify

```powershell
npm run typecheck        # strict TS over src/
npm run test             # unit + live es.exe integration
npm run verify:activate  # load the plugin the way the host does
```

The unit suite runs anywhere. The live suite creates a fixture under `%TEMP%`,
waits for Everything to index it, and checks directory classification, root
scoping, UTF-8 decoding of CJK names, spaced names, the subsequence tier, empty
results, cancellation, in-query exclusion, and — the regression it guards — that a
directory entry sorting past a small `-n` page is still found.

`test/` is deliberately independent of the Harness installation; the pure helpers
live in `src/pure.ts` and build to `lib/pure.js`, and configuration validation
lives in `src/config.ts` and builds to `lib/config.js`, for that reason.

`verify:activate` is the one check that needs the real installation: it imports
`schemastery` from the installed profile, applies the schema, and calls `apply`
with the resulting configuration. That is worth doing because of the next
paragraph.

### The `volatile` trap

Every field of this plugin's `Config` is `volatile`, for two reasons: the Harness
serves a settings form **only** for volatile fields (a plain config means the
plugin has no card at all), and a volatile field is what lets a card edit apply
without remounting the plugin.

The consequence is easy to get wrong: `apply` does **not** receive values. Each
volatile field arrives as `Object.freeze({ get })`. Code that reads
`config.maxResults` and compares it to a number sees an object, concludes the
config is invalid, and throws during activation — the whole bundle then fails to
load with *"1 entry did not activate"*, while every unit test that passed a plain
object still passes.

So the rule this codebase follows:

- read every field through `currentValue()` (`src/config.ts`), which unwraps a
  handle and passes a plain value through;
- **validate** the unwrapped values, but **return the handles** — normalising into
  a plain copy would pin the first value forever and quietly make the
  configuration read-only;
- test the handle shape, not just plain objects (`test/config.test.js` does).

## Package layout

```
src/index.ts      plugin, service class, config schema
src/config.ts     config shape, defaults, validation (no Harness imports)
src/es-client.ts  es.exe adapter: spawn, export, decode, timeouts
src/resolve.ts    es.exe resolution chain (configured → PATH → bundled)
src/status.ts     host route: which es.exe is in effect, and from where
src/tool.ts       the find_files model tool
src/client.ts     browser half: the configuration card on the Plugins page
src/candidates.ts pure ranking and path normalisation
src/pure.ts       Harness-free entry for tests and reuse
bin/es.exe        pinned Everything CLI, used when nothing else answers
bin/README.md     why that exact version; the measured version table
cordis.patch.yml  bundle layer: insert this row, disable file-reference-local
assets/           storefront icon and its licence record
scripts/make-icon.py  renders assets/icon-{180,256,512}.png from icon-256.png
```

`@deepseek-ai/*` imports stay external in the bundle: the host resolves those from the installation, and inlining them would give this plugin a second Cordis `Service` class identity.

`lib/tool.js` is also a separate entry, so the suite can drive the tool definition with a stubbed `dsh-tools` instead of a Harness installation.

`lib/client.cjs.js` is not an ES module. The Web shell evaluates it as a script and
expects it to register a lazy CommonJS factory on `window.__ModuleLoader__`, so it
is built as CJS with `react` external (a bundled React would be a second copy and
would break every hook). It deliberately does **not** import
`@deepseek-ai/dsh-client-ui-primitives`: those reach `*.module.css` and further
DSH packages, which would make the card unmountable in the Node test suite. The
controls are written by hand against `--dsw-alias-*` theme tokens instead, which
is also what the host's own plugin-authoring guidance recommends.

**Always give a `var()` a fallback, and only use token names the themes define.**
An unresolvable `var()` with no fallback invalidates the whole declaration, so
`border: 1px solid var(--dsw-alias-border-secondary)` — a name that does not
exist — silently became `border: none` and the card rendered its inputs as loose
text. The names in use here were checked against the deployment (`bg-l1`,
`border-l1`, `border-l2`, `label-primary`, `label-tertiary`,
`state-error-primary`, `settings-card-fill`), and `scripts/verify-card-style.mjs`
enumerates every token the rendered tree references so a rename shows up as a
failure rather than as a missing border.

## Icon

`assets/icon-{180,256,512}.png` is voidtools' Everything magnifying-glass icon.
Everything — icon included — is MIT-licensed (Copyright (c) 2022 voidtools), so
reuse is permitted as long as the notice travels with the asset; it does, in
[assets/ICON-LICENSE.txt](assets/ICON-LICENSE.txt). Re-render the sizes with:

```powershell
python scripts/make-icon.py
```

Storefronts (the awesome-dsh-plugin list, dsh-market) pick it up from the
catalog entry:

```yaml
icon: https://raw.githubusercontent.com/backkom/dsh-at-file-everything/master/assets/icon-180.png
```

That list only accepts icons hosted on GitHub as `png`/`jpg`/`jpeg`/`webp`, and
draws the tile at ~96px, so a square raster is the shape that works. The default
branch here is `master`; if it is ever renamed, that URL has to change with it.

## Limitations

- **Windows only**, and only as good as the Everything index. Files excluded from indexing are invisible here too — to `find_files` as well as to `@`.
- **Everything must be running.** If the service is down the plugin logs that specific cause, completion answers nothing, and `find_files` raises an error naming the cause and pointing at `glob`. The bundled `es.exe` supplies the *client*, not the service, so it cannot help here.
- **The bundled client is pinned.** It is chosen for Everything 1.4 latency (see `bin/README.md`). On a future Everything whose `count:` filter is cheap, a newer client would be the better pin; a user-supplied `es.exe` on `PATH` or in `esCommand` always takes precedence, so this only affects machines relying on the fallback.
- **Filename-scoped search.** Typing a directory path with `/` lists that directory, but a bare query will not match deep path fragments that no file name contains — the upstream substring path match was traded for the ~30× latency of the index path. `find_files` searches names only, so the same applies.
- **`find_files` pages, it does not stream.** One call returns at most 500 entries; past that the model must narrow the query or page by raising `limit`. The result says so.
- **One `es.exe` process per query.** Each query is a fresh process (~70–80 ms warm). Cancellation kills it.
- **First query after Everything's index is cold** can take ~1 s as the service pages the index in; `timeoutMs` covers that wait, `deadlineMs` covers the process.

## Licence

MIT. See [LICENSE](LICENSE).

`bin/es.exe` is [voidtools ES](https://github.com/voidtools/ES), MIT, Copyright (c) 2025 voidtools; see [`bin/LICENSE-ES.txt`](bin/LICENSE-ES.txt).
