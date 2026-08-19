function unsupported(): never {
  throw new Error('UnsupportedAiCall')
}

/**
 * Every Workers AI call except the one the app makes. Spreading this into a fake binding
 * keeps it shaped like `Ai`, and every unused call throws, so a code path that reaches for
 * more than `run` fails loudly instead of reading a silent stub.
 */
export function unsupportedAi() {
  return {
    aiGatewayLogId: null,
    aiSearch: unsupported,
    autorag: unsupported,
    gateway: unsupported,
    models: unsupported,
    run: unsupported,
    toMarkdown: unsupported,
  }
}
