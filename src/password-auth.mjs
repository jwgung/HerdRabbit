import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PASSWORD_BYTES = 64;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTH_VERSION = 1;
const PASSKEY_DEVICE_TYPES = new Set(["singleDevice", "multiDevice"]);
const PASSKEY_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const MAX_SESSIONS = 64;
// A sign-in is used constantly; writing that down every time would rewrite the
// auth file on each request. Within this long it is still "just now".
const LAST_USED_RESOLUTION_MS = 10 * 60_000;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});

function safeEquals(expected, candidate) {
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length &&
    timingSafeEqual(expectedBuffer, candidateBuffer);
}

function validateStoredPasskey(value) {
  if (
    !value ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(value.id) ||
    typeof value.publicKey !== "string" ||
    value.publicKey.length === 0 ||
    value.publicKey.length > 16_384 ||
    !/^[A-Za-z0-9_-]+$/u.test(value.publicKey) ||
    !Number.isSafeInteger(value.counter) ||
    value.counter < 0 ||
    !Array.isArray(value.transports) ||
    value.transports.length > 16 ||
    !value.transports.every((transport) => (
      typeof transport === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(transport)
    )) ||
    !PASSKEY_DEVICE_TYPES.has(value.deviceType) ||
    typeof value.backedUp !== "boolean" ||
    // Passkeys registered before the management screen carry none of these.
    (value.label !== undefined && !isPasskeyLabel(value.label)) ||
    (value.createdAt !== undefined && !isTimestamp(value.createdAt)) ||
    (value.lastUsedAt !== undefined && !isTimestamp(value.lastUsedAt))
  ) {
    throw new Error("HerdRabbit passkey configuration is invalid");
  }
  return {
    id: value.id,
    publicKey: value.publicKey,
    counter: value.counter,
    transports: [...new Set(value.transports)],
    deviceType: value.deviceType,
    backedUp: value.backedUp,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.lastUsedAt === undefined ? {} : { lastUsedAt: value.lastUsedAt }),
  };
}

function isPasskeyLabel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// The screen names a passkey by this, never by its credential ID: the ID stays
// inside the auth file, and a handle cannot be turned back into one.
export function passkeyHandle(id) {
  return createHash("sha256").update(id).digest().subarray(0, 16).toString("base64url");
}

function isSessionAgent(value) {
  return typeof value === "string" && value.length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function validateStoredSession(value) {
  if (
    !value ||
    typeof value.id !== "string" || !SESSION_ID_PATTERN.test(value.id) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.expiresAt) ||
    !isTimestamp(value.lastUsedAt) || !isSessionAgent(value.agent)
  ) {
    throw new Error("HerdRabbit session configuration is invalid");
  }
  return { id: value.id, createdAt: value.createdAt, expiresAt: value.expiresAt, lastUsedAt: value.lastUsedAt, agent: value.agent };
}

// A session is named by a hash of its nonce, so the list can be shown and
// matched without keeping anything that would sign a request.
export function sessionId(nonce) {
  return createHash("sha256").update(nonce).digest().subarray(0, 16).toString("base64url");
}

function validateStoredConfiguration(value) {
  if (
    !value ||
    value.version !== AUTH_VERSION ||
    value.password?.algorithm !== "scrypt" ||
    typeof value.password.salt !== "string" ||
    typeof value.password.hash !== "string" ||
    typeof value.sessionSecret !== "string" ||
    (value.sessionEpoch !== undefined && !isTimestamp(value.sessionEpoch)) ||
    (value.sessionsSince !== undefined && !isTimestamp(value.sessionsSince))
  ) {
    throw new Error("HerdRabbit authentication configuration is invalid");
  }
  const sessions = value.sessions === undefined ? [] : value.sessions;
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS) {
    throw new Error("HerdRabbit session configuration is invalid");
  }
  const passkeys = value.passkeys === undefined ? [] : value.passkeys;
  if (!Array.isArray(passkeys) || passkeys.length > 32) {
    throw new Error("HerdRabbit passkey configuration is invalid");
  }
  const normalizedPasskeys = passkeys.map(validateStoredPasskey);
  if (new Set(normalizedPasskeys.map(({ id }) => id)).size !== normalizedPasskeys.length) {
    throw new Error("HerdRabbit passkey configuration contains duplicate credentials");
  }
  return {
    version: AUTH_VERSION,
    password: { ...value.password },
    sessionSecret: value.sessionSecret,
    ...(value.sessionEpoch ? { sessionEpoch: value.sessionEpoch } : {}),
    passkeys: normalizedPasskeys,
    ...(value.sessionsSince === undefined ? {} : { sessionsSince: value.sessionsSince }),
    sessions: sessions.map(validateStoredSession),
  };
}

