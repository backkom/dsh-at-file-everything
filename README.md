# dsh-at-file-everything

Instant `@file` completion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Windows, answered from the [Everything](https://www.voidtools.com/) search index through `es.exe`.

> 中文说明见 [README.zh.md](README.zh.md)。

## Why

The shipped `@deepseek-ai/dsh-file-reference-local` provider answers `@` from a workspace walk it performs itself, bounded by `maxEntries`. In a large tree that walk is both slow and lossy. On the Unity project this plugin was written for:

| | upstream walk | this plugin |
|---|---|---|
| what it searches | every file under the workspace root | Everything's index, scoped with `-path` |
| entry budget | `maxEntries` (50 000 by default) | none |
| first `@` of a session | full traversal | ~80 ms |
| warm query | re-ranks a bounded index | ~70–80 ms |
| coverage | ~469 k of ~1.5 M files, after tuning | the whole scope |
| heap | ~99 MB for the index | none held by the provider |

A concrete failure the upstream budget caused: ~1.2 M files under `Library/` and ~270 k under `Output/` exhausted the index before any `Assets/` source was reached, so `@PlayablePrefab` answered `Library/*` noise while the real file was missing. Everything already maintains that index machine-wide as a Windows service, so this provider answers from it and walks nothing.

## Install

```powershell
# once per machine (see "Why es.exe is not bundled" below)
winget install voidtools.Everything
winget install voidtools.Everything.Cli

# once per profile
dsh plugin --profile <profile> add dsh-at-file-everything
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
- **Everything 1.4+ running and indexing.** The plugin queries it; it does not bundle or start it.
- **`es.exe` v1.1.0+ on `PATH`**, or `esCommand` pointing at it.

Check the environment before blaming the plugin:

```powershell
es -get-everything-version   # the Everything service answering
es -version                  # the command-line client
```

### Why `es.exe` is not bundled

Bundling it does not make the plugin install-and-go, because `es.exe` is only the *client* half of Everything. It talks to the Everything service over its IPC window, and without that service it answers:

```
Error 8: Everything IPC window not found. Please make sure Everything is running.
```

So even with a copy vendored into this package, the user still has to install Everything, keep it running, and let it index the drives they care about — the part that actually makes `@file` work. A bundled client also silently drifts from the user's service, because Everything's IPC and index format are upgraded together with the service while a pinned client is frozen at release time.

The honest install story is therefore two commands, in this order:

```powershell
winget install voidtools.Everything          # the service and its index
winget install voidtools.Everything.Cli      # es.exe on PATH
```

If a deployment wants to vendor `es.exe` anyway — an offline image, a locked-down machine — point `esCommand` at the copy you shipped. An explicit `esCommand` always wins over `PATH`, and nothing else needs to change:

```yaml
    esCommand: 'C:\Program Files\MyImage\tools\es.exe'
```

`es.exe` itself is MIT-licensed (its `cli.c` carries the permission notice), so vendoring is permitted; it is simply not *sufficient*, which is why this package does not pretend otherwise.

## Configuration

```yaml
- id: file-reference-everything
  name: dsh-at-file-everything
  config:
    esCommand: es.exe
    maxResults: 20
    maxCandidates: 300
    timeoutMs: 3000
    fuzzyFallback: true
    excludedDirectories: [.git, node_modules, Library, Temp, Output]
    extraPathDirectories: []
    installPrompt: true
```

| Field | Default | Meaning |
|---|---|---|
| `esCommand` | `es.exe` | Executable name or absolute path. A bare name resolves through `PATH`. |
| `maxResults` | `20` | Ranked candidates returned for one query. |
| `maxCandidates` | `300` | Rows requested from Everything before ranking. Raising this costs roughly linearly (measured ≈ +0.3 ms/row on a 470 k-entry tree). |
| `timeoutMs` | `3000` | Per-`es.exe` deadline. A timeout degrades to an empty completion list, never to an error in the composer. |
| `fuzzyFallback` | `true` | When a contiguous search matches nothing, retry as a subsequence (`pbin` → `PlayButton`). |
| `excludedDirectories` | build/VCS defaults | Directory **basenames** filtered out of results. Case-insensitive. A *file* named `build` is not excluded. |
| `extraPathDirectories` | `[]` | Prepended to the child `PATH`, for a portable Everything install. |
| `installPrompt` | `true` | Contribute the seam's `@path` guidance while the agent can call `read`. |

For a Unity project, add the generated trees:

```yaml
    excludedDirectories:
      - .git
      - node_modules
      - Library
      - Temp
      - obj
      - Logs
      - UserSettings
      - Output
      - Publish
      - .vs
```

Keep `Export/` searchable if its build trees matter to you.

## Behaviour

`@` opens completion; typing filters; picking inserts an ordinary `@path` mention. A directory candidate keeps the quote open with a trailing slash so completion can descend another level. Selecting a file never reads its contents — the model still has to call `read`.

- **Bare query** (`@Archive`) searches the whole working directory.
- **Directory query** (`@Assets/Scripts/`) lists that one directory, one cheap lookup per level.
- **Exclusion** is a filter over returned rows, so excluded trees cost nothing at query time.
- **Hidden entries** stay out of results until the query itself starts with `.`.
- **Scoped to the working directory.** A bare query carries `-path <cwd>` and every result is re-checked against the root before it is rendered, so nothing outside the workspace can appear. Directory descent is guarded too: `@../sibling/` or `@D:\elsewhere\` resolves outside the root and answers nothing rather than listing another tree. This matters on machines that hold several copies of the same project — one workspace can never surface or select a file from another.

Ranking reproduces the upstream tiers exactly, so switching providers does not change which file a keystroke sequence selects: exact basename > prefix > substring > directory-segment > subsequence, directories before files at equal scores, then shorter paths, then code-unit order.

## How it works

Three properties of `es.exe`, each established by probing the real client, shape the implementation:

1. **Every argv element is an independent AND-ed term.** A single argument containing spaces (`"package json"`) matches nothing, while `package` and `json` match `package.json`. Terms are never space-joined, and a literal space inside a pattern becomes `?`.
2. **Everything indexes file names by default; `-p` widens a term to the full path.** Filename matching is also the fast path: the wildcard form answers in ~70–150 ms on a 470 k-entry workspace, whereas a `regex:` term over the full path costs 0.6–44 s because it scans the whole index. Queries therefore stay filename-scoped, and `-path` supplies the scoping.
3. **Standard output is not UTF-8.** `es.exe` writes results in the process ANSI/OEM code page, so CJK and kana names arrive as mojibake on a zh-CN host. The only code-page-independent channel is `-export-csv <file>` with `-utf8-bom`, which writes real UTF-8 to a file the plugin owns. It costs about as much as stdout (~110 ms vs ~100 ms), so every query takes it.

Directory-versus-file comes from the exported `Attributes` column (`D` = directory), avoiding a second filesystem round trip.

## Verify

```powershell
npm run typecheck   # strict TS over src/
npm run test        # unit + live es.exe integration
```

The unit suite runs anywhere. The live suite creates a fixture under `%TEMP%`, waits for Everything to index it, and checks directory classification, root scoping, UTF-8 decoding of CJK names, spaced names, the subsequence tier, empty results, and cancellation. It skips itself when `es.exe` is absent.

`test/` is deliberately independent of the Harness installation; the pure helpers live in `src/pure.ts` and build to `lib/pure.js` for that reason.

## Package layout

```
src/index.ts      plugin, service class, config schema
src/es-client.ts  es.exe adapter: spawn, export, decode, timeouts
src/candidates.ts pure ranking and path normalisation
src/pure.ts       Harness-free entry for tests and reuse
cordis.patch.yml  bundle layer: insert this row, disable file-reference-local
```

`@deepseek-ai/*` imports stay external in the bundle: the host resolves those from the installation, and inlining them would give this plugin a second Cordis `Service` class identity.

## Limitations

- **Windows only**, and only as good as the Everything index. Files excluded from indexing are invisible here too.
- **Everything must be running.** If the service is down the plugin logs a warning and completion answers nothing; `@` does not fall back to a filesystem walk.
- **Filename-scoped search.** Typing a directory path with `/` lists that directory, but a bare query will not match deep path fragments that no file name contains — the upstream substring path match was traded for the ~30× latency of the index path.
- **One `es.exe` process per keystroke.** Each query is a fresh process (~70–80 ms warm). Cancellation kills it.
- **First query after Everything's index is cold** can take ~1 s as the service pages the index in.

## Licence

MIT. See [LICENSE](LICENSE).
