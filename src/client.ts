/**
 * Configuration card for the `@file` Everything provider.
 *
 * Everything's own settings are not ours to change, but which trees a
 * completion should never show is a per-project decision — a Unity workspace
 * wants `Library` and `Output` pruned, a Rust one wants `target` — and no
 * default covers both. This card is where a user says so.
 *
 * ## What it edits
 *
 * Two lists, on purpose, because they cost different things:
 *
 * - **Query-level exclusion** goes into the Everything query itself, so those
 *   rows are never counted against the candidate budget. That is the only way a
 *   match hidden behind a huge generated tree is still found, and the reason
 *   this control exists. Each entry costs query latency.
 * - **Row-level exclusion** filters what came back. Free at query time, but the
 *   budget is already spent.
 *
 * ## Why the card is written by hand
 *
 * The Harness can generate a settings page from a plugin's `Config`, but only
 * for `volatile` scalar fields. A `string[]` has no generated control, and the
 * two lists need copy explaining their trade-off — so the controls are built
 * here from `react` and the `--dsw-alias-*` theme tokens, matching the host's
 * Plugin Manager rows. The primitives package is deliberately NOT imported: it
 * reaches `*.module.css` and further DSH packages, which would make this card
 * unmountable in the Node test suite that checks it.
 *
 * ## Why the write is read back
 *
 * `settingsScope.set()` resolving is not proof the value was stored: the profile
 * patch is written by an atomic replace, and on Windows an antivirus scanner or
 * sync client can hold it long enough that the attempt fails and the scope
 * merely reloads and returns. A save that silently did nothing would be worse
 * than no control, so every write is compared against what the scope reads back.
 *
 * @module dsh-at-file-everything/client
 */

import { createElement as h, useEffect, useMemo, useState } from 'react'

/** Stable browser-plugin name. */
export const name = 'dsh-at-file-everything'

/** Bilingual copy: one entry per locale the harness ships. */
interface Copy {
  pathLabel: string
  pathHint: string
  pathPlaceholder: string
  detected: string
  sourceLabels: Record<string, string>
  notFound: string
  probeFailed: string
  versionLabel: string
  recheck: string
  checking: string
  pinnedMissing: string
  title: string
  folderLabel: string
  folderHint: string
  folderPlaceholder: string
  fileLabel: string
  fileHint: string
  filePlaceholder: string
  rowsLabel: string
  rowsHint: string
  rowsPlaceholder: string
  save: string
  saving: string
  saved: string
  discard: string
  unavailable: string
  readOnly: string
  saveFailed: string
  invalidFolder: string
  invalidFile: string
  empty: string
}

/** The host's answer about which `es.exe` is in effect. */
interface EsStatus {
  candidates: Array<{ path: string; source: string }>
  effective?: string
  source?: string
  version?: string
  overridden: boolean
}

/** Where the card's status route lives. */
const STATUS_ROUTE = '/dsh-at-file-everything/api/es-status'

/** The settings scope snapshot this card renders from. */
interface ScopeSnapshot {
  status?: string
  writable?: boolean
  value?: Record<string, unknown>
}

/** The bound settings scope for one namespace. */
interface SettingsScope {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<unknown> | unknown
}

/** Props the slot hands the card. */
interface CardProps {
  t?: Copy
  settingsScope?: SettingsScope
  view?: string
}

/** One labelled textarea's props. */
interface NameListFieldProps {
  id: string
  label: string
  hint: string
  placeholder: string
  value: string
  disabled: boolean
  invalid: boolean
  /** Copy shown in place of the hint when the text is unusable. */
  invalidText: string
  onChange: (text: string) => void
}

/**
 * Services required before `apply` runs.
 *
 * A Cordis dependency gate is hard: an entry the running Harness does not
 * provide keeps `apply` from ever running. Both settings lines provide `slots`
 * and `locale`; the settings transport itself is probed with `ctx.get()`, which
 * answers `undefined` rather than throwing when it is absent, so one build
 * serves a deployment whose settings surface differs or is missing.
 */
export const inject = ['slots', 'locale']

/** Settings namespace and profile entry id. */
const NAMESPACE = 'dsh-at-file-everything'

