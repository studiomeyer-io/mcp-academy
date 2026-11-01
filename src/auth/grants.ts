/** Immutable authorization carried from consent through every token rotation. */
export const SCOPES = ["learn:read", "learn:write", "credits:spend"] as const;
export type Scope = typeof SCOPES[number];
export const MCP_RESOURCE = "https://mcp.studiomeyer.academy/mcp";
export const REST_RESOURCE = "https://studiomeyer.academy/v1";
export interface Grant {
  scopes: Scope[];
  resource: string;
  grant_version: number;
  consented_at: Date | string | null;
}
export function parseScopes(value: string): Scope[] {
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (scopes.some(scope => !SCOPES.includes(scope as Scope))) throw new Error("invalid_scope");
  return scopes as Scope[];
}
export function resourceAllowed(value: string): boolean {
  return value === MCP_RESOURCE || value === REST_RESOURCE;
}
/** Scope-less legacy grants are read-only, MCP-only, and never imply consent. */
export function normalizeGrant(row: Partial<Grant>): Grant {
  if (row.grant_version !== 2) {
    return { scopes: ["learn:read"], resource: MCP_RESOURCE, grant_version: 1, consented_at: null };
  }
  if (!row.consented_at || !Array.isArray(row.scopes) || !resourceAllowed(row.resource ?? "")) {
    return { scopes: [], resource: "invalid", grant_version: 2, consented_at: null };
  }
  return { scopes: row.scopes.filter(s => SCOPES.includes(s)), resource: row.resource!, grant_version: 2, consented_at: row.consented_at };
}
export function narrowGrant(grant: Grant, scope: string | null, resource: string | null): Grant {
  if (resource !== null && resource !== grant.resource) throw new Error("invalid_target");
  const requested = scope === null ? grant.scopes : parseScopes(scope);
  if (requested.some(s => !grant.scopes.includes(s))) throw new Error("invalid_scope");
  return { ...grant, scopes: requested };
}
export function hasScopes(grant: Grant | null, scopes: readonly string[]): boolean {
  return scopes.length === 0 || !!grant && grant.resource === MCP_RESOURCE && scopes.every(s => grant.scopes.includes(s as Scope));
}
