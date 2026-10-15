import {acceptanceAuth} from './acceptance-auth.mjs';
import { createConsoleServer } from "./console.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  readFileSync,
  createWriteStream,
  mkdtempSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
const root = process.cwd(),
  managementBinary = process.env.S2A_MANAGEMENT_BINARY || root + "/backend/server",
  suffix = randomBytes(5).toString("hex"),
  pg = "s2a-go-pg-" + suffix,
  redis = "s2a-go-redis-" + suffix;
const run = (args, options = {}) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30000,
    ...options,
  }).trim();
const fixtureAuth = process.env.S2A_AUTH_ACCEPTANCE_FIXTURE === '1' ? await acceptanceAuth() : null;
const local = fixtureAuth?.local ?? JSON.parse(
  execFileSync(
    process.env.SUPABASE_BIN || "supabase",
    ["status", "-o", "json"],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
  ),
);
const admin = fixtureAuth?.admin ?? (process.env.S2A_AUTH_ACCEPTANCE_EMAIL
  ? {
      SUB2API_LOCAL_ADMIN_EMAIL: process.env.S2A_AUTH_ACCEPTANCE_EMAIL,
      SUB2API_LOCAL_ADMIN_PASSWORD: process.env.S2A_AUTH_ACCEPTANCE_PASSWORD,
    }
  : JSON.parse(readFileSync(root + "/.local/admin.json")));
assert.ok(
  admin.SUB2API_LOCAL_ADMIN_PASSWORD,
  "An acceptance account password is required",
);
const login = await fetch(
  local.API_URL + "/auth/v1/token?grant_type=password",
  {
    method: "POST",
    headers: { apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      email: admin.SUB2API_LOCAL_ADMIN_EMAIL,
      password: admin.SUB2API_LOCAL_ADMIN_PASSWORD,
    }),
    signal: AbortSignal.timeout(20000),
  },
);
assert.equal(login.status, 200);
const session = await login.json();
const claims = JSON.parse(
  Buffer.from(session.access_token.split(".")[1], "base64url"),
);
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const dir = mkdtempSync(root + "/.local/go-management-"),
  log = createWriteStream(root + "/.local/go-management-acceptance.log", {
    mode: 0o600,
  });