/**
 * Every spelling the Host may have used for this bundle's settings namespace.
 *
 * `SettingsForms.describe()` keys a form by the **Loader entry id**, and the
 * profile patch picks that id — so the browser half has to ask rather than
 * assume. The entry in this bundle's own patch is `file-reference-everything`;
 * a deployment that installed the package under its bare name, or that wrapped
 * it with `include:`, spells it differently. Trying each in order is what keeps
 * the card bound on all three.
 */
const SETTINGS_NAMESPACE_CANDIDATES = ['file-reference-everything', NAMESPACE, 'include:file-reference-everything']

/** Card copy, in both languages the harness ships. */
const COPY: Record<'zh' | 'en', Copy> = {
  zh: {
    title: '排除的目录与文件',
    folderLabel: '排除文件夹',
    folderHint:
      '直接写文件夹名或通配符，例如 Library、Lib*、Temp?。不需要写 !，插件会自己拼成 Everything 的排除语法。这些文件夹连同内容一起在查询阶段被剪掉，不占候选配额——只有这样，藏在 Library/、Output/ 这类大目录后面的真实匹配才找得到。代价是每次查询多几毫秒，填最肥的两三个即可。',
    folderPlaceholder: '每行一个，例如 Library 或 Lib*',
    fileLabel: '排除文件',
    fileHint:
      '直接写文件名或通配符，例如 *.meta、*.pyc、*.g.dart、Thumbs.db。同样写进查询，也不占配额。',
    filePlaceholder: '每行一个，例如 *.meta',
    rowsLabel: '仅在结果里排除（不建议填）',
    rowsHint:
      '从返回结果里过滤，查询时零成本，但被丢掉的行已经消耗了 maxCandidates 配额。只在目录实在太多、不想让查询变慢时使用；优先用上面两项。',
    rowsPlaceholder: '每行一个，例如 obj 或 obj*',
    pathLabel: 'es.exe 路径',
    pathHint:
      '留空即自动探测：你配置的目录 → 系统 PATH → 随包副本。填入绝对路径可固定使用某一份。',
    pathPlaceholder: '自动探测',
    detected: '当前使用',
    sourceLabels: {
      configured: '手动指定',
      path: '系统 PATH',
      bundled: '随包副本',
    },
    notFound: '未检测到 es.exe：请安装 Everything 的 ES，或在上方手动填入路径。',
    probeFailed: '无法读取探测结果（宿主路由未响应）。若插件已启用仍如此，请手动填入路径。',
    versionLabel: 'es.exe版本',
    recheck: '重新检测',
    checking: '检测中…',
    pinnedMissing: '指定的路径不存在，当前回退到',
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    discard: '放弃修改',
    unavailable: '该插件当前未加载，或本部署未开放它的配置。',
    readOnly: '本部署的设置为只读。',
    saveFailed: '保存未被接受，改动已保留供你重试。',
    invalidFolder: '不能为空，也不能包含 \\ / " < > | & ^（* 和 ? 可用）',
    invalidFile: '不能为空，也不能包含 \\ / " < > | & ^（* 和 ? 可用）',
    empty: '当前没有排除项：索引里有的目录和文件都会出现在补全里。',
  },
  en: {
    pathLabel: 'es.exe path',
    pathHint:
      'Leave empty to auto-detect: your extra directories → system PATH → the bundled copy. Fill in an absolute path to pin one.',
    pathPlaceholder: 'Auto-detect',
    detected: 'Now using',
    sourceLabels: {
      configured: 'manually set',
      path: 'system PATH',
      bundled: 'bundled copy',
    },
    notFound: "No es.exe detected: install Everything's ES, or fill in a path above.",
    probeFailed: 'Could not read the detection result (the host route did not answer). If the plugin is enabled, fill in a path manually.',
    versionLabel: 'es.exe version',
    recheck: 'Re-check',
    checking: 'Checking…',
    pinnedMissing: 'That path does not exist; currently falling back to',
    title: 'Excluded folders and files',
    folderLabel: 'Exclude folders',
    folderHint:
      'Type a folder name or a wildcard: Library, Lib*, Temp?. No leading ! — the plugin builds the Everything syntax itself. These folders and their contents are pruned inside the query, so they never spend the candidate budget — the only way a real match behind a huge Library/ or Output/ is still found. Costs a few ms per query; list the two or three fattest.',
    folderPlaceholder: 'One per line, e.g. Library or Lib*',
    fileLabel: 'Exclude files',
    fileHint:
      'Type a file name or a wildcard: *.meta, *.pyc, *.g.dart, Thumbs.db. Also pruned inside the query, also free of the budget.',
    filePlaceholder: 'One per line, e.g. *.meta',
    rowsLabel: 'Exclude from results only (avoid)',
    rowsHint:
      'Filtered out of the returned rows. Free at query time, but those rows already consumed the maxCandidates budget. Use it only when there are too many folders to put in the query; prefer the two above.',
    rowsPlaceholder: 'One per line, e.g. obj or obj*',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    discard: 'Discard',
    unavailable: 'This plugin is not loaded, or this deployment exposes no configuration.',
    readOnly: 'This deployment is read-only.',
    saveFailed: 'The save was not accepted; your edits are kept so you can retry.',
    invalidFolder: 'Cannot be empty or contain \\ / " < > | & ^ (* and ? are allowed)',
    invalidFile: 'Cannot be empty or contain \\ / " < > | & ^ (* and ? are allowed)',
    empty: 'Nothing excluded: every indexed folder and file can appear in completion.',
  },
}

