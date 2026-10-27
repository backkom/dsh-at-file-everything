/**
 * Ambient declarations for the Harness packages this plugin imports.
 *
 * The real packages ship inside the Harness installation (`app.asar`) and are
 * resolved at runtime through the profile's module interception, so they cannot
 * be installed into this workspace. These declarations cover only the surface
 * this plugin touches, and are deliberately narrow: a drift in the real API
 * should surface as a type error rather than silently degrade to `any`.
 *
 * @module dsh-at-file-everything/typings
 */

declare module '@deepseek-ai/cordis' {
  /** Base class for a named service registered on a context. */
  export class Service<T = unknown> {
    constructor(ctx: Context, name: string)
    /** The service name this instance is registered under. */
    readonly name: string
    /** The context that owns this service, for logging and dependency access. */
    protected readonly ctx: Context
  }

  /** A fiber returned by `ctx.inject`. */
  export interface Fiber {
    /** Unload the plugin and everything it mounted. */
    dispose(): Promise<void>
  }

  /** A context scoped to one agent. */
  export interface AgentContext extends Context {
    /** Mount a plugin once the named services exist; resolves to its fiber. */
    inject(
      names: string[],
      plugin: (scope: ScopedContext) => void,
    ): Fiber
    /** The agent's filesystem tool registry. */
    tools: {
      get(name: string, agent: unknown): unknown
    }
  }

  /** The context handed to `inject` callbacks, carrying the requested services. */
  export interface ScopedContext extends Context {
    systemPrompt: {
      section(entry: { name: string; order: number; text: () => string }): void
      getSectionOrder(name: string): number
    }
    tools: {
      get(name: string, agent: unknown): unknown
    }
  }

  /** One live agent. */
  export interface Agent {
    /** The agent's own context. */
    readonly ctx: AgentContext
    /** Owning session, whose `id` addresses the agent. */
    readonly session: { readonly id: string }
  }

  /** The agent registry service. */
  export interface AgentsService {
    list(): Agent[]
    get(sessionId: string): Agent | undefined
  }

  /** Minimal structural view of a Cordis context. */
  export interface Context {
    /** Request-scoped logger; the host always provides one. */
    logger?: {
      info?(message: string): void
      warn?(message: string): void
    }
    /** The agent registry. */
    agents: AgentsService
    /** Session working directories, from `@deepseek-ai/dsh-working-directory`. */
    workingDirectory: {
      /** Resolve one agent's existing absolute working directory. */
      ensure(agent: Agent, signal: AbortSignal): Promise<string>
    }
    /** The file-reference discovery seam this plugin provides. */
    fileReferences: {
      list(agent: Agent, query: string, signal: AbortSignal): Promise<unknown[]>
    }
    /**
     * The tool registry, when this composition has one.
     *
     * Optional because a library or headless composition may register no tools;
     * `apply` then exposes only the `@` provider.
     */
    tools?: {
      /** Register one definition; returns the disposer that removes it. */
      register(definition: unknown): () => void
    }
    /**
     * Read a service without declaring it in `inject`.
     *
     * Returns `undefined` for a service this composition does not provide, which
     * is what makes an optional capability (the tool registry) probe-able
     * instead of a hard dependency.
     */
    get?(name: string): unknown
    /**
     * Run a callback in a child context that requires the named services.
     *
     * A Cordis dependency gate is hard: the callback runs only once every named
     * service is available, and runs again if one is replaced. This is how an
     * optional capability is used without gating the whole plugin on it.
     */
    inject?(names: readonly string[], callback: (scope: Context) => void): unknown
    /** The fiber owning this plugin instance, used as an ownership token. */
    fiber?: unknown
    /**
     * The Web server, reachable inside an `inject(['webServer'])` scope.
     *
     * `register` takes an exact path and a Node-style handler; the returned
     * disposer removes the route.
     */
    webServer?: {
      register(route: {
        kind: 'exact'
        path: string
        handler: (req: unknown, res: never) => void
      }): () => void
    }
    /**
     * The settings service, reachable inside an `inject(['settings'])` scope.
     *
     * `configure` declares this instance's page policy; `{ auto: false }` tells
     * the Host that the plugin renders its own configuration page, which is what
     * suppresses the generic schema-generated form.
     */
    settings?: {
      configure(presentation: { auto?: boolean }, owner?: unknown): () => void
    }
    /** Register an event listener for the owning fiber's lifetime. */
    on(event: string, listener: (...args: never[]) => void): void
    /** Run a cleanup callback when the owning fiber unloads. */
    effect(callback: () => () => Promise<void> | void, label: string): void
  }
}

