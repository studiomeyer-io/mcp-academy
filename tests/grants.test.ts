import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGrant,narrowGrant,hasScopes,parseScopes,MCP_RESOURCE,REST_RESOURCE,type Grant } from "../src/auth/grants.js";
const grant:Grant={scopes:["learn:read","learn:write","credits:spend"],resource:MCP_RESOURCE,grant_version:2,consented_at:new Date()};
test("legacy scope-less/mcp:write grants never acquire spending or writing",()=>{
  for(const row of [{},{grant_version:1},{grant_version:1,scopes:["credits:spend"]},{scopes:["mcp:write"]}]) {
    const normalized=normalizeGrant(row as Partial<Grant>);
    assert.deepEqual(normalized.scopes,["learn:read"]);assert.equal(normalized.resource,MCP_RESOURCE);assert.equal(normalized.consented_at,null);
    assert.equal(hasScopes(normalized,["learn:write"]),false);assert.equal(hasScopes(normalized,["credits:spend"]),false);
  }
});
test("negative scopes and audience mismatch deny operations",()=>{
  assert.equal(hasScopes({...grant,scopes:["learn:read"]},["learn:write"]),false);
  assert.equal(hasScopes({...grant,resource:REST_RESOURCE},["learn:read"]),false);
  assert.equal(hasScopes(null,["learn:read"]),false);assert.equal(hasScopes(null,[]),true);
  assert.equal(hasScopes(normalizeGrant({...grant,consented_at:null}),["learn:read"]),false);
});
test("refresh only preserves or narrows grants and never changes resources",()=>{
  assert.deepEqual(narrowGrant(grant,null,null),grant);
  assert.deepEqual(narrowGrant(grant,"learn:read",null).scopes,["learn:read"]);
  assert.throws(()=>narrowGrant({...grant,scopes:["learn:read"]},"credits:spend",null),/invalid_scope/);
  assert.throws(()=>narrowGrant(grant,null,REST_RESOURCE),/invalid_target/);
  assert.throws(()=>parseScopes("mcp:write"),/invalid_scope/);
});
