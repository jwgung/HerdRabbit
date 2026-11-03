import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Each adapter knows where one CLI keeps its sign-in and how to swap it. The
// credential files are copied as opaque bytes; only fields that say whose
// account it is (email, organization, plan, expiry) are ever read out of them,
// and no token value is returned from here.

function homeOf(env) {
  return env.HOME || homedir();
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function text(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Written beside the target and renamed over it, so a reader never sees half a
// file and a failed write leaves the old one in place.
export async function writePrivateFile(file, data) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function copyPrivateFile(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function jwtClaims(token) {
  const payload = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!payload) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

// Claude Code keeps tokens in <config>/.credentials.json and whose account they
// are in the oauthAccount field of .claude.json, which also holds every other
// global setting -- so only that one field is replaced.
export const claudeAdapter = Object.freeze({
  id: "claude",
  label: "Claude Code",
  homeEnv: "CLAUDE_CONFIG_DIR",
  loginCommand: ["claude", "auth", "login"],

  locate(env) {
    const configDirectory = env.CLAUDE_CONFIG_DIR;
    return configDirectory
      ? { credentials: join(configDirectory, ".credentials.json"), global: join(configDirectory, ".claude.json") }
      : { credentials: join(homeOf(env), ".claude", ".credentials.json"), global: join(homeOf(env), ".claude.json") };
  },

  slot(directory) {
    return { credentials: join(directory, "credentials.json"), account: join(directory, "account.json") };
  },

  support(env, platform = process.platform) {
    if (platform === "darwin") return { supported: false, reason: "Claude Code keeps macOS sign-ins in the Keychain" };
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { supported: true, reason: "An API key or OAuth token in the environment overrides the saved sign-in" };
    }
    return { supported: true, reason: null };
  },

  async identify(location) {
    const credentials = await readJson(location.credentials);
    const oauth = credentials?.claudeAiOauth;
    if (!text(oauth?.refreshToken)) return null;
    const account = location.account
      ? await readJson(location.account)
      : (await readJson(location.global))?.oauthAccount;
    const accountId = text(account?.accountUuid);
    if (!accountId) return null;
    return {
      accountId,
      email: text(account.emailAddress),
      organization: text(account.organizationName),
      plan: text(oauth.subscriptionType),
      refreshExpiresAt: Number.isFinite(oauth.refreshTokenExpiresAt) ? oauth.refreshTokenExpiresAt : null,
    };
  },

  async capture(location, slot) {
    const account = (await readJson(location.global))?.oauthAccount;
    if (!account || typeof account !== "object") throw new Error("Claude account details are missing");
    await copyPrivateFile(location.credentials, slot.credentials);
    await writePrivateFile(slot.account, `${JSON.stringify(account, null, 2)}\n`);
  },

  async install(slot, location) {
    const account = await readJson(slot.account);
    if (!account || typeof account !== "object") throw new Error("Saved Claude account details are missing");
    let global = {};
    try {
      global = JSON.parse(await readFile(location.global, "utf8"));
    } catch (error) {
      // An unreadable settings file is left alone rather than replaced with a
      // near-empty one that would drop every other setting.
      if (error.code !== "ENOENT") throw new Error("Claude settings file could not be read");
    }
    if (!global || typeof global !== "object" || Array.isArray(global)) throw new Error("Claude settings file could not be read");
    await copyPrivateFile(slot.credentials, location.credentials);
    await writePrivateFile(location.global, `${JSON.stringify({ ...global, oauthAccount: account }, null, 2)}\n`);
  },
});

// Codex keeps everything in <CODEX_HOME>/auth.json. Whose account it is comes
// from the claims of the ID token, which carry no secret of their own.
export const codexAdapter = Object.freeze({
  id: "codex",
  label: "Codex",
  homeEnv: "CODEX_HOME",
  loginCommand: ["codex", "login", "--device-auth"],

  locate(env) {
    const home = env.CODEX_HOME || join(homeOf(env), ".codex");
    return { auth: join(home, "auth.json"), config: join(home, "config.toml") };
  },

  slot(directory) {
    return { auth: join(directory, "auth.json") };
  },

  async support(env) {
    let config = "";
    try {
      config = await readFile(this.locate(env).config, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const store = /^\s*cli_auth_credentials_store\s*=\s*["']?([A-Za-z]+)/mu.exec(config)?.[1];
    if (store && store !== "file") {
      return { supported: false, reason: `Codex stores sign-ins in "${store}" mode; only "file" can be switched` };
    }
    return { supported: true, reason: null };
  },

  async identify(location) {
    const auth = await readJson(location.auth);
    const tokens = auth?.tokens;
    if (!text(tokens?.refresh_token)) return null;
    const claims = jwtClaims(tokens.id_token);
    const openai = claims["https://api.openai.com/auth"] ?? {};
    const accountId = text(tokens.account_id) ?? text(openai.chatgpt_account_id);
    if (!accountId) return null;
    return {
      accountId,
      email: text(claims.email),
      organization: null,
      plan: text(openai.chatgpt_plan_type),
      refreshExpiresAt: null,
    };
  },

  async capture(location, slot) {
    await copyPrivateFile(location.auth, slot.auth);
  },

  async install(slot, location) {
    await copyPrivateFile(slot.auth, location.auth);
  },
});

// The session bus a program started from `env` would use for the keyring, or
// null when it has none (then agy can only write its file).
export function sessionBusAddress(env) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  return env.XDG_RUNTIME_DIR ? `unix:path=${env.XDG_RUNTIME_DIR}/bus` : null;
}

// gdbus prints SearchItems' answer as (unlocked, locked) lists of item paths.
export function secretServiceFound(output) {
  return /['"]\/org\/freedesktop\/secrets\/collection\//u.test(String(output ?? ""));
}

// Whether the keyring holds agy's sign-in: true, false, or null when it could
// not be told. Only the items' paths are asked for, never a secret. No session
// bus, or no keyring service on it, is a no: agy then writes the file too. No
// gdbus to ask with, or no answer in time, cannot be told.
async function agyKeyringHoldsToken(env) {
  const address = sessionBusAddress(env);
  if (!address) return false;
  return new Promise((resolve) => {
    execFile("gdbus", ["call", "--address", address, "--dest", "org.freedesktop.secrets",
      "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.SearchItems",
      "{'service': 'gemini', 'username': 'antigravity'}"],
    { timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error?.code === "ENOENT" || error?.killed) resolve(null);
      else resolve(error ? false : secretServiceFound(stdout));
    });
  });
}

// Antigravity (agy) keeps its sign-in in the system keyring when it can reach
// one, else in ~/.gemini/antigravity-cli/antigravity-oauth-token (checked on
// agy 1.4.12). Only the file can be switched. (The project id it caches
// beside it is the same default before any sign-in, so it stays.)
// agy has no sign-in command: it signs in on its first run, here with HOME
// pointed at the sign-in directory and no way to a session bus (DISPLAY
// too: D-Bus can be autolaunched from an X display), so the new account
// lands in a file there and never in the keyring the live one may use.
// Made by a factory only so tests can answer the keyring question themselves.
export function createAgyAdapter({ keyringHoldsToken = agyKeyringHoldsToken } = {}) {
  return Object.freeze({
    id: "agy",
    label: "Antigravity CLI",
    homeEnv: "HOME",
    loginUnsetEnv: ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY"],
    loginCommand: ["agy"],

    locate(env) {
      return { token: join(homeOf(env), ".gemini", "antigravity-cli", "antigravity-oauth-token") };
    },

    slot(directory) {
      return { token: join(directory, "antigravity-oauth-token") };
    },

    async support(env) {
      const inKeyring = await keyringHoldsToken(env);
      if (inKeyring) {
        return { supported: false, reason: "Antigravity keeps this sign-in in the system keyring; only its file can be switched" };
      }
      if (inKeyring === null) {
        return { supported: true, reason: "The system keyring could not be checked; if Antigravity keeps its sign-in there, a switch will not take" };
      }
      return { supported: true, reason: null };
    },

    async identify(location) {
      const file = await readJson(location.token);
      if (!text(file?.token?.refresh_token)) return null;
      const claims = jwtClaims(file.token.id_token ?? file.id_token);
      const email = text(file.id_token_email) ?? text(claims.email);
      // the email first: one version writes only it, another an ID token too,
      // and the same account must keep one slot across both
      const accountId = email?.toLowerCase() ?? text(claims.sub);
      if (!accountId) return null;
      return { accountId, email, organization: null, plan: null, refreshExpiresAt: null };
    },

    async capture(location, slot) {
      await copyPrivateFile(location.token, slot.token);
    },

    async install(slot, location) {
      await copyPrivateFile(slot.token, location.token);
    },
  });
}

export const agyAdapter = createAgyAdapter();

// Kiro CLI keeps its sign-in as rows of <XDG_DATA_HOME>/kiro-cli/data.sqlite3
// (kiro-cli 2.35.1): every auth_kv row named kirocli:* -- the token and the
// client registration it was issued to -- and three state rows saying where
// it signs in and with which profile. The same file holds its conversations,
// history and telemetry, and running kiro-cli processes keep it open, so only
// those rows are swapped, in one transaction; the file itself is never
// replaced. Each saved account keeps its own client registration.
const KIRO_STATE_KEYS = Object.freeze(["auth.idc.start-url", "auth.idc.region", "api.codewhisperer.profile"]);
const KIRO_TOKEN_KEY = /^kirocli:[a-z-]+:token$/u;

async function loadNodeSqlite() {
  try {
    return (await import("node:sqlite")).DatabaseSync;
  } catch {
    return null;
  }
}

// The first line of `kiro-cli whoami -f json`, or null when it says no one is
// signed in or says something else.
export function kiroWhoamiIdentity(output) {
  const line = String(output ?? "").split("\n").find((item) => item.trim().startsWith("{"));
  try {
    const value = JSON.parse(line);
    return text(value?.email)
      ? { email: value.email, accountType: text(value.accountType), region: text(value.region), startUrl: text(value.startUrl) }
      : null;
  } catch {
    return null;
  }
}

// Whose sign-in the data folder holds. kiro-cli asks AWS: nothing in the
// database names the account.
function runKiroWhoami(dataHome) {
  return new Promise((resolve, reject) => {
    execFile("kiro-cli", ["whoami", "-f", "json"], {
      env: { ...process.env, XDG_DATA_HOME: dataHome },
      timeout: 15_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      const identity = kiroWhoamiIdentity(stdout);
      if (identity) resolve(identity);
      else if (error && error.code !== 1) reject(error);
      else resolve(null);
    });
  });
}

// What tells one sign-in from another without the network, kept only as a
// hash in memory: the client registration's id, or, for a sign-in without
// one (Google, GitHub), its refresh token -- which a refresh changes, costing
// one more whoami.
function kiroFingerprint(rows) {
  const parsed = (key) => {
    try {
      return JSON.parse(rows[key] ?? "null");
    } catch {
      return null;
    }
  };
  const registration = Object.keys(rows).find((key) => key.endsWith(":device-registration"));
  const token = Object.keys(rows).find((key) => KIRO_TOKEN_KEY.test(key));
  const value = text(registration && parsed(registration)?.client_id) ?? text(token && parsed(token)?.refresh_token);
  return value ? createHash("sha256").update(value).digest("hex") : null;
}

function kiroRefreshExpiresAt(rows) {
  const registration = Object.entries(rows).find(([key]) => key.endsWith(":device-registration"))?.[1];
  try {
    const expiresAt = Date.parse(JSON.parse(registration ?? "null")?.client_secret_expires_at);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}

function kiroSignedIn(rows) {
  return Object.entries(rows).some(([key, value]) => {
    if (!KIRO_TOKEN_KEY.test(key)) return false;
    try {
      return Boolean(text(JSON.parse(value)?.refresh_token));
    } catch {
      return false;
    }
  });
}

export function createKiroAdapter({ whoami = runKiroWhoami, loadSqlite = loadNodeSqlite, busyTimeoutMs = 5_000 } = {}) {
  // Whose account each client registration is, as whoami or a saved copy said:
  // whoami goes over the network, so it is asked once per sign-in.
  const known = new Map();

  async function open(file, { write = false } = {}) {
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) throw new Error("node:sqlite is not available");
    const db = new DatabaseSync(file, { readOnly: !write });
    // kiro-cli writes the same file; wait for it rather than fail at once
    db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    return db;
  }

  async function readRows(file) {
    try {
      await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const db = await open(file);
    try {
      const authKv = {};
      for (const row of db.prepare("SELECT key, value FROM auth_kv WHERE key LIKE 'kirocli:%'").all()) authKv[row.key] = row.value;
      const state = {};
      const get = db.prepare("SELECT value FROM state WHERE key = ?");
      for (const key of KIRO_STATE_KEYS) {
        const row = get.get(key);
        if (row) state[key] = row.value instanceof Uint8Array ? { base64: Buffer.from(row.value).toString("base64") } : row.value;
      }
      return { authKv, state };
    } finally {
      db.close();
    }
  }

  return Object.freeze({
    id: "kiro",
    label: "Kiro CLI",
    homeEnv: "XDG_DATA_HOME",
    loginCommand: ["kiro-cli", "login", "--use-device-flow"],

    locate(env) {
      const dataHome = env.XDG_DATA_HOME || join(homeOf(env), ".local", "share");
      return { db: join(dataHome, "kiro-cli", "data.sqlite3"), dataHome };
    },

    slot(directory) {
      return { auth: join(directory, "auth.json"), account: join(directory, "account.json") };
    },

    async support(env, platform = process.platform) {
      if (platform !== "linux") return { supported: false, reason: "Kiro CLI sign-ins are switched on Linux only" };
      if (!(await loadSqlite())) return { supported: false, reason: "Switching Kiro CLI sign-ins needs Node 22.13 or later (node:sqlite)" };
      const { db: file } = this.locate(env);
      try {
        const db = await open(file);
        try {
          const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
          if (!tables.has("auth_kv") || !tables.has("state")) {
            return { supported: false, reason: "Kiro CLI's database is laid out in a way HerdRabbit does not know" };
          }
        } finally {
          db.close();
        }
      } catch (error) {
        // no database yet: nothing is signed in, and a sign-in makes one
        if (!/unable to open|ENOENT/u.test(String(error?.message))) {
          return { supported: false, reason: "Kiro CLI's database could not be read" };
        }
      }
      return { supported: true, reason: null };
    },

    async identify(location) {
      if (location.auth) {
        const [auth, account] = [await readJson(location.auth), await readJson(location.account)];
        if (!auth?.authKv || !kiroSignedIn(auth.authKv) || !text(account?.email)) return null;
        const identity = {
          accountId: account.email.toLowerCase(),
          email: account.email,
          organization: null,
          plan: null,
          refreshExpiresAt: kiroRefreshExpiresAt(auth.authKv),
        };
        const fingerprint = kiroFingerprint(auth.authKv);
        if (fingerprint) known.set(fingerprint, account.email);
        return identity;
      }
      const rows = await readRows(location.db);
      if (!rows || !kiroSignedIn(rows.authKv)) return null;
      const fingerprint = kiroFingerprint(rows.authKv);
      let email = fingerprint ? known.get(fingerprint) : undefined;
      if (!email) {
        email = (await whoami(location.dataHome))?.email;
        if (!text(email)) return null;
        if (fingerprint) known.set(fingerprint, email);
      }
      return {
        accountId: email.toLowerCase(),
        email,
        organization: null,
        plan: null,
        refreshExpiresAt: kiroRefreshExpiresAt(rows.authKv),
      };
    },

    async capture(location, slot) {
      const rows = await readRows(location.db);
      if (!rows || !kiroSignedIn(rows.authKv)) throw new Error("Kiro CLI is not signed in");
      const identity = await this.identify(location);
      if (!identity) throw new Error("Kiro CLI account details are missing");
      await writePrivateFile(slot.auth, `${JSON.stringify(rows, null, 2)}\n`);
      await writePrivateFile(slot.account, `${JSON.stringify({ email: identity.email }, null, 2)}\n`);
    },

    // One transaction: kiro-cli sees the old sign-in or the new one, never a
    // mix, and a database it is writing is waited for and then left alone.
    async install(slot, location) {
      const saved = await readJson(slot.auth);
      if (!saved?.authKv || !kiroSignedIn(saved.authKv)) throw new Error("Saved Kiro CLI sign-in is missing");
      await stat(location.db);
      const db = await open(location.db, { write: true });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("DELETE FROM auth_kv WHERE key LIKE 'kirocli:%'").run();
          const put = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
          for (const [key, value] of Object.entries(saved.authKv)) {
            if (key.startsWith("kirocli:") && typeof value === "string") put.run(key, value);
          }
          const drop = db.prepare("DELETE FROM state WHERE key = ?");
          const set = db.prepare("INSERT INTO state (key, value) VALUES (?, ?)");
          for (const key of KIRO_STATE_KEYS) {
            drop.run(key);
            const value = saved.state?.[key];
            if (typeof value === "string") set.run(key, value);
            else if (typeof value?.base64 === "string") set.run(key, Buffer.from(value.base64, "base64"));
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } finally {
        db.close();
      }
    },
  });
}

export const kiroAdapter = createKiroAdapter();

export const DEFAULT_ADAPTERS = Object.freeze([claudeAdapter, codexAdapter, agyAdapter, kiroAdapter]);
