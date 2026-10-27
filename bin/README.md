# Bundled `es.exe`

`bin/es.exe` is the [Everything](https://www.voidtools.com/) command-line client
(**ES**), redistributed here verbatim under its MIT licence
([`LICENSE-ES.txt`](LICENSE-ES.txt), Copyright (c) 2025 voidtools).

It exists because Everything and ES are **two separate downloads**. The
Everything service and its index are one installer; `es.exe` is another, so a
machine that has been running Everything for years very often has no client at
all — and without one there is nothing to query the index with.

## Why this exact version

Pinned to **1.1.0.34**, which is deliberately *not* the newest release. Measured
on a 470 k-entry Unity workspace against Everything 1.4.1.1022, same production
argument vector (`-path … -n 300 -csv -export-csv …`):

| ES version | median query | notes |
|---|---|---|
| 1.1.0.26 | 49 ms | no `--` terminator, no `-export-json` |
| 1.1.0.30 | 53 ms | ✓ `--` |
| 1.1.0.31a | 62 ms | |
| 1.1.0.32a | 59 ms | |
| **1.1.0.34** | **59 ms** | **bundled: last cheap release** |
| 1.1.0.35 | 373 ms | `-n` becomes a `count:` filter |
| 1.1.0.38 | 285 ms | |
| 1.1.1.39 | 275 ms | newest at the time of writing |

From 1.1.0.35 on, `-n` is implemented as a `count:` filter, and against
Everything **1.4** that costs roughly 300 ms *before the first row comes back* —
on a query whose results are a single page. Every keystroke pays it. 1.1.0.34 is
the last release that still answers `-path … -n …` from the index directly, while
already supporting the two switches this plugin depends on:

- `--` (the switch terminator, added in 1.1.0.28)
- `-get-result-count`, `-utf8-bom`, `-attributes`, `-timeout`, `-instance`

Versions before 1.1.0.28 reject `--` with `Error 6: Unknown switch` and cannot be
used at all. If a future Everything 1.5 makes the `count:` filter cheap, a newer
ES becomes the better pin and this table is what to re-measure.

## Resolution order

A bundled client never overrides a working one. `src/resolve.ts` tries, in order:

1. `esCommand`, when it names an absolute path.
2. A bare `esCommand` (default `es.exe`) through `extraPathDirectories`, then `PATH`.
3. `bin/es.exe`, i.e. this file.

So a machine with ES on `PATH` keeps using its own (matched to its Everything
build), and a machine with only the Everything service falls back here.
A candidate that exists but cannot be spawned falls through to the next one.

The whole chain is bounded by `deadlineMs`; a missing Everything service is
detected separately as ES exit code 8.