/** Folder-name patterns the host refuses, mirroring `normalizeConfig`. */
const INVALID_FOLDER = /[\\/"<>|&^]/

/** File-name patterns the host refuses: wildcards are allowed, separators are not. */
const INVALID_PATTERN = /[\\/"<>|&^]/

/**
 * Split a textarea's text into directory basenames.
 *
 * Blank lines are dropped rather than treated as an empty name, so a trailing
 * newline while typing is not an error. Surrounding whitespace is trimmed for
 * the same reason: a pasted list often carries it.
 *
 * @param text - the control's raw text.
 * @returns the basenames, or `undefined` when any line is unusable.
 */
export function parseNames(text: string, invalid: RegExp = INVALID_FOLDER): string[] | undefined {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    // Tolerate a pasted Everything term: the card asks for a bare pattern, but a
    // user copying `!Library` from a query should not be told it is invalid. The
    // plugin adds its own marker, so a leading `!` would otherwise be doubled.
    const name = line.trim().replace(/^!/, '').trim()
    if (name === '') continue
    if (invalid.test(name)) return undefined
    names.push(name)
  }
  return names
}

/**
 * Parse a file-name pattern list.
 *
 * Separate from {@link parseNames} only in which characters are refused:
 * wildcards are the point of a pattern, so `*` and `?` are legal here and a path
 * separator is not.
 *
 * @param text - the control's raw text.
 * @returns the patterns, or `undefined` when any line is unusable.
 */
export function parseFilePatterns(text: string): string[] | undefined {
  return parseNames(text, INVALID_PATTERN)
}

/**
 * Render a list of basenames as the control's text.
 * @param names - the stored values.
 * @returns one name per line.
 */
export function formatNames(names: unknown): string {
  return Array.isArray(names) ? (names as unknown[]).filter((n): n is string => typeof n === 'string').join('\n') : ''
}

/** One labelled textarea plus its hint. */
function NameListField({ id, label, hint, placeholder, value, disabled, invalid, invalidText, onChange }: NameListFieldProps) {
  return h('div', { style: FIELD }, [
    h('label', { key: 'label', htmlFor: id, style: LABEL }, label),
    h('textarea', {
      key: 'input',
      id,
      value,
      placeholder,
      disabled,
      rows: 3,
      spellCheck: false,
      'aria-invalid': invalid === true,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
      style: invalid === true ? { ...INPUT, borderColor: 'var(--dsw-alias-state-error-primary, #c0392b)' } : INPUT,
    }),
    h('p', { key: 'hint', style: invalid === true ? HINT_INVALID : HINT }, invalid === true ? invalidText : hint),
  ])
}

/**
 * The card's visual constants.
 *
 * Every `var()` carries a fallback, and every token name is one the shipped themes
 * actually define. That is not defensive padding: this card once rendered with no
 * borders at all because it used `--dsw-alias-border-secondary`, which does not
 * exist — an unresolvable `var()` with no fallback invalidates the whole
 * declaration, so `border: 1px solid var(…)` dropped to `border: none` and the
 * inputs looked like loose text. A fallback keeps one renamed token from erasing
 * the control.
 *
 * Names verified against the deployment: `bg-l1`, `border-l2`, `label-primary`,
 * `label-tertiary`, `state-error-primary`, `settings-card-fill`.
 */
const FIELD = { display: 'flex', flexDirection: 'column', gap: '6px', margin: '0 0 18px' }
const LABEL = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1f2329)' }
const INPUT = {
  font: 'inherit',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '12.5px',
  lineHeight: 1.55,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  background: 'var(--dsw-alias-bg-l1, #ffffff)',
  border: '1px solid var(--dsw-alias-border-l2, #d5d8dd)',
  borderRadius: '8px',
  padding: '8px 10px',
  boxSizing: 'border-box',
  width: '100%',
  resize: 'vertical',
  minHeight: '72px',
  outline: 'none',
}
const HINT = {
  margin: '0',
  fontSize: '12px',
  lineHeight: 1.6,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}
