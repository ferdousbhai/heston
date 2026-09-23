import { Settings } from 'typebox/system'

/**
 * TypeBox compiles a validator by generating source and instantiating it with `Function`,
 * and it decides whether it may do that exactly once, by probing at first use. A Worker
 * allows code generation while its modules evaluate and forbids it afterwards, so a probe
 * that runs during startup answers "yes" for the life of the isolate and every later
 * compile throws `Code generation from strings disallowed for this context`.
 *
 * That is a request-time failure no test in Node can reproduce, and this Worker reaches it on
 * every MCP call: `server.ts` imports `./server/mcp` lazily, so the module-scope `Compile(...)`
 * calls in the tool modules it pulls in (`option-greeks-tool.ts`, `catalyst-record-tool.ts`,
 * `symbol-evidence-tool.ts`) evaluate while a request is being served, not at startup.
 *
 * Turning acceleration off takes the interpreted checker instead. It validates the same
 * schemas with the same errors, just without generated code, which is the only form of
 * validation a Worker can perform once it is serving requests.
 */
export function configureTypeboxRuntime(): void {
  Settings.Set({ useAcceleration: false })
}
