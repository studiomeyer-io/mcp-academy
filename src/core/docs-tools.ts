/** Public documentation mode has one shared allowlist for listing and execution. */
export const DOCS_TOOL_NAMES = ["search", "fetch"] as const;

export function isDocsTool(name: string): boolean {
  return DOCS_TOOL_NAMES.some(allowed => allowed === name);
}
