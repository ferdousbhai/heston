import { type Static, type TSchema } from 'typebox'

/**
 * The tool shape every Spice tool factory produces and the MCP surface consumes.
 *
 * This was imported as a type from `@earendil-works/pi-agent-core`, the runtime that used to
 * run an agent loop inside the Worker. That loop is gone; nothing but this one interface was
 * still being used, and it kept an entire agent runtime — and the Google AI SDK behind it — in
 * the dependency tree for a declaration. Declaring it here costs nothing and lets the tools be
 * what they now are: descriptions handed to whatever agent the member runs on their own
 * machine, never to a loop we host.
 *
 * It is deliberately narrower than the interface it replaces, carrying only what this
 * repository builds and reads. Anything a future caller needs is added here on purpose.
 */

/** Text or image a tool returns to the model. Only text reaches the MCP wire. */
export type AgentToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface AgentToolResult<TDetails = unknown> {
  content: AgentToolContent[]
  /**
   * Structured detail for a caller that wants more than the text. Kept untyped at this
   * boundary on purpose: every reader parses it with its own schema rather than trusting a
   * shared shape, which is what lets one tool's detail change without touching another's.
   */
  details: TDetails
}

/**
 * Streams partial results while `execute` runs. Scoped to that invocation; calls after the
 * promise settles are ignored. Spice tools do not stream today, but the parameter is part of
 * the shape a wrapping tool must pass through.
 */
export type AgentToolUpdateCallback<TDetails = unknown> = (partial: AgentToolResult<TDetails>) => void

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
  description: string
  /**
   * A tool that must not run concurrently with another says so. Everything else may be
   * batched by whatever agent is driving.
   */
  executionMode?: 'sequential' | 'parallel'
  /** Human-readable label for display. */
  label: string
  name: string
  parameters: TParameters
  /** Throw on failure rather than encoding an error in `content`. */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>
}
