import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AiAccounts } from "../../src/ai-accounts.mjs";
import { agyAdapter, claudeAdapter, codexAdapter, createKiroAdapter, kiroAdapter as liveKiroAdapter } from "../../src/ai-account-adapters.mjs";

// Every fake token carries this marker, so a test can prove no credential
// leaves the files it lives in.
export const SECRET = "SECRET-TOKEN-MARKER";

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

export async function writeClaude(location, { uuid, email, token }) {
  await mkdir(join(location.credentials, ".."), { recursive: true });
  await writeFile(location.credentials, JSON.stringify({
    claudeAiOauth: {
      accessToken: `${SECRET}-access-${token}`,
      refreshToken: `${SECRET}-refresh-${token}`,
      expiresAt: 1,
      refreshTokenExpiresAt: 1_791_637_930_746,
      subscriptionType: "max",
    },
  }), { mode: 0o600 });
  let global = {};
  try { global = JSON.parse(await readFile(location.global, "utf8")); } catch {}
  await writeFile(location.global, JSON.stringify({
    ...global,
    oauthAccount: { accountUuid: uuid, emailAddress: email, organizationName: `${email} org` },
  }), { mode: 0o600 });
}

export async function writeCodex(location, { accountId, email, token }) {
  await mkdir(join(location.auth, ".."), { recursive: true });
  await writeFile(location.auth, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: `${SECRET}-access-${token}`,
      refresh_token: `${SECRET}-refresh-${token}`,
      account_id: accountId,
      id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: accountId } }),
    },
  }), { mode: 0o600 });
}

// Antigravity's token file, as agy 1.4.12 writes it when there is no keyring:
// whose account it is in id_token_email.
export async function writeAgy(location, { email, token, idToken } = {}) {
  await mkdir(join(location.token, ".."), { recursive: true });
  await writeFile(location.token, JSON.stringify({
    token: {
      access_token: `${SECRET}-access-${token}`,
      token_type: "Bearer",
      refresh_token: `${SECRET}-refresh-${token}`,
      expiry: "2026-11-02T09:58:54Z",
      expires_in: 3599,
      ...(idToken ? { id_token: jwt(idToken) } : {}),
    },
    auth_method: "consumer",
    ...(email ? { id_token_email: email } : {}),
  }), { mode: 0o600 });
}

// Kiro CLI keeps its sign-in as rows of ~/.local/share/kiro-cli/data.sqlite3
// (kiro-cli 2.35.1), in the same file as its conversations and telemetry. A
// new database gets those other rows too, so a test can see they survive.
// Whose account it is, kiro-cli only says over the network (whoami); the
// fake whoami below answers from the registration's client id. Synchronous,
// as node:sqlite is.
const KIRO_EMAILS = new Map();

export function writeKiro(location, { email, token, clientId = `client-${token}`, profile = `profile-${token}`, refresh = true, registration = true }) {
  mkdirSync(dirname(location.db), { recursive: true });
  const db = new DatabaseSync(location.db);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE IF NOT EXISTS conversations_v2 (key TEXT PRIMARY KEY, value TEXT);`);
    db.prepare("INSERT OR IGNORE INTO conversations_v2 VALUES ('/work', 'a conversation')").run();
    db.prepare("INSERT OR IGNORE INTO state VALUES ('telemetryClientId', 'telemetry-1')").run();
    db.prepare("DELETE FROM auth_kv WHERE key LIKE 'kirocli:%'").run();
    const put = db.prepare("INSERT INTO auth_kv VALUES (?, ?)");
    put.run("kirocli:odic:token", JSON.stringify({
      access_token: `${SECRET}-access-${token}`,
      expires_at: "2026-11-03T10:00:00Z",
      ...(refresh ? { refresh_token: `${SECRET}-refresh-${token}` } : {}),
      region: "us-east-1",
      start_url: "https://example.awsapps.com/start",
      oauth_flow: "DeviceCode",
      scopes: ["codewhisperer:completions"],
    }));
    if (registration) put.run("kirocli:odic:device-registration", JSON.stringify({
      client_id: clientId,
      client_secret: `${SECRET}-client-${token}`,
      client_secret_expires_at: "2027-01-28T00:00:00Z",
      region: "us-east-1",
      oauth_flow: "DeviceCode",
      scopes: ["codewhisperer:completions"],
    }));
    const state = db.prepare("INSERT OR REPLACE INTO state VALUES (?, ?)");
    state.run("auth.idc.start-url", "https://example.awsapps.com/start");
    state.run("auth.idc.region", "us-east-1");
    state.run("api.codewhisperer.profile", JSON.stringify({ arn: `arn:aws:codewhisperer:us-east-1:1:profile/${profile}`, profile_name: profile }));
  } finally {
    db.close();
  }
  if (email) KIRO_EMAILS.set(registration ? clientId : `refresh:${token}`, email);
}

// What `kiro-cli whoami` would say for the data folder, counted.
export function fakeKiroWhoami() {
  const calls = [];
  const whoami = async (dataHome) => {
    calls.push(dataHome);
    const db = new DatabaseSync(join(dataHome, "kiro-cli", "data.sqlite3"), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'").get();
      const token = JSON.parse(db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get()?.value ?? "{}");
      const email = row ? KIRO_EMAILS.get(JSON.parse(row.value).client_id)
        : KIRO_EMAILS.get(`refresh:${String(token.refresh_token).split("-refresh-")[1]}`);
      return email ? { email, accountType: "IamIdentityCenter", region: "us-east-1", startUrl: "https://example.awsapps.com/start" } : null;
    } finally {
      db.close();
    }
  };
  return { whoami, calls };
}

// The empty directory a sign-in command points its CLI at.
export function stagingDirectoryOf(command) {
  return /=\s*'([^']+)'/u.exec(command)[1];
}

// Where a CLI signed in inside a sign-in directory would have written.
export function stagedLocation(cli, directory) {
  const adapter = { claude: claudeAdapter, codex: codexAdapter, agy: agyAdapter, kiro: liveKiroAdapter }[cli];
  return adapter.locate({ [adapter.homeEnv]: directory });
}

// A machine with Claude, Codex, Antigravity and Kiro all signed in to account A.
// No keyring is reachable from its environment, so Antigravity is in file mode;
// Kiro's whoami is the fake one, so no test reaches the network.
export async function machine(t, { running = [], adapters, now, email = "a@example.com", kiroWhoami = fakeKiroWhoami() } = {}) {
  const home = await mkdtemp(join(tmpdir(), "herdr-ai-accounts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  const claude = claudeAdapter.locate(env);
  const codex = codexAdapter.locate(env);
  await writeClaude(claude, { uuid: "uuid-a", email, token: "a1" });
  await writeFile(claude.global, JSON.stringify({
    ...JSON.parse(await readFile(claude.global, "utf8")),
    mcpServers: { keep: { command: "x" } },
  }));
  await writeCodex(codex, { accountId: "codex-a", email, token: "a1" });
  const agy = agyAdapter.locate(env);
  await writeAgy(agy, { email, token: "a1" });
  const kiroAdapter = createKiroAdapter({ whoami: kiroWhoami.whoami });
  const kiro = kiroAdapter.locate(env);
  writeKiro(kiro, { email, token: "a1", clientId: "client-a" });
  const directory = join(home, ".config", "herdr-bridge", "ai-accounts");
  const accounts = new AiAccounts({ directory, env, runningAgents: async () => running, now,
    adapters: adapters ?? [claudeAdapter, codexAdapter, agyAdapter, kiroAdapter] });
  return { home, env, claude, codex, agy, kiro, kiroAdapter, kiroWhoami, directory, accounts };
}
