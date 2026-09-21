export function alreadyPublishedToday(briefId: string | undefined, today: string): boolean
export interface GrokUsageLimit {
  label?: string
  percent?: number
  resetsAt?: string
}
export interface GrokUsageRecord {
  limits?: GrokUsageLimit[]
  updatedAt?: string
}
export function grokLimitRemaining(record: GrokUsageRecord | null | undefined, now?: Date): number | undefined
export function grokUsageRecordPath(): string
export function marketDate(now?: Date): string
export function readGrokLimitRemaining(recordPath?: string, now?: Date): Promise<number | undefined>
export function museExecArgs(input: {
  promptPath: string
  workspace: string
  provider?: string
  maxTurns?: number
}): string[]
export function isolatedMuseSettings(
  token: string,
  sourcePath?: string,
): Promise<{
  schema_version: 1
  provider?: string
  model?: string
  mcpServers: { heston: { headers: { Authorization: string }; url: string } }
}>
export function museRun(prompt: string, token: string): Promise<void>
export function runResearchAgent(
  prompt: string,
  token: string,
  runners?: {
    grok: (prompt: string, token: string) => Promise<void>
    muse: (prompt: string, token: string) => Promise<void>
  },
  skipGrok?: boolean,
): Promise<'grok' | 'muse'>
export function shouldRunForMarket(
  market: { opensAt?: string; state: string },
  now?: Date,
): boolean
export function unattendedPromptSuffix(input: {
  briefId?: string
  market: { opensAt?: string; state: string }
  today: string
}): string

export function readMarketState(): Promise<{ opensAt?: string; state: string }>
