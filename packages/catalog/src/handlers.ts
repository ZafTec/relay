/**
 * "Handler registry" from
 * docs/implementation-handoff/05-domain-storage-metering.md: "Code
 * registers handlers by stable key ... Database `handler_key` selects
 * only a handler that exists in the deployed registry. Unknown handlers
 * make the tool version unavailable; database content never becomes
 * executable code."
 *
 * The full `ToolHandler<I, O>` shape from that doc (`validate`,
 * `prepare(context, input)`, `normalize(result)`) isn't implemented
 * here -- `prepare`/`normalize` are typed against a
 * `RestrictedToolContext`/`PreparedOperation`/`ProviderResult` that only
 * make sense once Wave 5 defines a real provider adapter to prepare
 * operations for and normalize results from. What's needed *now* is
 * exactly what "unknown handlers make the tool version unavailable"
 * requires: a registry of which handler keys exist, checked before a
 * tool version is allowed to publish.
 */
export interface HandlerRegistry {
  register(key: string): void;
  has(key: string): boolean;
  readonly keys: ReadonlySet<string>;
}

export function createHandlerRegistry(
  initialKeys: readonly string[] = [],
): HandlerRegistry {
  const keys = new Set<string>(initialKeys);
  return {
    register(key: string): void {
      keys.add(key);
    },
    has(key: string): boolean {
      return keys.has(key);
    },
    keys,
  };
}