let app;
mkdirSync(dir + "/pricing");
writeFileSync(
  dir + "/runtime.yaml",
  'pricing:\n  remote_url: ""\n  hash_url: ""\n',
  { mode: 0o600 },
);
copyFileSync(
  root +
    "/backend/resources/model-pricing/model_prices_and_context_window.json",
  dir + "/pricing/model_pricing.json",
);
const password = randomBytes(24).toString("base64url");
const environment = { ...process.env, POSTGRES_PASSWORD: password };
try {
  run(
    [
      "run",
      "--rm",
      "-d",
      "--name",
      pg,
      "-e",
      "POSTGRES_PASSWORD",
      "-p",
      "127.0.0.1::5432",
      process.env.S2A_POSTGRES_IMAGE || "postgres:18-alpine",
    ],
    { env: environment },
  );
  run([
    "run",
    "--rm",
    "-d",
    "--name",
    redis,
    "-p",
    "127.0.0.1::6379",
    "redis:8-alpine",
  ]);
  const pgPort = run(["port", pg, "5432/tcp"]).split(":").at(-1),
    redisPort = run(["port", redis, "6379/tcp"]).split(":").at(-1);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      run(["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready);
  const sql = (input) =>
    run(
      [
        "exec",
        "-i",
        pg,
        "psql",
        "-U",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { input },
    );
  sql(
    "DO $$ DECLARE name text; BEGIN FOREACH name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=name) THEN EXECUTE format('CREATE ROLE %I',name); END IF; END LOOP; END $$; ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated,service_role;",
  );
  sql(readFileSync(root + "/deploy/management-role.sql", "utf8"));
  sql(readFileSync(root + "/deploy/management-role.sql", "utf8"));
  for (const unsafeGrant of [
    "GRANT s2a_management TO anon;",
    "CREATE ROLE unsafe_fixture; GRANT unsafe_fixture TO s2a_management;",
  ]) {
    assert.throws(
      () =>
        sql(
          "BEGIN; " +
            unsafeGrant +
            readFileSync(root + "/deploy/management-role.sql", "utf8"),
        ),
      (error) =>
        error.stderr.includes(
          "must not inherit privileges or have non-administrator members",
        ),
    );
  }
  assert.equal(
    sql(
      "CREATE TABLE public.unrelated_privilege_fixture(id integer); SELECT has_table_privilege('anon','public.unrelated_privilege_fixture','SELECT'); DROP TABLE public.unrelated_privilege_fixture;",
    ).split("\n")[1],
    "t",
  );
  sql("ALTER ROLE s2a_management PASSWORD '" + password + "';");
  const migrationEnvironment = {
    ...process.env,
    SUPABASE_URL: local.API_URL,
    DATABASE_URL: `postgres://s2a_management:${password}@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
  };
  const migrate = (env) =>
    execFileSync(
      managementBinary,
      ["-migrate"],
      {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000,
      },
    );
  assert.throws(
    () =>
      migrate({
        ...migrationEnvironment,
        DATABASE_URL: `postgres://postgres:${password}@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
      }),
    (error) =>
      error.status === 1 &&
      error.stderr.includes("isolated s2a_management ownership"),
  );
  assert.equal(
    sql("SELECT to_regclass('public.schema_migrations') IS NULL"),
    "t",
  );
  migrate(migrationEnvironment);
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    sql(readFileSync(root + "/deploy/account-vault.sql", "utf8"));
    sql(readFileSync(root + "/deploy/account-vault.sql", "utf8"));
  }
  migrate(migrationEnvironment);
  app = spawn(
    managementBinary,
    [],
    {
      cwd: root + "/backend",
      env: {
        ...process.env,
        DATA_DIR: dir,
        CONFIG_FILE: dir + "/runtime.yaml",
        PRICING_DATA_DIR: dir + "/pricing",
        PRICING_HASH_URL: "",
        PRICING_REMOTE_URL: "",
        AUTO_SETUP: "true",
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(port),
        SERVER_MODE: "release",
        DATABASE_URL: migrationEnvironment.DATABASE_URL,
        DATABASE_HOST: "127.0.0.1",
        DATABASE_PORT: pgPort,
        DATABASE_USER: "s2a_management",
        DATABASE_PASSWORD: password,
        DATABASE_DBNAME: "postgres",
        DATABASE_SSLMODE: "disable",
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: redisPort,
        ADMIN_EMAIL: "go-acceptance@example.invalid",
        ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
        JWT_SECRET: randomBytes(32).toString("hex"),
        TOTP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        SUPABASE_URL: local.API_URL,
        SUPABASE_PUBLISHABLE_KEY: local.ANON_KEY,
        SUPABASE_JWT_ISSUER: claims.iss,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.pipe(log);
  app.stderr.pipe(log);
  ready = false;
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null)
      throw Error(
        "Go management exited; inspect .local/go-management-acceptance.log",
      );
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "Go health endpoint did not become ready");
  const literal = (value) => "'" + value.replace(/'/g, "''") + "'";
  run(
    [
      "exec",
      "-i",
      pg,
      "psql",
      "-U",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: `insert into auth_identities(user_id,provider_type,provider_key,provider_subject,verified_at) select id,'oidc',${literal(claims.iss)},${literal(session.user.id)},now() from users where email='go-acceptance@example.invalid';`,
    },
  );
  async function api(path, method = "GET", body, expected = 200) {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1` + path, {
      method,
      headers: {
        authorization: "Bearer " + session.access_token,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    const value = await r.json();
    assert.equal(r.status, expected, JSON.stringify(value));
    return value.data;
  }
  assert.equal(
    sql(
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND c.relowner='s2a_management'::regrole AND (has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT') OR has_table_privilege('service_role',c.oid,'SELECT'))",
    ),
    "0",
  );
  assert.equal(
    sql(
      "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner='s2a_management'::regrole AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR (p.proname NOT IN ('s2a_gateway_key_lookup','s2a_gateway_account_snapshot','s2a_gateway_refresh_acquire','s2a_gateway_refresh_save','s2a_gateway_refresh_release','s2a_gateway_privacy_save','s2a_gateway_codex_version_save') AND has_function_privilege('service_role',p.oid,'EXECUTE')))",
    ),
    "0",
  );
  const me = await api("/auth/me");
  assert.equal(me.email, "go-acceptance@example.invalid");
  assert.equal(me.role, "admin");
  await api("/settings/public");
  await api("/user/password", "PUT", { password: "unused-fixture" }, 409);
  for (const path of ["/api/v1/auth/login", "/v1/responses", "/v1/messages"]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 404, path);
    await response.body?.cancel();
  }
  await api("/admin/users", "GET", undefined, 423);
  // A synthetic acknowledgement exists only in this disposable test database.
  run(
    [
      "exec",
      "-i",
      pg,
      "psql",
      "-U",
      "postgres",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: `insert into settings(key,value) select 'admin_compliance_acknowledgement:'||id,jsonb_build_object('version','v2026.06.10','admin_user_id',id,'accepted_at',now(),'user_agent','automated-test-fixture')::text from users where email='go-acceptance@example.invalid';`,
    },
  );
  const users = await api("/admin/users");
  assert.ok(JSON.stringify(users).includes("go-acceptance@example.invalid"));
  const group = await api(
    "/admin/groups",
    "POST",
    {
      name: "Go reused management",
      platform: "openai",
      rate_multiplier: 1,
      is_exclusive: false,
    },
    200,
  );
  assert.equal(group.name, "Go reused management");
  const consoleProxy = createConsoleServer({
    config: {
      mode: "local",
      supabase_url: local.API_URL,
      publishable_key: local.ANON_KEY,
      management_url: `http://127.0.0.1:${port}`,
    },
  });
  await new Promise((resolve) => consoleProxy.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${consoleProxy.address().port}/api/v1/auth/me`,
      {
        headers: { authorization: `Bearer ${session.access_token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(response.status, 200);
    const profile = await response.json();
    assert.equal(profile.data.id, me.id);
    assert.equal(profile.data.role, "admin");
  } finally {
    consoleProxy.closeAllConnections();
    await new Promise((resolve) => consoleProxy.close(resolve));
  }
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    assert.equal(
      sql(
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='s2a_private' OR (n.nspname='public' AND p.proname LIKE 's2a_gateway_%')) AND p.prosecdef AND p.proowner <> 's2a_management'::regrole",
      ),
      "0",
    );
    assert.equal(
      sql(
        "SELECT has_schema_privilege('s2a_management','auth','USAGE') OR has_table_privilege('s2a_management','auth.users','SELECT')",
      ),
      "f",
    );
    const fixtureSecret = "synthetic-" + randomBytes(24).toString("hex");
    const account = await api("/admin/accounts", "POST", {
      name: "Vault fixture",
      platform: "openai",
      type: "apikey",
      credentials: {
        api_key: fixtureSecret,
        base_url: "https://api.example.invalid",
      },
      concurrency: 3,
      priority: 50,
      group_ids: [group.id],
    });
    sql(
      "SET ROLE s2a_management; CREATE TABLE s2a_private.runtime_role_fixture(role_name text); CREATE FUNCTION s2a_private.observe_runtime_role() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN INSERT INTO s2a_private.runtime_role_fixture VALUES(current_user); RETURN NEW; END $$; CREATE TRIGGER observe_runtime_role AFTER UPDATE ON s2a_private.accounts FOR EACH ROW EXECUTE FUNCTION s2a_private.observe_runtime_role(); RESET ROLE;",
    );
    const stored = JSON.parse(
      sql(
        `SELECT credentials::text FROM s2a_private.accounts WHERE id=${account.id}`,
      ),
    );
    assert.equal(typeof stored.s2a_vault, "string");
    assert.ok(!JSON.stringify(stored).includes(fixtureSecret));
    assert.equal(
      sql(
        `SELECT count(*) FROM vault.secrets WHERE id='${stored.s2a_vault}' AND secret LIKE '%${fixtureSecret}%'`,
      ),
      "0",
    );
    assert.equal(
      sql(
        `SET ROLE s2a_management; SELECT credentials->>'api_key' FROM public.accounts WHERE id=${account.id}; RESET ROLE;`,
      ).split("\n")[1],
      fixtureSecret,
    );
    await api(`/admin/accounts/${account.id}`, "PUT", { name: "Vault edited" });
    assert.equal(
      JSON.parse(
        sql(
          `SELECT credentials::text FROM s2a_private.accounts WHERE id=${account.id}`,
        ),
      ).s2a_vault,
      stored.s2a_vault,
    );
    const replacementSecret = "synthetic-" + randomBytes(24).toString("hex");
    await api(`/admin/accounts/${account.id}`, "PUT", {
      credentials: {
        api_key: replacementSecret,
        base_url: "https://api.example.invalid",
      },
    });
    assert.equal(
      sql(
        `SET ROLE s2a_management; SELECT credentials->>'api_key' FROM public.accounts WHERE id=${account.id}; RESET ROLE;`,
      ).split("\n")[1],
      replacementSecret,
    );
    assert.equal(
      sql(`SELECT count(*) FROM vault.secrets WHERE id='${stored.s2a_vault}'`),
      "0",
    );
    const holder = spawn(
      "docker",
      [
        "exec",
        "-i",
        pg,
        "psql",
        "-U",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const holderDone = new Promise((resolve, reject) => {
      holder.once("exit", resolve);
      holder.once("error", reject);
    });
    holder.stderr.resume();
    const locked = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Vault lock fixture timed out")),
        10000,
      );
      let output = "";
      holder.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("fixture_locked")) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    holder.stdin.write(
      `BEGIN; SELECT id FROM s2a_private.accounts WHERE id=${account.id} FOR UPDATE;\n\\echo fixture_locked\n`,
    );
    await locked;
    const contender = spawn(
      "docker",
      [
        "exec",
        "-i",
        pg,
        "psql",
        "-U",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let contenderError = "";
    contender.stderr.on("data", (chunk) => {
      contenderError += chunk;
    });
    const contenderDone = new Promise((resolve, reject) => {
      contender.once("exit", resolve);
      contender.once("error", reject);
    });
    contender.stdin.end(
      `SET application_name='s2a-vault-cas'; SET ROLE s2a_management; UPDATE public.accounts SET credentials='{"api_key":"stale-synthetic-value"}'::jsonb WHERE id=${account.id};`,
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (
        sql(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='s2a-vault-cas' AND wait_event_type='Lock'",
        ) === "1"
      ) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      waiting,
      "Concurrent credential write did not reach the row lock",
    );
    holder.stdin.end(
      `SET ROLE s2a_management; UPDATE public.accounts SET credentials='{"api_key":"winning-synthetic-value"}'::jsonb WHERE id=${account.id}; COMMIT;`,
    );
    assert.equal(await holderDone, 0);
    assert.notEqual(await contenderDone, 0);
    assert.match(contenderError, /Account changed concurrently/);
    assert.equal(
      sql(
        `SET ROLE s2a_management; SELECT credentials->>'api_key' FROM public.accounts WHERE id=${account.id}; RESET ROLE;`,
      ).split("\n")[1],
      "winning-synthetic-value",
    );
    const rpc = (name, args) =>
      sql(
        `SET ROLE service_role; SELECT public.${name}(${args})::text; RESET ROLE;`,
      ).split("\n")[1];
    sql(
      `UPDATE public.accounts SET type='oauth',credentials='{"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}'::jsonb WHERE id=${account.id}`,
    );
    const snapshot = JSON.parse(
      rpc("s2a_gateway_account_snapshot", String(account.id)),
    );
    assert.equal(snapshot.credentials.access_token, "synthetic-access");
    const lockA = crypto.randomUUID(),
      lockB = crypto.randomUUID();
    const lockArgs = `${account.id},${snapshot.credential_version}`;
    assert.equal(
      rpc("s2a_gateway_refresh_acquire", `${lockArgs},'${lockA}'`),
      "true",
    );
    assert.equal(
      rpc("s2a_gateway_refresh_acquire", `${lockArgs},'${lockB}'`),
      "false",
    );
    assert.equal(
      rpc(
        "s2a_gateway_refresh_save",
        `${lockArgs},'${lockB}','{"access_token":"wrong-owner"}'::jsonb`,
      ),
      "false",
    );
    assert.equal(
      rpc(
        "s2a_gateway_refresh_save",
        `${lockArgs},'${lockA}','{"access_token":"refreshed-synthetic","refresh_token":"rotated-synthetic"}'::jsonb`,
      ),
      "true",
    );
    assert.equal(
      rpc(
        "s2a_gateway_refresh_save",
        `${lockArgs},'${lockA}','{"access_token":"stale-owner"}'::jsonb`,
      ),
      "false",
    );
    const refreshed = JSON.parse(
      rpc("s2a_gateway_account_snapshot", String(account.id)),
    );
    assert.equal(refreshed.credential_storage, "vault");
    const privacyArgs = `${account.id},${refreshed.credential_version}`;
    assert.equal(
      rpc(
        "s2a_gateway_privacy_save",
        `${account.id},${snapshot.credential_version},NULL,'training_off'`,
      ),
      "false",
    );
    assert.equal(
      rpc("s2a_gateway_privacy_save", `${privacyArgs},NULL,'invalid'`),
      "false",
    );
    assert.equal(
      rpc(
        "s2a_gateway_privacy_save",
        `${privacyArgs},'stale-mode','training_off'`,
      ),
      "false",
    );
    assert.equal(
      rpc("s2a_gateway_privacy_save", `${privacyArgs},NULL,'training_off'`),
      "true",
    );
    const privacySaved = JSON.parse(
      rpc("s2a_gateway_account_snapshot", String(account.id)),
    );
    assert.equal(privacySaved.privacy_mode, "training_off");
    assert.equal(privacySaved.credential_version, refreshed.credential_version);
    assert.deepEqual(privacySaved.credentials, refreshed.credentials);
    assert.equal(
      rpc("s2a_gateway_privacy_save", `${privacyArgs},NULL,'failed'`),
      "false",
    );
    assert.equal(refreshed.credential_version, snapshot.credential_version + 1);
    const managedAccount = await api(`/admin/accounts/${account.id}`);
    assert.equal(managedAccount.type, "oauth");
    assert.equal(managedAccount.credentials_status.has_access_token, true);
    assert.equal(managedAccount.credentials_status.has_refresh_token, true);
    assert.ok(!JSON.stringify(managedAccount).includes("refreshed-synthetic"));
    assert.equal(
      rpc(
        "s2a_gateway_refresh_acquire",
        `${account.id},${refreshed.credential_version},'${lockA}'`,
      ),
      "true",
    );
    await api(`/admin/accounts/${account.id}`, "PUT", {
      credentials: {
        access_token: "reauthorized-synthetic",
        refresh_token: "reauthorized-refresh",
      },
    });
    assert.equal(
      rpc(
        "s2a_gateway_refresh_save",
        `${account.id},${refreshed.credential_version},'${lockA}','{"access_token":"stale-after-reauthorization"}'::jsonb`,
      ),
      "false",
    );
    assert.equal(
      JSON.parse(rpc("s2a_gateway_account_snapshot", String(account.id)))
        .credentials.access_token,
      "reauthorized-synthetic",
    );
    assert.equal(
      sql(
        "SELECT count(*) > 0 AND bool_and(role_name='s2a_management') FROM s2a_private.runtime_role_fixture",
      ),
      "t",
    );
    const beforeBulk = JSON.parse(
      rpc("s2a_gateway_account_snapshot", String(account.id)),
    );
    await api("/admin/accounts/bulk-update", "POST", {
      account_ids: [account.id],
      priority: 23,
      extra: { acceptance_marker: "vault-bulk" },
    });
    const afterBulk = JSON.parse(
      rpc("s2a_gateway_account_snapshot", String(account.id)),
    );
    assert.deepEqual(afterBulk.credentials, beforeBulk.credentials);
    assert.equal(afterBulk.credential_version, beforeBulk.credential_version);
    assert.equal((await api(`/admin/accounts/${account.id}`)).priority, 23);
    const filteredAccounts = await api(
      "/admin/accounts?platform=openai&type=oauth&search=Vault",
    );
    assert.ok(JSON.stringify(filteredAccounts).includes("Vault edited"));
    assert.ok(
      !JSON.stringify(filteredAccounts).includes("reauthorized-synthetic"),
    );
  }
  sql(readFileSync(root + "/deploy/gateway-proxy.sql", "utf8"));
  sql(readFileSync(root + "/deploy/gateway-proxy.sql", "utf8"));
  sql(`BEGIN;
    SET LOCAL ROLE s2a_management;
    INSERT INTO public.proxies(id,name,protocol,host,port,password,expires_at,fallback_mode,backup_proxy_id)
    VALUES (900001,'route source','http','source.example',8080,'synthetic',now()-interval '1 day','proxy',900002),
           (900002,'route backup','socks5h','backup.example',1080,NULL,NULL,'none',NULL);
    DO $$ BEGIN
      IF (public.s2a_gateway_proxy_route(900001)->'proxy'->>'host') <> 'backup.example' THEN RAISE EXCEPTION 'backup route mismatch'; END IF;
      IF (public.s2a_gateway_proxy_route(900001)->'proxy'->>'password') <> '' THEN RAISE EXCEPTION 'empty password mismatch'; END IF;
      UPDATE public.proxies SET expires_at=now()-interval '1 day',fallback_mode='proxy',backup_proxy_id=900001 WHERE id=900002;
      IF (public.s2a_gateway_proxy_route(900001)->'proxy'->>'host') <> 'source.example' THEN RAISE EXCEPTION 'cycle fallback mismatch'; END IF;
      UPDATE public.proxies SET fallback_mode='direct' WHERE id=900002;
      IF public.s2a_gateway_proxy_route(900001)->'proxy' <> 'null'::jsonb THEN RAISE EXCEPTION 'direct fallback mismatch'; END IF;
      UPDATE public.proxies SET status='inactive' WHERE id=900001;
      IF public.s2a_gateway_proxy_route(900001)->>'error' <> 'proxy_inactive' THEN RAISE EXCEPTION 'inactive proxy accepted'; END IF;
      UPDATE public.proxies SET deleted_at=now() WHERE id=900001;
      IF public.s2a_gateway_proxy_route(900001)->>'error' <> 'proxy_not_found' THEN RAISE EXCEPTION 'deleted proxy accepted'; END IF;
      IF has_function_privilege('authenticated','public.s2a_gateway_proxy_route(bigint)','EXECUTE')
        OR has_function_privilege('anon','public.s2a_gateway_proxy_route(bigint)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_proxy_route(bigint)','EXECUTE') THEN RAISE EXCEPTION 'proxy ACL mismatch'; END IF;
    END $$;
    ROLLBACK;`);
  sql(readFileSync(root + "/deploy/gateway-pricing.sql", "utf8"));
  sql(readFileSync(root + "/deploy/gateway-pricing.sql", "utf8"));
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    sql(readFileSync(root + "/deploy/personal-gateway.sql", "utf8"));
    sql(readFileSync(root + "/deploy/personal-gateway.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gemini-cache-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gemini-cache-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/tests/gemini-cache-scheduler.database.sql", "utf8"));
    sql(readFileSync(root + "/deploy/image-tasks.sql", "utf8"));
    sql(readFileSync(root + "/deploy/image-tasks.sql", "utf8"));
    sql(readFileSync(root + "/tests/image-tasks.database.sql", "utf8"));
    sql(readFileSync(root + "/deploy/batch-image-runtime.sql", "utf8"));
    sql(readFileSync(root + "/deploy/batch-image-runtime.sql", "utf8"));
    sql(readFileSync(root + "/tests/batch-image-runtime.database.sql", "utf8"));
    sql(readFileSync(root + "/deploy/image-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/deploy/image-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/tests/image-scheduler.database.sql", "utf8"));
    sql(readFileSync(root + "/deploy/batch-image-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/deploy/batch-image-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/tests/batch-image-scheduler.database.sql", "utf8"));
    sql(readFileSync(root + "/deploy/usage-access.sql", "utf8"));
    sql(readFileSync(root + "/deploy/usage-access.sql", "utf8"));
    sql(readFileSync(root + "/tests/usage-access.database.sql", "utf8"));
  }
  sql(readFileSync(root + "/deploy/gateway-admission.sql", "utf8"));
  assert.equal(
    sql(
      "SELECT s2a_private.gateway_subscription_window('2026-01-01 00:00+00','2026-01-01 10:00+00','2026-01-08 05:00+00',604800,'2026-01-08 03:00+00','UTC') = '2026-01-01 00:00+00'::timestamptz",
    ),
    "t",
  );
  assert.equal(
    sql(
      "SELECT s2a_private.gateway_subscription_window('2026-01-01 00:00+00','2026-01-01 10:00+00','2026-01-30 05:00+00',604800,'2026-01-16 12:00+00','UTC') = '2026-01-15 10:00+00'::timestamptz",
    ),
    "t",
  );
  assert.equal(
    sql(
      "SELECT s2a_private.gateway_subscription_window('2026-03-01 00:00-05','2026-03-01 12:00-05','2026-04-30 05:00+00',604800,'2026-03-09 12:00-04','America/New_York') = '2026-03-08 13:00-04'::timestamptz",
    ),
    "t",
  );
  const managedKey = await api("/keys", "POST", {
    name: "Shared gateway fixture",
    group_id: group.id,
  });
  assert.equal(typeof managedKey.key, "string");
  const keyHash = createHash("sha256").update(managedKey.key).digest("hex");
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    sql(`SELECT set_config('s2a.acceptance.user_id','${me.id}',false),set_config('s2a.acceptance.key_id','${managedKey.id}',false);`+readFileSync(root+"/tests/personal-gateway.database.sql","utf8"));
  }
  if (process.env.S2A_ACCOUNT_VAULT === "1" && process.env.S2A_PERSONAL_HTTP === "1") {
    const personalGroup=await api("/admin/groups","POST",{name:"Personal HTTP contract",platform:"openai",rate_multiplier:1,is_exclusive:false});
    const personalKey=await api("/keys","POST",{name:"Personal HTTP contract",group_id:personalGroup.id});
    const personalAccount=await api("/admin/accounts","POST",{name:"Personal HTTP contract",platform:"openai",type:"apikey",credentials:{api_key:"synthetic-personal-token",base_url:"https://api.openai.com",model_mapping:{"personal-alias":"gpt-5.4"}},concurrency:1,priority:0,rate_multiplier:1,group_ids:[personalGroup.id]});
    sql(`UPDATE users SET balance=0 WHERE id=${me.id}`);
    execFileSync(process.env.DENO_BIN || "deno",["run","--allow-read","--allow-run=docker",root+"/tests/personal-gateway.contract.mjs"],{cwd:root,input:JSON.stringify({container:pg,key:personalKey.key}),encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:60000});
    const rows=await api(`/usage?api_key_id=${personalKey.id}`);
    assert.equal(rows.items.length,2);
    assert.ok(rows.items.every(row=>row.account_id===personalAccount.id && row.input_tokens===100 && row.output_tokens===20 && row.cache_read_tokens===40 && row.actual_cost===0));
    assert.equal(sql(`SELECT balance=0 FROM users WHERE id=${me.id}`),"t");
    assert.equal(sql(`SELECT count(*) FROM s2a_private.personal_gateway_leases WHERE account_id=${personalAccount.id} AND finished_at IS NULL`),"0");
  }
  const lookup = () =>
    JSON.parse(
      sql(
        `SET ROLE service_role; SELECT public.s2a_gateway_key_lookup('${keyHash}')::text; RESET ROLE;`,
      ).split("\n")[1],
    );
  const identity = lookup();
  assert.equal(identity.key_id, String(managedKey.id));
  assert.equal(identity.group_id, String(group.id));
  assert.equal(identity.user_id, String(me.id));
  sql(`UPDATE users SET balance=5,concurrency=1,rpm_limit=0 WHERE id=${me.id}`);
  const admit = (
    requestId = crypto.randomUUID(),
    model = "gpt-test",
    ip = "192.0.2.8",
  ) =>
    JSON.parse(
      sql(
        `SET ROLE service_role; SELECT public.s2a_gateway_key_admit('${keyHash}','${requestId}','${model}',${ip === null ? "NULL" : "'" + ip + "'"})::text; RESET ROLE;`,
      ).split("\n")[1],
    );
  const leaseId = crypto.randomUUID();
  const admitted = admit(leaseId);
  assert.equal(admitted.lease_id, leaseId);
  assert.equal(admitted.key_id, String(managedKey.id));
  assert.deepEqual(admit(leaseId), admitted);
  assert.equal(admit(leaseId, "different").error, "request_conflict");
  assert.equal(admit().error, "user_concurrency_exceeded");
  const releaseKeyLease = () =>
    sql(
      `SET ROLE service_role; SELECT public.s2a_gateway_key_release('${leaseId}'); RESET ROLE;`,
    ).split("\n")[1];
  assert.equal(releaseKeyLease(), "t");
  assert.equal(releaseKeyLease(), "f");
  assert.equal(admit(leaseId).error, "request_lease_expired");
  sql(`UPDATE users SET concurrency=0,balance=0 WHERE id=${me.id}`);
  assert.equal(admit().error, "insufficient_balance");
  sql(
    `UPDATE users SET balance=5 WHERE id=${me.id}; UPDATE api_keys SET quota=1,quota_used=1 WHERE id=${managedKey.id}`,
  );
  assert.equal(admit().error, "api_key_quota_exceeded");
  sql(
    `UPDATE api_keys SET quota=0,quota_used=0,rate_limit_5h=1,usage_5h=1,window_5h_start=now() WHERE id=${managedKey.id}`,
  );
  assert.equal(admit().error, "api_key_rate_5h_exceeded");
  sql(
    `UPDATE api_keys SET window_5h_start=now()-interval '6 hours' WHERE id=${managedKey.id}`,
  );
  assert.ok(admit().lease_id);
  sql(
    `UPDATE api_keys SET rate_limit_5h=0,ip_whitelist='["192.0.2.0/24"]',ip_blacklist='["192.0.2.99"]' WHERE id=${managedKey.id}`,
  );
  assert.equal(admit(undefined, "gpt-test", null).error, "ip_forbidden");
  assert.equal(
    admit(undefined, "gpt-test", "198.51.100.1").error,
    "ip_forbidden",
  );
  assert.equal(
    admit(undefined, "gpt-test", "192.0.2.99").error,
    "ip_forbidden",
  );
  assert.equal(
    admit(undefined, "gpt-test", "192.0.2.0/24").error,
    "invalid_client_ip",
  );
  assert.ok(admit().lease_id);
  sql(
    `UPDATE api_keys SET ip_whitelist='["2001:db8::/32"]',ip_blacklist='[]' WHERE id=${managedKey.id}`,
  );
  assert.ok(admit(undefined, "gpt-test", "2001:db8::8").lease_id);
  sql(
    `UPDATE api_keys SET ip_whitelist='[]',ip_blacklist='[]' WHERE id=${managedKey.id}; UPDATE groups SET model_allowlist='{"enabled":true,"models":["GPT-*"]}' WHERE id=${group.id}`,
  );
  assert.equal(admit(undefined, "claude-test").error, "model_not_allowed");
  assert.ok(admit().lease_id);
  // Refresh fixture requests and evaluate the fixed-minute limit atomically.
  const rateLimitError = () => JSON.parse(sql(`
    BEGIN;
    UPDATE s2a_private.gateway_requests SET admitted_at=now() WHERE user_id=${me.id};
    SET LOCAL ROLE service_role;
    SELECT public.s2a_gateway_key_admit('${keyHash}',gen_random_uuid(),'gpt-test','192.0.2.8');
    COMMIT;
  `).split('\n').find(line=>line.startsWith('{'))).error;
  sql(
    `UPDATE groups SET model_allowlist='{}',rpm_limit=1 WHERE id=${group.id}`,
  );
  assert.equal(rateLimitError(), "group_rate_limit_exceeded");
  sql(
    `INSERT INTO user_group_rate_multipliers(user_id,group_id,rpm_override) VALUES(${me.id},${group.id},0) ON CONFLICT(user_id,group_id) DO UPDATE SET rpm_override=0; UPDATE users SET rpm_limit=1 WHERE id=${me.id}`,
  );
  assert.equal(rateLimitError(), "rate_limit_exceeded");
  sql(
    `UPDATE users SET rpm_limit=0 WHERE id=${me.id}; UPDATE groups SET rpm_limit=0 WHERE id=${group.id}`,
  );
  assert.ok(admit().lease_id);
  assert.equal(
    sql(
      "SELECT has_function_privilege('anon','public.s2a_gateway_key_admit(text,uuid,text,text,text)','EXECUTE') OR has_function_privilege('authenticated','public.s2a_gateway_key_admit(text,uuid,text,text,text)','EXECUTE')",
    ),
    "f",
  );
  assert.equal(
    sql("SELECT has_schema_privilege('service_role','s2a_private','USAGE')"),
    "f",
  );

  sql(
    `UPDATE groups SET subscription_type='subscription',daily_limit_usd=1 WHERE id=${group.id}`,
  );
  assert.equal(admit().error, "subscription_unavailable");
  const subscriptionId = sql(
    `INSERT INTO user_subscriptions(user_id,group_id,starts_at,expires_at,status,daily_window_start,weekly_window_start,monthly_window_start,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,created_at,updated_at,assigned_at) VALUES(${me.id},${group.id},now()-interval '40 days',now()+interval '60 days','active',now(),now(),now(),2,0,0,now(),now(),now()) RETURNING id`,
  ).split("\n")[0];
  assert.equal(admit().error, "subscription_quota_exceeded");
  sql(
    `UPDATE user_subscriptions SET daily_window_start=now()-interval '2 days',weekly_window_start=now()-interval '15 days',monthly_window_start=now()-interval '35 days',weekly_usage_usd=3,monthly_usage_usd=4 WHERE id=${subscriptionId}`,
  );
  const subscriptionLease = admit();
  assert.equal(subscriptionLease.subscription_id, subscriptionId);
  const exemptQuotaId = sql(
    `INSERT INTO user_platform_quotas(user_id,platform,daily_limit_usd,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,created_at,updated_at) VALUES(${me.id},'openai',0,0,0,0,now(),now()) RETURNING id`,
  ).split("\n")[0];
  assert.ok(admit().lease_id);
  sql(
    `UPDATE user_platform_quotas SET deleted_at=now() WHERE id=${exemptQuotaId}`,
  );
  assert.equal(
    sql(
      `SELECT daily_usage_usd=0 AND weekly_usage_usd=0 AND monthly_usage_usd=0 FROM user_subscriptions WHERE id=${subscriptionId}`,
    ),
    "t",
  );
  sql(
    `UPDATE user_subscriptions SET starts_at=now()-interval '12 hours',expires_at=now()+interval '12 hours',daily_usage_usd=2,daily_window_start=now()-interval '2 days' WHERE id=${subscriptionId}`,
  );
  assert.equal(admit().error, "subscription_quota_exceeded");
  sql(
    `UPDATE user_subscriptions SET status='suspended' WHERE id=${subscriptionId}`,
  );
  assert.equal(admit().error, "subscription_unavailable");
  sql(
    `UPDATE groups SET subscription_type='standard',daily_limit_usd=NULL WHERE id=${group.id}`,
  );
  const platformQuotaId = sql(
    `INSERT INTO user_platform_quotas(user_id,platform,daily_limit_usd,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,created_at,updated_at) VALUES(${me.id},'openai',0,0,0,0,now(),now()) RETURNING id`,
  ).split("\n")[0];
  assert.equal(admit().error, "platform_quota_exceeded");
  sql(
    `UPDATE user_platform_quotas SET daily_limit_usd=1,daily_usage_usd=2,daily_window_start=now() WHERE id=${platformQuotaId}`,
  );
  assert.equal(admit().error, "platform_quota_exceeded");
  sql(
    `UPDATE user_platform_quotas SET daily_window_start=now()-interval '2 days' WHERE id=${platformQuotaId}`,
  );
  assert.ok(admit().lease_id);
  assert.equal(
    sql(
      `SELECT daily_usage_usd=0 FROM user_platform_quotas WHERE id=${platformQuotaId}`,
    ),
    "t",
  );
  sql(
    `UPDATE user_platform_quotas SET deleted_at=now() WHERE id=${platformQuotaId}; UPDATE users SET concurrency=1 WHERE id=${me.id}; UPDATE s2a_private.gateway_requests SET finished_at=now()`,
  );
  const concurrentSQL = (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "-i",
          pg,
          "psql",
          "-U",
          "postgres",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (error += chunk));
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve(
              JSON.parse(
                output.split("\n").find((line) => line.startsWith("{")),
              ),
            )
          : reject(Error(error)),
      );
      child.stdin.end(input);
    });
  const racing = await Promise.all(
    Array.from({ length: 4 }, () =>
      concurrentSQL(
        `SET statement_timeout='10s'; SET ROLE service_role; SELECT public.s2a_gateway_key_admit('${keyHash}','${crypto.randomUUID()}','gpt-test','192.0.2.8')::text;`,
      ),
    ),
  );
  assert.equal(racing.filter((result) => result.lease_id).length, 1);
  assert.equal(
    racing.filter((result) => result.error === "user_concurrency_exceeded")
      .length,
    3,
  );
  sql(readFileSync(root + "/deploy/gateway-billing.sql", "utf8"));
  sql(readFileSync(root + "/deploy/gateway-billing.sql", "utf8"));
  sql(
    `SELECT set_config('s2a.acceptance.user_id','${me.id}',false),set_config('s2a.acceptance.key_id','${managedKey.id}',false),set_config('s2a.acceptance.group_id','${group.id}',false);` +
      readFileSync(root + "/tests/native-billing.database.sql", "utf8"),
  );
  const pricingContract = sql(
    `SELECT set_config('s2a.acceptance.user_id','${me.id}',false),set_config('s2a.acceptance.key_id','${managedKey.id}',false),set_config('s2a.acceptance.group_id','${group.id}',false);` +
      readFileSync(root + "/tests/native-pricing.database.sql", "utf8"),
  ).split("\n").find((line) => line.startsWith("[{"));
  assert.ok(pricingContract, "native pricing snapshot fixture returned a contract");
  const billingRaceId = crypto.randomUUID();
  sql(`INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES('${billingRaceId}',${managedKey.id},${me.id},${group.id},repeat('b',64),'{"subscription_type":"standard","rate_multiplier":"1","platform":"openai"}',now());`);
  const balanceBeforeRace = sql(
    `SELECT balance::text FROM users WHERE id=${me.id}`,
  );
  const charges = await Promise.all(
    Array.from({ length: 4 }, () =>
      concurrentSQL(
        `SET statement_timeout='10s'; SET ROLE s2a_management; SELECT s2a_private.gateway_charge_user('${billingRaceId}',0.25,repeat('a',64))::text;`,
      ),
    ),
  );
  assert.equal(charges.filter((result) => result.applied === true).length, 1);
  assert.equal(charges.filter((result) => result.applied === false).length, 3);
  assert.equal(
    sql(
      `SELECT balance = '${balanceBeforeRace}'::numeric - 0.25 FROM users WHERE id=${me.id}`,
    ),
    "t",
  );
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    sql(readFileSync(root + "/deploy/gateway-accounts.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gateway-accounts.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gateway-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gateway-scheduler.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gateway-finish.sql", "utf8"));
    sql(readFileSync(root + "/deploy/gateway-finish.sql", "utf8"));
    sql(
      `SELECT set_config('s2a.acceptance.user_id','${me.id}',false),set_config('s2a.acceptance.key_id','${managedKey.id}',false),set_config('s2a.acceptance.group_id','${group.id}',false);` +
        readFileSync(root + "/tests/native-finish.database.sql", "utf8"),
    );
    sql(
      `SELECT set_config('s2a.acceptance.user_id','${me.id}',false),set_config('s2a.acceptance.key_id','${managedKey.id}',false),set_config('s2a.acceptance.group_id','${group.id}',false);` +
        readFileSync(root + "/tests/native-accounts.database.sql", "utf8")+
      readFileSync(root + "/tests/native-scheduler.database.sql", "utf8")+
      readFileSync(root + "/tests/native-route.database.sql", "utf8"),
    );
    const slotAccount = sql(`SET ROLE s2a_management;
      INSERT INTO public.accounts(name,platform,type,credentials,concurrency,extra) VALUES('Cross-user slot fixture','openai','apikey','{"api_key":"synthetic-race-key"}',1,'{"quota_limit":10,"quota_used":0}') RETURNING id; RESET ROLE;`)
      .split("\n")
      .find((line) => /^\d+$/.test(line));
    assert.ok(slotAccount);
    sql(
      `SET ROLE s2a_management; INSERT INTO public.account_groups(account_id,group_id) VALUES(${slotAccount},${group.id}); RESET ROLE;`,
    );
    const slotRequests = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const requestId of slotRequests) {
      const rawKey = "sk-slot-" + randomBytes(16).toString("hex");
      sql(`SET ROLE s2a_management;
        WITH added AS (INSERT INTO public.users(email,password_hash,balance) VALUES('slot-${requestId}@example.invalid','disabled-synthetic-password',5) RETURNING id)
        INSERT INTO public.api_keys(user_id,key,name,group_id) SELECT id,'${rawKey}','Slot fixture',${group.id} FROM added;
        RESET ROLE;`);
      const hash = createHash("sha256").update(rawKey).digest("hex");
      const admitted = JSON.parse(
        sql(
          `SET ROLE service_role; SELECT public.s2a_gateway_key_admit('${hash}','${requestId}','gpt-test','192.0.2.8')::text; RESET ROLE;`,
        ).split("\n")[1],
      );
      assert.equal(admitted.lease_id, requestId);
    }
    const slots = await Promise.all(
      slotRequests.map((requestId) =>
        concurrentSQL(
          `SET statement_timeout='10s'; SET ROLE service_role; SELECT public.s2a_gateway_account_reserve('${requestId}',${slotAccount},1)::text;`,
        ),
      ),
    );
    assert.equal(slots.filter((result) => result.lease_id).length, 1);
    assert.equal(
      slots.filter((result) => result.error === "account_concurrency_exceeded")
        .length,
      3,
    );
    assert.equal(
      sql(
        `SELECT count(*) FROM s2a_private.gateway_account_leases WHERE account_id=${slotAccount} AND released_at IS NULL`,
      ),
      "1",
    );
    const winningLease = slots.find((result) => result.lease_id).lease_id;
    const accountCharges = await Promise.all(
      Array.from({ length: 4 }, () =>
        concurrentSQL(
          `SET statement_timeout='10s'; SET ROLE s2a_management; SELECT s2a_private.gateway_charge_account('${winningLease}',0.25)::text;`,
        ),
      ),
    );
    assert.equal(
      accountCharges.filter((result) => result.applied === true).length,
      1,
    );
    assert.equal(
      accountCharges.filter((result) => result.applied === false).length,
      3,
    );
    assert.equal(
      sql(
        `SELECT (extra->>'quota_used')::numeric=0.25 FROM s2a_private.accounts WHERE id=${slotAccount}`,
      ),
      "t",
    );
  }
  sql(`UPDATE users SET concurrency=0 WHERE id=${me.id}`);
  if (process.env.S2A_ACCOUNT_VAULT === "1") {
    const finishAccount = sql(
      `SELECT id FROM s2a_private.accounts WHERE name='Cross-user slot fixture'`,
    ).trim();
    sql(
      `UPDATE s2a_private.gateway_account_leases SET released_at=clock_timestamp() WHERE account_id=${finishAccount};`,
    );
    const finishRequest = crypto.randomUUID();
    assert.equal(admit(finishRequest).lease_id, finishRequest);
    const reservation = await concurrentSQL(
      `SET ROLE service_role; SELECT public.s2a_gateway_account_reserve('${finishRequest}',${finishAccount},1)::text;`,
    );
    assert.ok(reservation.lease_id);
    const beforeFinish = sql(
      `SELECT balance::text FROM users WHERE id=${me.id}`,
    );
    const completions = await Promise.all(
      Array.from({ length: 4 }, () =>
        concurrentSQL(
          `SET statement_timeout='10s'; SET ROLE service_role; SELECT public.s2a_gateway_finish('${reservation.lease_id}',200,'completed','{"input":42,"output":7,"cacheCreation":0,"cacheRead":0,"firstTokenMs":5,"durationMs":20,"stream":true}','{"input":"0.125","output":0,"cacheCreation":0,"cacheRead":0}')::text;`,
        ),
      ),
    );
    assert.equal(
      completions.filter((result) => result.applied === true).length,
      1,
    );
    assert.equal(
      completions.filter((result) => result.applied === false).length,
      3,
    );
    const finished = completions.find((result) => result.applied === true);
    assert.equal(
      sql(
        `SELECT balance='${beforeFinish}'::numeric-0.125 FROM users WHERE id=${me.id}`,
      ),
      "t",
    );
    assert.equal(
      sql(
        `SELECT count(*) FROM usage_logs WHERE request_id='${finishRequest}'`,
      ),
      "1",
    );
    assert.equal(sql(`SELECT samples=1 AND error_rate=0 AND ttft_ms=5 FROM s2a_private.gateway_account_stats WHERE account_id=${finishAccount}`),"t");
    const usage = await api(`/usage/${finished.usage_log_id}`);
    assert.equal(usage.request_id, finishRequest);
    assert.equal(usage.input_tokens, 42);
    assert.equal(usage.output_tokens, 7);
    assert.equal(usage.actual_cost, 0.125);
    assert.ok(!JSON.stringify(usage).includes("synthetic-race-key"));
  }
  await api(`/keys/${managedKey.id}`, "PUT", { status: "inactive" });
  assert.equal(lookup().error, "invalid_api_key");
  await api(`/keys/${managedKey.id}`, "PUT", { status: "active" });
  assert.equal(lookup().key_id, String(managedKey.id));
  await api(`/admin/groups/${group.id}`, "PUT", { status: "inactive" });
  assert.equal(lookup().error, "group_unavailable");
  await api(`/admin/groups/${group.id}`, "PUT", { status: "active" });
  assert.equal(lookup().key_id, String(managedKey.id));
  sql(`UPDATE users SET status='disabled' WHERE id=${me.id}`);
  assert.equal(lookup().error, "user_disabled");
  sql(
    `UPDATE users SET status='active',restrict_public_groups=true WHERE id=${me.id}`,
  );
  assert.equal(lookup().error, "group_forbidden");
  sql(
    `INSERT INTO user_allowed_groups(user_id,group_id) VALUES(${me.id},${group.id})`,
  );
  assert.equal(lookup().key_id, String(managedKey.id));
  sql(
    `UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=${managedKey.id}`,
  );
  assert.equal(lookup().error, "invalid_api_key");
  sql(`UPDATE api_keys SET expires_at=NULL WHERE id=${managedKey.id}`);
  assert.equal(lookup().key_id, String(managedKey.id));
  const replacementKey = "sk-" + randomBytes(24).toString("hex");
  sql(`UPDATE api_keys SET key='${replacementKey}' WHERE id=${managedKey.id}`);
  assert.equal(lookup().error, "invalid_api_key");
  const replacementHash = createHash("sha256")
    .update(replacementKey)
    .digest("hex");
  assert.equal(
    JSON.parse(
      sql(
        `SET ROLE service_role; SELECT public.s2a_gateway_key_lookup('${replacementHash}')::text; RESET ROLE;`,
      ).split("\n")[1],
    ).key_id,
    String(managedKey.id),
  );
  const proxy = await api(
    "/admin/proxies",
    "POST",
    {
      name: "Go reused proxy",
      protocol: "http",
      host: "proxy.example.invalid",
      port: 8080,
    },
    200,
  );
  assert.equal(proxy.name, "Go reused proxy");
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/admin/users`, {
    headers: { "x-api-key": "legacy-key" },
  });
  assert.equal(r.status, 401);
  console.log(
    "Go management acceptance passed: isolated migrations, private objects, Supabase identity, management CRUD, public settings, personal cloud acquisition and zero-cost raw usage, native key admission, enabled-account usage access and isolation, frozen native pricing snapshots, subscription windows, platform quotas, concurrent request leases, atomic billing and replay protection, cross-user account slots, atomic finish with native usage reporting, disabled native identity/gateway routes.",
  );
} finally {
  if (app && app.exitCode === null) {
    const done = new Promise((resolve) => app.once("exit", resolve));
    app.kill("SIGTERM");
    await Promise.race([
      done,
      new Promise((resolve) =>
        setTimeout(() => {
          app.kill("SIGKILL");
          resolve();
        }, 7000),
      ),
    ]);
  }
  log.end();
  for (const name of [redis, pg])
    try {
      run(["rm", "-f", name]);
    } catch {}
  rmSync(dir, { recursive: true, force: true });
  await fixtureAuth?.close();
}