/**
 * The tool-definition seam.
 *
 * `defineTool` validates the argument spec into JSON Schema, validates every call
 * against it, and hands `execute` the parsed arguments plus an execution context
 * carrying the calling agent and its cancellation signal.
 */
declare module '@deepseek-ai/dsh-tools' {
  /** The execution context one call receives. */
  export interface ToolExecution {
    /** The calling agent, when the call came from one. */
    agent?: { readonly session: { readonly id: string } }
    /** Cancellation for this call. */
    signal: AbortSignal
  }

  /** One parameter's declaration. */
  export interface ParameterSpec {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
    description?: string
    required?: boolean
    enum?: readonly string[]
  }

  /** One value schema node. */
  export interface ValueSchema {
    type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
    description?: string
    required?: boolean
    additionalProperties?: boolean
    properties?: Record<string, ValueSchema>
    items?: ValueSchema
    enum?: readonly string[]
  }

  /** Options accepted by the tool registry. */
  export interface ToolOptions {
    name: string
    description: string
    parameters?: Record<string, ParameterSpec>
    output: {
      schema: ValueSchema
      render: (args: Record<string, unknown>, value: never) => unknown[]
      presentationMeta?: (args: Record<string, unknown>, value: never) => unknown
    }
    execute: (args: Record<string, unknown>, exec: ToolExecution) => Promise<unknown>
    presentCall?: (args: Record<string, unknown>) => unknown
    presentResult?: (args: Record<string, unknown>, result: { meta?: unknown }) => unknown
    timeoutMs?: number
    deferLoading?: boolean
    isConcurrencySafe?: (args: Record<string, unknown>) => boolean
  }

  /** Build a registry-ready definition from a typed declaration. */
  export function defineTool(options: ToolOptions): unknown
}

declare module '@deepseek-ai/dsh-file-reference' {
  import type { Agent, Context, Service } from '@deepseek-ai/cordis'

  /** Model guidance for path-only references selected by a user interface. */
  export const FILE_REFERENCE_PROMPT: string

  /** Abstract host capability for cancellable file-reference discovery. */
  export abstract class FileReferenceService extends Service<unknown> {
    constructor(ctx: Context)
    /** List path candidates for one agent's query. */
    abstract list(agent: Agent, query: string, signal: AbortSignal): Promise<unknown[]>
  }

  export default FileReferenceService
}

declare module '@deepseek-ai/schemastery' {
  /**
   * A schema carrying its inferred type.
   *
   * Schemastery schemas are callable: invoking one validates its input and
   * returns the resolved value, which is how the Loader materialises defaults
   * and how `apply` obtains a complete configuration when loaded outside it.
   */
  export interface Schema<T> {
    /** Validate `value` (or nothing) and return the resolved configuration. */
    (value?: Record<string, unknown>): T
    /** Phantom type carrier; never read at runtime. */
    readonly __type?: T
  }

  /**
   * A schema still under construction, which is itself a callable factory.
   *
   * Every chainable method returns the builder, so `z.string().default('x').volatile()`
   * and `z.number().step(1).min(1).default(20).volatile()` both type-check.
   */
  export interface Builder<T> extends Schema<T> {
    default(value: T): Builder<T>
    step(value: number): Builder<T>
    min(value: number): Builder<T>
    max(value: number): Builder<T>
    description(text: string): Builder<T>
    /**
     * Mark the field as user-overridable and live.
     *
     * The Harness serves configuration forms only for volatile fields, and such
     * a field reaches `apply` as a live handle rather than a value.
     */
    volatile(): Builder<T>
  }

  /** Schema factory surface used by this plugin. */
  export interface Schemastery {
    string(): Builder<string>
    number(): Builder<number>
    boolean(): Builder<boolean>
    array(item: Schema<unknown>): Builder<string[]>
    object(shape: Record<string, Schema<unknown>>): Builder<unknown>
  }

  /** Callable factory: a schema is also a builder. */
  const z: Schemastery & ((value: unknown) => unknown)
  export default z
  /** A schema carrying `T`; the value form used in type positions. */
  export type z<T> = Schema<T>
}

/**
 * The browser half's ambient surface.
 *
 * The Web shell evaluates `lib/client.cjs.js` as a plain script and hands its
 * factory a CommonJS `require`. Only `react` is reached for, and the Harness
 * module table provides it — `@deepseek-ai/dsh-client-ui-primitives` is
 * deliberately not imported (see `src/client.ts`).
 */
declare module 'react' {
  /** The shape this card needs from a hook; the real type is far wider. */
  export type SetState<T> = (next: T | ((previous: T) => T)) => void

  /** Minimal element factory used instead of JSX. */
  export function createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown
  export function useState<T>(initial: T | (() => T)): [T, SetState<T>]
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}
