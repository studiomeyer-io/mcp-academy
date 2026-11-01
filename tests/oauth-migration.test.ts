import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { getDb,__setPoolForTest,closeDb } from "../src/db.js";
import { runMigration } from "../scripts/migrate.js";
import { hashToken } from "../src/auth/token-hash.js";
import { authenticateBearer,randomToken,rotateRefresh } from "../src/auth/oauth-persistence.js";
import { MCP_RESOURCE } from "../src/auth/grants.js";

test("real v2-to-v3 migration preserves a populated legacy pair in an isolated synthetic schema",async()=>{
  const configured=new URL(process.env.ACADEMY_MCP_DATABASE_URL ?? "postgres://missing.invalid/no-database");
  assert.equal(configured.hostname,"127.0.0.1");assert.equal(configured.port,"3431");assert.equal(configured.pathname,"/academy_rebuild");
  const bootstrap=getDb();
  const identity=(await bootstrap.query<{database:string;server:string}>("SELECT current_database() AS database,inet_server_addr()::text AS server")).rows[0];assert.equal(identity.database,"academy_rebuild");assert.ok(identity.server);
  const namespace=`academy_mcp_migration_test_${process.pid}_${Date.now()}`;
  await bootstrap.query(`CREATE SCHEMA ${namespace}`);
  const scoped=new Pool({connectionString:configured.toString(),options:`-c search_path=${namespace}`,max:1});
  __setPoolForTest(scoped);
  try {
    const legacySql=readFileSync(new URL("./oauth-schema-v2.fixture.sql",import.meta.url),"utf8");assert.match(legacySql,/SCHEMA_VERSION: 2/);
    await runMigration(legacySql);
    const access=randomToken(),refresh=randomToken(),client=`mcpbuild_migration_${process.pid}`,email=`${client}@example.com`;
    await scoped.query("INSERT INTO academy_mcp_oauth_access_tokens(token,client_id,email,family_id,expires_at) VALUES($1,$2,$3,NULL,NOW()+INTERVAL '1 hour')",[hashToken(access),client,email]);
    await scoped.query("INSERT INTO academy_mcp_oauth_refresh_tokens(token,client_id,email,family_id,access_token,expires_at) VALUES($1,$2,$3,NULL,$4,NOW()+INTERVAL '30 days')",[hashToken(refresh),client,email,hashToken(access)]);
    assert.equal((await scoped.query("SELECT version FROM academy_mcp_schema_meta")).rows[0].version,2);
    await runMigration();
    assert.equal((await scoped.query("SELECT version FROM academy_mcp_schema_meta")).rows[0].version,3);
    const preserved=(await scoped.query("SELECT token,family_id,scopes,resource,grant_version,consented_at FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(access)])).rows[0];
    assert.deepEqual(preserved,{token:hashToken(access),family_id:null,scopes:null,resource:null,grant_version:null,consented_at:null});
    assert.deepEqual((await authenticateBearer(access))?.scopes,["learn:read"]);
    const rotated=await rotateRefresh(new URLSearchParams({refresh_token:refresh,client_id:client}));assert.ok(rotated.ok);if(!rotated.ok)throw new Error("Migrated legacy rotation failed");
    assert.equal(rotated.pair.scope,"learn:read");assert.equal(rotated.pair.resource,MCP_RESOURCE);assert.equal((await authenticateBearer(rotated.pair.access_token))?.consented_at,null);
    assert.equal((await scoped.query("SELECT family_id FROM academy_mcp_oauth_access_tokens WHERE token=$1",[hashToken(rotated.pair.access_token)])).rows[0].family_id,hashToken(access));
    // Leave the additive test namespace empty; no shared/public data is modified.
    for(const suffix of ["access_tokens","refresh_tokens","refresh_tombstones"])await scoped.query(`DELETE FROM academy_mcp_oauth_${suffix} WHERE client_id=$1`,[client]);
  } finally {__setPoolForTest(bootstrap);await scoped.end();await closeDb();}
});
