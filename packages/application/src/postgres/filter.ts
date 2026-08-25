export function filterSignature(
  entries:
    readonly (readonly [string, string | boolean | readonly string[] | null])[],
): string {
  return JSON.stringify(Object.fromEntries(entries));
}