async function derivePassword(password, salt) {
  return scrypt(password, salt, PASSWORD_BYTES, SCRYPT_OPTIONS);
}

export function defaultAuthFilePath(environment = process.env) {
  if (environment.HERDR_WEB_AUTH_FILE) {
    return resolve(environment.HERDR_WEB_AUTH_FILE);
  }
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "herdr-bridge", "auth.json");
}

export async function createPasswordConfiguration(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("password must not be empty");
  }
  if (password.length > 256) {
    throw new TypeError("password must be at most 256 characters");
  }

  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return {
    version: AUTH_VERSION,
    password: {
      algorithm: "scrypt",
      salt: salt.toString("base64url"),
      hash: hash.toString("base64url"),
    },
    sessionSecret: randomBytes(32).toString("base64url"),
    passkeys: [],
  };
}

async function writeConfigurationFile(authFile, configuration) {
  const parent = dirname(authFile);
  const temporary = `${authFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, authFile);
    await chmod(authFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function writePasswordConfiguration(authFile, password) {
  if (password === "") {
    await unlink(authFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { required: false };
  }

  const configuration = await createPasswordConfiguration(password);
  await writeConfigurationFile(authFile, configuration);
  return { required: true };
}

function cookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== "string") return null;
  for (const item of cookieHeader.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

// Wrong passwords, counted for the whole instance: there is one password, and
// behind Tailscale Serve every caller has the same address. A few mistakes are
// free; after that each one locks password checks for twice as long as the
// last, up to fifteen minutes. A locked check is refused before scrypt runs.
// Passkey sign-in is not counted, so it still works while this is locked.
export class PasswordAttempts {
  constructor({ now = () => Date.now(), free = 5, maxLockMs = 15 * 60_000 } = {}) {
    this.now = now;
    this.free = free;
    this.maxLockMs = maxLockMs;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  retryAfterMs() {
    return Math.max(0, this.lockedUntil - this.now());
  }

  failed() {
    this.failures += 1;
    if (this.failures <= this.free) return;
    this.lockedUntil = this.now() + Math.min(1_000 * 2 ** (this.failures - this.free - 1), this.maxLockMs);
  }

  succeeded() {
    this.failures = 0;
    this.lockedUntil = 0;
  }
}

// Wrong passwords counted per caller, so guesses from one device cannot lock the
// owner out on another. The key is whatever the caller cannot choose: the
// Tailscale login or nearest forwarded address Serve stamps on, or the socket
// address. A loose instance-wide count still bounds guessing from many keys.
export class PasswordAttemptsByKey {
  constructor({ now = () => Date.now(), free = 5, maxLockMs = 15 * 60_000, overallFree = 50, maxKeys = 256 } = {}) {
    this.options = { now, free, maxLockMs };
    this.maxKeys = maxKeys;
    this.byKey = new Map();
    this.overall = new PasswordAttempts({ now, free: overallFree, maxLockMs });
  }

  #attempts(key) {
    let attempts = this.byKey.get(key);
    if (!attempts) {
      if (this.byKey.size >= this.maxKeys) {
        // Forget whichever key is no longer locked, else the oldest.
        const idle = [...this.byKey].find(([, value]) => value.retryAfterMs() === 0)?.[0];
        this.byKey.delete(idle ?? this.byKey.keys().next().value);
      }
      attempts = new PasswordAttempts(this.options);
      this.byKey.set(key, attempts);
    }
    return attempts;
  }

  retryAfterMs(key) {
    return Math.max(this.overall.retryAfterMs(), this.byKey.get(key)?.retryAfterMs() ?? 0);
  }

  failed(key) {
    this.#attempts(key).failed();
    this.overall.failed();
  }

  succeeded(key) {
    this.byKey.delete(key);
    this.overall.succeeded();
  }
}

export class PasswordAuth {
  constructor(configuration = null, {
    now = () => Date.now(),
    authFile = null,
  } = {}) {
    this.configuration = configuration
      ? validateStoredConfiguration(configuration)
      : null;
    this.now = now;
    this.authFile = authFile;
    this.writeQueue = Promise.resolve();
    this.sessionListeners = new Set();
  }

  // Called with nothing whenever sessions end, so open connections can check
  // their own again instead of waiting for their next message.
  onSessionsEnded(listener) {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  #sessionsEnded() {
    for (const listener of this.sessionListeners) listener();
  }

  get required() {
    return this.configuration !== null;
  }

  get hasPasskeys() {
    return this.required && this.configuration.passkeys.length > 0;
  }

  get passkeyUserId() {
    if (!this.required) return null;
    return Uint8Array.from(Buffer.from(this.configuration.sessionSecret, "base64url"));
  }

  get passkeys() {
    if (!this.required) return [];
    return this.configuration.passkeys.map((passkey) => ({
      ...passkey,
      publicKey: Uint8Array.from(Buffer.from(passkey.publicKey, "base64url")),
      transports: [...passkey.transports],
    }));
  }

  async addPasskey(passkey) {
    if (!this.required || !this.authFile) {
      throw new Error("Passkeys require a persistent password configuration");
    }
    const publicKey = passkey?.publicKey;
    if (!(publicKey instanceof Uint8Array) || publicKey.byteLength === 0) {
      throw new TypeError("passkey publicKey must be a non-empty Uint8Array");
    }
    const stored = validateStoredPasskey({
      ...passkey,
      publicKey: Buffer.from(publicKey).toString("base64url"),
    });
    await this.#updateConfiguration((configuration) => {
      if (configuration.passkeys.some(({ id }) => id === stored.id)) {
        throw new Error("Passkey is already registered");
      }
      if (configuration.passkeys.length >= 32) {
        throw new Error("Too many passkeys are registered");
      }
      return {
        ...configuration,
        passkeys: [...configuration.passkeys, stored],
      };
    });
  }

  // Names, dates and kind only: no credential ID, public key or counter.
  passkeySummaries() {
    if (!this.required) return [];
    return this.configuration.passkeys.map((passkey) => ({
      handle: passkeyHandle(passkey.id),
      label: passkey.label ?? null,
      createdAt: passkey.createdAt ?? null,
      lastUsedAt: passkey.lastUsedAt ?? null,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
    }));
  }

  // False when no passkey has that handle, including one removed a moment ago.
  // Removing one also signs every session out: a passkey is usually removed
  // because its device is gone, and that device may still be signed in. The
  // caller hands the browser that asked a new session.
  async removePasskey(handle) {
    if (typeof handle !== "string" || !PASSKEY_HANDLE_PATTERN.test(handle)) return false;
    if (!this.passkeySummaries().some((passkey) => passkey.handle === handle)) return false;
    let removed = false;
    await this.#updateConfiguration((configuration) => {
      const passkeys = configuration.passkeys.filter(({ id }) => passkeyHandle(id) !== handle);
      removed = passkeys.length < configuration.passkeys.length;
      if (!removed) return configuration;
      return { ...configuration, passkeys, sessionEpoch: (configuration.sessionEpoch ?? 0) + 1, sessions: [] };
    });
    if (removed) this.#sessionsEnded();
    return removed;
  }

  // False when no passkey has that ID any more.
  async updatePasskeyCounter(id, counter) {
    if (!Number.isSafeInteger(counter) || counter < 0) {
      throw new TypeError("passkey counter must be a non-negative integer");
    }
    let found = false;
    await this.#updateConfiguration((configuration) => {
      const passkeys = configuration.passkeys.map((passkey) => {
        if (passkey.id !== id) return passkey;
        found = true;
        return {
          ...passkey,
          counter: Math.max(passkey.counter, counter),
          lastUsedAt: this.now(),
        };
      });
      return found ? { ...configuration, passkeys } : configuration;
    });
    return found;
  }

  // Newest first; the caller marks which one it is itself.
  sessionSummaries() {
    if (!this.required) return [];
    const now = Math.floor(this.now() / 1000);
    return this.configuration.sessions
      .filter((session) => session.expiresAt > now)
      .map((session) => ({ ...session }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  currentSessionId(cookieHeader) {
    const token = cookieValue(cookieHeader, "herdr_session");
    return this.#tokenSession(token, "cookie")?.id ?? null;
  }

  // False when no session has that id, including one ended a moment ago.
  async endSession(id) {
    if (!this.required || typeof id !== "string" || !SESSION_ID_PATTERN.test(id)) return false;
    if (!this.configuration.sessions.some((session) => session.id === id)) return false;
    const ending = this.#changeSessions((sessions) => sessions.filter((session) => session.id !== id));
    this.#sessionsEnded();
    await ending;
    return true;
  }

  // Every session, including ones signed before sessions were listed.
  async endAllSessions() {
    if (!this.required) return;
    const ending = this.#replaceConfiguration({
      ...this.configuration, sessionEpoch: (this.configuration.sessionEpoch ?? 0) + 1, sessions: [],
    });
    this.#sessionsEnded();
    await ending;
  }

  #changeSessions(change) {
    return this.#replaceConfiguration({
      ...this.configuration,
      sessionsSince: this.configuration.sessionsSince ?? Math.floor(this.now() / 1000),
      sessions: change(this.configuration.sessions),
    });
  }

  // Sessions change in memory at once, so the very next request sees them;
  // the file catches up behind. Without an auth file (tests, a password passed
  // in memory) they are just not kept across a restart.
  #replaceConfiguration(next) {
    this.configuration = validateStoredConfiguration(next);
    return this.authFile ? this.#persist() : Promise.resolve();
  }

  // Every change lands in memory first, in call order, and each queued write
  // saves whatever is current when it runs. A write never puts back the state
  // it started from, so a session ended while another write was in flight
  // stays ended.
  async #updateConfiguration(update) {
    if (!this.required || !this.authFile) {
      throw new Error("Passkeys require a persistent password configuration");
    }
    this.configuration = validateStoredConfiguration(update(this.configuration));
    return this.#persist();
  }

  #persist() {
    const operation = this.writeQueue.then(() => writeConfigurationFile(this.authFile, this.configuration));
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async verifyPassword(password) {
    if (!this.required || typeof password !== "string" || password.length > 256) {
      return false;
    }
    const expected = Buffer.from(this.configuration.password.hash, "base64url");
    const candidate = await derivePassword(
      password,
      Buffer.from(this.configuration.password.salt, "base64url"),
    );
    return safeEquals(expected, candidate);
  }

  // The session is listed at once, so the request that follows can rely on
  // it; writing it down finishes behind.
  createSession({ agent = "Unknown browser" } = {}) {
    const token = this.#createToken("cookie");
    if (!token) return null;
    const [nonce, rawExpiry] = token.split(".");
    const now = Math.floor(this.now() / 1000);
    const session = {
      id: sessionId(nonce), createdAt: now, expiresAt: Number(rawExpiry), lastUsedAt: now,
      agent: isSessionAgent(agent) && agent ? agent : "Unknown browser",
    };
    const write = this.#changeSessions((sessions) => [
      session,
      ...sessions.filter((item) => item.expiresAt > now),
    ].slice(0, MAX_SESSIONS));
    write.catch(() => {});
    return token;
  }

  createLaunchToken() {
    return this.#createToken("launch");
  }

  #createToken(purpose) {
    if (!this.required) return null;
    const expiresAt = Math.floor(this.now() / 1000) + SESSION_TTL_SECONDS;
    const payload = `${randomBytes(24).toString("base64url")}.${expiresAt}`;
    const signature = this.#sign(purpose, payload);
    return `${payload}.${signature}`;
  }

  hasValidSession(cookieHeader) {
    if (!this.required) return true;
    const token = cookieValue(cookieHeader, "herdr_session");
    const session = this.#tokenSession(token, "cookie");
    if (!session) return false;
    if (session.legacy) return true;
    const listed = this.configuration.sessions.find((item) => item.id === session.id);
    if (!listed) return false;
    this.#touch(listed);
    return true;
  }

  #touch(session) {
    const now = Math.floor(this.now() / 1000);
    if ((now - session.lastUsedAt) * 1000 < LAST_USED_RESOLUTION_MS) return;
    session.lastUsedAt = now;
    this.#changeSessions((sessions) => sessions.map((item) => (
      item.id === session.id ? { ...item, lastUsedAt: Math.max(item.lastUsedAt, now) } : item
    ))).catch(() => {});
  }

  // A signed, unexpired token, and the session it names. Tokens made before
  // sessions were listed stay valid until they expire, so an upgrade signs no
  // one out; one made since must still be on the list.
  #tokenSession(token, purpose) {
    if (!this.#hasValidToken(token, purpose)) return null;
    const [nonce, rawExpiry] = token.split(".");
    const createdAt = Number(rawExpiry) - SESSION_TTL_SECONDS;
    const since = this.configuration.sessionsSince;
    return { id: sessionId(nonce), legacy: since === undefined || createdAt < since };
  }

  hasValidLaunchToken(token) {
    return this.#hasValidToken(token, "launch");
  }

  #hasValidToken(token, purpose) {
    if (!this.required) return true;
    if (!token) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [nonce, rawExpiry, candidateSignature] = parts;
    const expiresAt = Number(rawExpiry);
    if (!nonce || !Number.isSafeInteger(expiresAt)) return false;
    if (expiresAt <= Math.floor(this.now() / 1000)) return false;
    const payload = `${nonce}.${rawExpiry}`;
    return safeEquals(this.#sign(purpose, payload), candidateSignature);
  }

  // The epoch moves when a passkey is removed, which unsigns every token made
  // before. Epoch 0 signs as tokens always have, so an upgrade signs no one out.
  #sign(purpose, payload) {
    const epoch = this.configuration.sessionEpoch ?? 0;
    return createHmac("sha256", this.configuration.sessionSecret)
      .update(epoch === 0 ? `${purpose}.${payload}` : `${purpose}.${epoch}.${payload}`)
      .digest("base64url");
  }

  sessionCookie(token, { secure = false, maxAge = SESSION_TTL_SECONDS } = {}) {
    const attributes = [
      `herdr_session=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
    ];
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  clearSessionCookie({ secure = false } = {}) {
    return this.sessionCookie("", { secure, maxAge: 0 });
  }
}

export async function loadPasswordAuth(authFile) {
  try {
    const source = await readFile(authFile, "utf8");
    return new PasswordAuth(JSON.parse(source), { authFile });
  } catch (error) {
    if (error.code === "ENOENT") return new PasswordAuth(null, { authFile });
    if (error instanceof SyntaxError) {
      throw new Error("HerdRabbit authentication configuration is not valid JSON", {
        cause: error,
      });
    }
    throw error;
  }
}

export const SESSION_DURATION_SECONDS = SESSION_TTL_SECONDS;