const HINT_INVALID = { ...HINT, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }
const ACTIONS = { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0 0' }
const BUTTON = {
  font: 'inherit',
  fontSize: '12.5px',
  padding: '6px 14px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l2, #d5d8dd)',
  background: 'var(--dsw-alias-settings-card-fill, #f7f8fa)',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  cursor: 'pointer',
}
const STATUS = { margin: '0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' }
/**
 * The detected-path line, when there is one to show.
 *
 * Monospace and in the primary colour on purpose: this is the one piece of
 * *runtime* information on the card, and the path is something the user copies.
 */
const STATUS_DETECTED = {
  margin: '0',
  fontSize: '12px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  wordBreak: 'break-all',
}
const ROW = { display: 'flex', gap: '8px', alignItems: 'stretch' }
const GROW = {
  ...INPUT,
  minHeight: '0',
  flex: '1 1 auto',
  resize: 'none',
  padding: '7px 10px',
  fontSize: '12px',
}
/** Section heading, one step below the host's own page title. */
const HEADING = {
  margin: '6px 0 12px',
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, #1f2329)',
  paddingBottom: '6px',
  borderBottom: '1px solid var(--dsw-alias-border-l1, #e8eaed)',
}

/**
 * Build the status fetcher, kept stable across renders.
 *
 * `useMemo` with no dependencies gives one identity for the component's life, so
 * the effect that re-checks on mount cannot turn into a request loop. (The card
 * does not depend on `useCallback`, which keeps the React stub in the test suite
 * small.)
 *
 * A transport or HTTP failure is reported as `failed`, not as "nothing found": the
 * two need different advice, and conflating them told users to install ES when the
 * real problem was that the Host route never answered.
 *
 * @param setStatus - receives the host's answer.
 * @param setChecking - tracks the in-flight state so the button can say so.
 * @param setFailed - marks a probe that could not be read.
 * @returns a stable callback that re-asks the host.
 */
function useStatusFetcher(
  setStatus: (value: EsStatus | undefined) => void,
  setChecking: (value: boolean) => void,
  setFailed: (value: boolean) => void,
): () => Promise<void> {
  return useMemo(() => async () => {
    setChecking(true)
    setFailed(false)
    try {
      const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (!response.ok) {
        setStatus(undefined)
        setFailed(true)
        return
      }
      setStatus((await response.json()) as EsStatus)
    } catch {
      // The `@` provider is unaffected; only this readout is unknown.
      setStatus(undefined)
      setFailed(true)
    } finally {
      setChecking(false)
    }
  }, [setStatus, setChecking, setFailed])
}

/**
 * The card itself.
 *
 * Staged-edit semantics, matching every host settings page: edits live in local
 * state until Save, so a half-typed list is never written, and Discard restores
 * the stored values.
 *
 * @param props - `t`, the settings scope, and the view the page asks for.
 * @returns the card, or the framework's unavailable notice.
 */
export function EverythingCard(props: CardProps) {
  const { t, settingsScope, view } = props
  const copy: Copy = t ?? COPY.zh
  const snapshot = useSettingsSnapshot(settingsScope)

  const stored = useMemo(() => {
    const value = (snapshot.value ?? {}) as Record<string, unknown>
    // `esCommand` is stored as the bare default `es.exe`, which the field shows as
    // empty so the placeholder reads "auto-detect" rather than naming a value the
    // user never typed.
    const command = typeof value.esCommand === 'string' ? value.esCommand : 'es.exe'
    return {
      command: command === 'es.exe' ? '' : command,
      folders: formatNames(value.excludeInQuery),
      patterns: formatNames(value.excludeFilePatterns),
      rows: formatNames(value.excludedDirectories),
    }
  }, [snapshot.value])

  const [commandText, setCommandText] = useState(stored.command)
  const [folderText, setFolderText] = useState(stored.folders)
  const [patternText, setPatternText] = useState(stored.patterns)
  const [rowsText, setRowsText] = useState(stored.rows)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [justSaved, setJustSaved] = useState(false)
  const [status, setStatus] = useState<EsStatus | undefined>(undefined)
  const [checking, setChecking] = useState(true)
  const [probeFailed, setProbeFailed] = useState(false)

  // Adopt a value that arrives after the first paint (the scope settles
  // asynchronously), and drop it while the user has unsaved edits, so an
  // unrelated settings reload cannot overwrite what they are typing.
  const dirty =
    commandText !== stored.command ||
    folderText !== stored.folders ||
    patternText !== stored.patterns ||
    rowsText !== stored.rows
  useEffect(() => {
    if (dirty) return
    setCommandText(stored.command)
    setFolderText(stored.folders)
    setPatternText(stored.patterns)
    setRowsText(stored.rows)
  }, [stored.command, stored.folders, stored.patterns, stored.rows, dirty])

  // Ask the host which es.exe is in effect. It cannot be derived from the form:
  // the answer is a filesystem fact about a resolution chain, and it changes when
  // the user edits PATH or installs ES without touching this card.
  const recheck = useStatusFetcher(setStatus, setChecking, setProbeFailed)
  useEffect(() => {
    void recheck()
    // Re-ask when the stored command changes, so a save is reflected without a
    // second click.
  }, [recheck, stored.command])

  if (settingsScope === undefined) {
    return h('p', { style: STATUS }, copy.unavailable)
  }
  if (snapshot.status !== 'ready') {
    return h('p', { style: STATUS }, snapshot.status === 'unavailable' ? copy.unavailable : copy.saving)
  }

  const readonly = snapshot.writable !== true
  const folderNames = parseNames(folderText)
  const filePatterns = parseFilePatterns(patternText)
  const rowNames = parseNames(rowsText)
  const invalid = folderNames === undefined || filePatterns === undefined || rowNames === undefined

  const save = async () => {
    if (readonly || invalid || busy) return
    setBusy(true)
    setFailure(undefined)
    setJustSaved(false)
    try {
      // Each field is written and checked on its own: one rejected write must not
      // report the others as saved. The command goes first, so a re-check after
      // the save reports the path the new configuration resolves to.
      await writeAndVerifyText(settingsScope, 'esCommand', commandText.trim() === '' ? 'es.exe' : commandText.trim())
      await writeAndVerify(settingsScope, 'excludeInQuery', folderNames)
      await writeAndVerify(settingsScope, 'excludeFilePatterns', filePatterns)
      await writeAndVerify(settingsScope, 'excludedDirectories', rowNames)
      setJustSaved(true)
      // Re-read the resolution chain: the operator just changed it, and the line
      // under the field must not keep naming the previous client.
      void recheck()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const children: unknown[] = [
    h('div', { key: 'es', style: FIELD }, [
      h('label', { key: 'label', htmlFor: 'dsh-atfe-es-command', style: LABEL }, copy.pathLabel),
      h('div', { key: 'row', style: ROW }, [
        h('input', {
          key: 'input',
          id: 'dsh-atfe-es-command',
          type: 'text',
          value: commandText,
          placeholder: status?.effective ?? copy.pathPlaceholder,
          disabled: readonly || busy,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (event: { target: { value: string } }) => setCommandText(event.target.value),
          style: GROW,
        }),
        h('button', {
          key: 'recheck',
          type: 'button',
          style: { ...BUTTON, whiteSpace: 'nowrap', cursor: checking ? 'progress' : 'pointer' },
          disabled: checking,
          onClick: () => {
            void recheck()
          },
        }, checking ? copy.checking : copy.recheck),
      ]),
      h('p', { key: 'hint', style: HINT }, copy.pathHint),
      h(
        'p',
        // Monospace only when there is actually a path to read off.
        { key: 'status', style: status?.effective === undefined ? STATUS : STATUS_DETECTED, role: 'status' },
        describeStatus({ status, failed: probeFailed, checking }, copy),
      ),
      // The client's own build, shown next to the path: two machines can resolve
      // different `es.exe` versions for the same Everything, and a version that
      // predates a switch explains behaviour the path alone cannot.
      versionLine(status, copy) === undefined
        ? null
        : h('p', { key: 'version', style: STATUS_DETECTED, role: 'status' }, versionLine(status, copy)),
    ]),
    h('h3', { key: 'title', style: HEADING }, copy.title),
    h(NameListField, {
      key: 'folders',
      id: 'dsh-atfe-exclude-folders',
      label: copy.folderLabel,
      hint: copy.folderHint,
      placeholder: copy.folderPlaceholder,
      value: folderText,
      disabled: readonly || busy,
      invalid: folderNames === undefined,
      invalidText: copy.invalidFolder,
      onChange: setFolderText,
    }),
    h(NameListField, {
      key: 'patterns',
      id: 'dsh-atfe-exclude-patterns',
      label: copy.fileLabel,
      hint: copy.fileHint,
      placeholder: copy.filePlaceholder,
      value: patternText,
      disabled: readonly || busy,
      invalid: filePatterns === undefined,
      invalidText: copy.invalidFile,
      onChange: setPatternText,
    }),
    h(NameListField, {
      key: 'rows',
      id: 'dsh-atfe-exclude-rows',
      label: copy.rowsLabel,
      hint: copy.rowsHint,
      placeholder: copy.rowsPlaceholder,
      value: rowsText,
      disabled: readonly || busy,
      invalid: rowNames === undefined,
      invalidText: copy.invalidFolder,
      onChange: setRowsText,
    }),
  ]

  if (stored.folders === '' && stored.patterns === '' && stored.rows === '' && !dirty) {
    children.push(h('p', { key: 'empty', style: STATUS }, copy.empty))
  }

  children.push(
    h('div', { key: 'actions', style: ACTIONS }, [
      h('button', {
        key: 'save',
        type: 'button',
        style: { ...BUTTON, opacity: readonly || invalid || busy || !dirty ? 0.5 : 1 },
        disabled: readonly || invalid || busy || !dirty,
        onClick: save,
      }, busy ? copy.saving : copy.save),
      h('button', {
        key: 'discard',
        type: 'button',
        style: { ...BUTTON, opacity: !dirty || busy ? 0.5 : 1 },
        disabled: !dirty || busy,
        onClick: () => {
          setFolderText(stored.folders)
          setPatternText(stored.patterns)
          setRowsText(stored.rows)
          setFailure(undefined)
          setJustSaved(false)
        },
      }, copy.discard),
      justSaved
        ? h('p', { key: 'ok', style: STATUS, role: 'status' }, copy.saved)
        : null,
      failure === undefined
        ? null
        : h('p', { key: 'err', style: HINT_INVALID, role: 'status' }, `${copy.saveFailed} ${failure}`),
    ]),
  )

  if (readonly) children.unshift(h('p', { key: 'ro', style: STATUS, role: 'status' }, copy.readOnly))
  // `view` is only used by the page to ask for a one-liner; this card has none.
  void view

  return h('div', { 'data-plugin': NAMESPACE }, children)
}

/**
 * Subscribe to a settings scope and re-render on change.
 * @param scope - the bound settings scope, or undefined when absent.
 * @returns the current snapshot, or a neutral one.
 */
function useSettingsSnapshot(scope: SettingsScope | undefined): ScopeSnapshot {
  const [snapshot, setSnapshot] = useState<ScopeSnapshot>(() =>
    scope === undefined ? { status: 'unavailable' } : scope.getSnapshot(),
  )
  useEffect(() => {
    if (scope === undefined) return undefined
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [scope])
  return snapshot
}

/**
 * Write one field and confirm the scope read it back.
 *
 * `set()` resolving means the request was answered, not that the document was
 * replaced — see the module comment. Comparing the read-back is the only
 * reliable check, and it is what the official cards do.
 *
 * @param scope - the bound settings scope.
 * @param field - the Config field to write.
 * @param value - the complete next value for that field.
 * @throws when the value does not read back, so the card reports a real failure.
 */
export async function writeAndVerify(
  scope: SettingsScope,
  field: string,
  value: readonly string[],
): Promise<void> {
  await scope.set(field, [...value])
  const readBack = (scope.getSnapshot().value ?? {})[field]
  const same =
    Array.isArray(readBack) &&
    readBack.length === value.length &&
    readBack.every((entry, index) => entry === value[index])
  if (!same) {
    throw new Error(`${field} did not persist (read back ${JSON.stringify(readBack)})`)
  }
}

/**
 * Render the one line under the path field.
 *
 * It answers the question the field itself cannot: *which* `es.exe` will run, and
 * where that answer came from. A bare path would be misleading — the interesting
 * distinction is "your own install" versus "the fallback we shipped", because the
 * two behave differently when Everything is upgraded.
 *
 * Three outcomes are kept apart on purpose. "Nothing was found" and "the Host could
 * not be asked" look identical in an empty variable, but they need opposite advice:
 * the first means install ES, the second means the route did not answer and the
 * user should fill the path in by hand.
 *
 * @param state - the probe's current state.
 * @param copy - the card's copy.
 * @returns the status line.
 */
export function describeStatus(
  state: { status?: EsStatus; failed: boolean; checking: boolean },
  copy: Copy,
): string {
  // While the first probe is in flight the button already says so; repeating it on
  // the line below would read as two separate states.
  if (state.checking && state.status === undefined) return ''
  if (state.failed && state.status === undefined) return copy.probeFailed
  const status = state.status
  if (status === undefined || status.effective === undefined) return copy.notFound
  const source = copy.sourceLabels[status.source ?? ''] ?? status.source ?? ''
  // A pinned path the host could not use falls back to another candidate: say so,
  // rather than letting the field show one path while the line names another.
  if (status.overridden && status.source !== 'configured') {
    return `${copy.pinnedMissing} ${status.effective}（${source}）`
  }
  return `${copy.detected}: ${status.effective}（${source}）`
}

/**
 * Render the client-version line, when there is one to show.
 *
 * Kept separate from the status line because it answers a different question: the
 * path says *which* client runs, the version says *how old* it is. Two machines can
 * resolve different builds for the same Everything, and a build that predates a
 * switch explains behaviour the path alone cannot.
 *
 * @param status - the host's answer, or undefined when it could not be read.
 * @param copy - the card's copy.
 * @returns the line, or undefined when no version was reported.
 */
export function versionLine(status: EsStatus | undefined, copy: Copy): string | undefined {
  const version = status?.version
  if (typeof version !== 'string' || version === '') return undefined
  return `${copy.versionLabel} ${version}`
}

/**
 * Write one string field and confirm the scope read it back.
 *
 * The same read-back rule as {@link writeAndVerify}, for the one scalar field the
 * card edits: `set()` resolving means the request was answered, not that the
 * profile document was replaced.
 *
 * @param scope - the bound settings scope.
 * @param field - the Config field to write.
 * @param value - the complete next value.
 * @throws when the value does not read back.
 */
export async function writeAndVerifyText(scope: SettingsScope, field: string, value: string): Promise<void> {
  await scope.set(field, value)
  const readBack = (scope.getSnapshot().value ?? {})[field]
  if (readBack !== value) {
    throw new Error(`${field} did not persist (read back ${JSON.stringify(readBack)})`)
  }
}

/** The browser plugin context, narrowed to what this card touches. */
interface ClientContext {
  /**
   * The locale service, read only for which language to use.
   *
   * `bind()` answers a lookup function (`t('key')`), never a copy table; the card
   * keeps its own literal copy so no lookup can come back undefined.
   */
  locale?: {
    register?(namespace: string, table: Record<string, unknown>): void
    bind?(namespace: string): unknown
    getSnapshot?(): unknown
  }
  get?(service: string): unknown
  slots: {
    inject(name: string, factory: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  effect(callback: () => () => void, label: string): void
}

/**
 * Register the card on the Plugins page.
 *
 * The card lives in `plugins.bundle.config`, keyed by this bundle's package
 * name, which is where the page shows a bundle's own configuration. That slot
 * and the `configForms` service are both probed rather than declared in
 * `inject`, because a Cordis dependency gate is hard: an absent service would
 * keep `apply` from running at all. A deployment without them simply shows no
 * card while the `@` provider keeps working.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Resolve the copy to a COMPLETE literal table before the card ever renders.
  //
  // `ctx.locale.bind()` returns a lookup *function*, not an object of strings, so
  // treating its result as a copy table silently yields `undefined` for every
  // label, hint and button caption while data-driven values still render — a card
  // of empty boxes with the right numbers in them. The card's copy is therefore a
  // literal here, and the locale service decides only which language to use.
  const copy = copyFor(activeLanguage(ctx))

  // `ctx.get` answers undefined instead of throwing for a service this deployment
  // does not provide. A missing `configForms` must NOT stop the card from being
  // registered: the card renders its own "unavailable" notice, which is far more
  // useful than a page that silently shows no custom card at all.
  const forms = typeof ctx.get === 'function' ? ctx.get('configForms') : undefined
  const settingsScope = () => (isFormsService(forms) ? resolveSettingsScope(forms) : undefined)

  const dispositions: Array<() => void> = []
  for (const slotName of ['plugins.bundle.config', 'plugins.row.config']) {
    // `plugins.bundle.config` is keyed by the PACKAGE name (the Plugins page
    // compares it against its own inventory), while `plugins.row.config` is
    // keyed by `<package>#<row id>`. The settings namespace is neither — it is
    // the Loader entry id, which is why the card resolves it separately.
    const key = slotName === 'plugins.bundle.config' ? NAMESPACE : `${NAMESPACE}#file-reference-everything`
    try {
      dispositions.push(
        ctx.slots.inject(slotName, () =>
          ctx.slots.register(
            {
              name: slotName,
              key,
              priority: 30,
              inject: () => ({ t: copy, settingsScope: settingsScope() }),
            },
            EverythingCard,
          ),
        ),
      )
    } catch (error) {
      // One slot failing must not cost the other, and the failure has to be
      // visible: a missing card is otherwise indistinguishable from a broken one.
      console.error(`[dsh-at-file-everything] card slot "${slotName}" failed to register:`, error)
    }
  }

  ctx.effect(
    () => () => {
      for (const dispose of dispositions) dispose()
      dispositions.length = 0
    },
    'dsh-at-file-everything: configuration card',
  )
}

/**
 * Pick the card's copy for one language.
 *
 * The returned table is always complete: both languages are written out in full
 * in this module, so no lookup can come back empty. That is deliberate — the
 * failure this replaced was a card whose every caption was `undefined` while its
 * inputs still held the right values.
 *
 * @param language - `zh` or `en`.
 * @returns the copy table for that language.
 */
export function copyFor(language: 'zh' | 'en'): Copy {
  return language === 'zh' ? COPY.zh : COPY.en
}

/**
 * Decide which language the card should speak.
 *
 * The locale service is consulted only for this one fact. Its `bind()` returns a
 * lookup function rather than a copy table, and its snapshot shape is not part of
 * the card's contract, so every read is defensive and every failure falls back to
 * the browser's own language before the default.
 *
 * @param ctx - the browser plugin context.
 * @returns the language to render in.
 */
export function activeLanguage(ctx: ClientContext): 'zh' | 'en' {
  const fromService = (): unknown => {
    try {
      const snapshot = ctx.locale?.getSnapshot?.() as { active?: unknown } | undefined
      const active = snapshot?.active
      return typeof active === 'string' ? active : (active as { id?: unknown } | undefined)?.id
    } catch {
      return undefined
    }
  }
  const candidates = [fromService(), typeof navigator === 'undefined' ? undefined : navigator.language]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    return candidate.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
  // No signal at all: this plugin's primary audience, and the language of the
  // documentation the card mirrors.
  return 'zh'
}

/**
 * Find the settings form the Host actually serves for this bundle.
 *
 * `forms.get()` throws for an unknown namespace on some builds, and returns a
 * scope whose snapshot never becomes `ready` on others, so this returns the
 * first candidate that answers at all and lets the card render the
 * "not loaded" notice when none does.
 *
 * @param forms - the probed settings service.
 * @returns the bound scope, or undefined when this deployment serves none.
 */
function resolveSettingsScope(forms: { get(namespace: string): SettingsScope }): SettingsScope | undefined {
  for (const namespace of SETTINGS_NAMESPACE_CANDIDATES) {
    try {
      const scope = forms.get(namespace)
      if (scope !== undefined && scope !== null) return scope
    } catch {
      // An absent namespace is an answer, not a failure: try the next spelling.
    }
  }
  return undefined
}

/**
 * Narrow the probed settings service to the surface the card uses.
 * @param value - whatever `ctx.get('configForms')` answered.
 * @returns whether it can bind a namespace to a form scope.
 */
function isFormsService(value: unknown): value is { get(namespace: string): SettingsScope } {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

export { COPY, NAMESPACE, SETTINGS_NAMESPACE_CANDIDATES, parseNames as parseExcludedNames }
