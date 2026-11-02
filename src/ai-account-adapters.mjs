import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

// Whether the keyring holds agy's sign-in. Only the items' paths are asked
// for, never a secret; a machine without a keyring, gdbus, or a session bus
// answers no, as agy then falls back to the file too.
async function agyKeyringHoldsToken(env) {
  const address = sessionBusAddress(env);
  if (!address) return false;
  const output = await new Promise((resolve) => {
    execFile("gdbus", ["call", "--address", address, "--dest", "org.freedesktop.secrets",
      "--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.SearchItems",
      "{'service': 'gemini', 'username': 'antigravity'}"],
    { timeout: 2_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
  return secretServiceFound(output);
}

// Antigravity (agy) keeps its sign-in in the system keyring when it can reach
// one, else in ~/.gemini/antigravity-cli/antigravity-oauth-token (checked on
// agy 1.4.12). Only the file can be switched. (The project id it caches
// beside it is the same default before any sign-in, so it stays.)
// agy has no sign-in command: it signs in on its first run, here with HOME
// pointed at the sign-in directory and no session bus, so the new account
// lands in a file there and never in the keyring the live one may use.
export function createAgyAdapter({ keyringHoldsToken = agyKeyringHoldsToken } = {}) {
  return Object.freeze({
    id: "agy",
    label: "Antigravity CLI",
    homeEnv: "HOME",
    loginUnsetEnv: Object.freeze(["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]),
    loginCommand: Object.freeze(["agy"]),

    locate(env) {
      return { token: join(homeOf(env), ".gemini", "antigravity-cli", "antigravity-oauth-token") };
    },

    slot(directory) {
      return { token: join(directory, "antigravity-oauth-token") };
    },

    async support(env) {
      if (await keyringHoldsToken(env)) {
        return { supported: false, reason: "Antigravity keeps this sign-in in the system keyring; only its file can be switched" };
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

export const DEFAULT_ADAPTERS = Object.freeze([claudeAdapter, codexAdapter, agyAdapter]);
