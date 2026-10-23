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
    /** Register an event listener for the owning fiber's lifetime. */
    on(event: string, listener: (...args: never[]) => void): void
    /** Run a cleanup callback when the owning fiber unloads. */
    effect(callback: () => () => Promise<void> | void, label: string): void
  }
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

  /** A schema still under construction, which is itself a callable factory. */
  export interface Builder<T> extends Schema<T> {
    default(value: T): Schema<T>
    step(value: number): Builder<T>
    min(value: number): Builder<T>
  }

  /** Schema factory surface used by this plugin. */
  export interface Schemastery {
    string(): Builder<string>
    number(): Builder<number>
    boolean(): Builder<boolean>
    array(item: Schema<unknown>): Builder<unknown[]>
    object(shape: Record<string, Schema<unknown>>): Builder<unknown>
  }

  /** Callable factory: a schema is also a builder. */
  const z: Schemastery & ((value: unknown) => unknown)
  export default z
  /** A schema carrying `T`; the value form used in type positions. */
  export type z<T> = Schema<T>
}
