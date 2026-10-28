import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CONFIG_VERSION = 1;
const VAPID_SUBJECT = "https://github.com/jwgung/HerdRabbit";
const MAX_ENDPOINT_LENGTH = 4_096;
const MAX_KEY_LENGTH = 512;

export class PushValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PushValidationError";
  }
}

function validateKey(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > MAX_KEY_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new PushValidationError(`Invalid push subscription ${name}`);
  }
  return value;
}

function validateEndpoint(value) {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) {
    throw new PushValidationError("Invalid push subscription endpoint");
  }
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("Unsafe endpoint");
    }
    return endpoint.href;
  } catch {
    throw new PushValidationError("Invalid push subscription endpoint");
  }
}

function validateSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PushValidationError("Invalid push subscription");
  }
  return {
    endpoint: validateEndpoint(value.endpoint),
    expirationTime: Number.isFinite(value.expirationTime)
      ? value.expirationTime
      : null,
    keys: {
      p256dh: validateKey(value.keys?.p256dh, "p256dh key"),
      auth: validateKey(value.keys?.auth, "auth key"),
    },
  };
}

function validateStoredConfiguration(value) {
  if (
    !value ||
    value.version !== CONFIG_VERSION ||
    typeof value.vapid?.publicKey !== "string" ||
    typeof value.vapid?.privateKey !== "string" ||
    !Array.isArray(value.subscriptions)
  ) {
    throw new Error("HerdRabbit push configuration is invalid");
  }
  return {
    version: CONFIG_VERSION,
    vapid: {
      publicKey: value.vapid.publicKey,
      privateKey: value.vapid.privateKey,
    },
    subscriptions: value.subscriptions.map(validateSubscription),
  };
}

async function writeConfiguration(filePath, configuration) {
  const parent = dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function defaultWebPushLibrary() {
  const imported = await import("web-push");
  return imported.default || imported;
}

export function defaultPushFilePath(environment = process.env) {
  if (environment.HERDR_WEB_PUSH_FILE) {
    return resolve(environment.HERDR_WEB_PUSH_FILE);
  }
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "herdr-bridge", "push.json");
}

export class WebPushService {
  constructor({ filePath, configuration, webPush, logger = console }) {
    this.filePath = filePath;
    this.configuration = configuration;
    this.webPush = webPush;
    this.logger = logger;
    this.writeQueue = Promise.resolve();
    this.webPush.setVapidDetails(
      VAPID_SUBJECT,
      configuration.vapid.publicKey,
      configuration.vapid.privateKey,
    );
  }

  get publicKey() {
    return this.configuration.vapid.publicKey;
  }

  hasSubscriptions() {
    return this.configuration.subscriptions.length > 0;
  }

  async #persist() {
    this.writeQueue = this.writeQueue.then(() =>
      writeConfiguration(this.filePath, this.configuration));
    await this.writeQueue;
  }

  async subscribe(value) {
    const subscription = validateSubscription(value);
    const existingIndex = this.configuration.subscriptions.findIndex(
      ({ endpoint }) => endpoint === subscription.endpoint,
    );
    if (existingIndex >= 0) {
      this.configuration.subscriptions[existingIndex] = subscription;
    } else {
      this.configuration.subscriptions.push(subscription);
    }
    await this.#persist();
  }

  async unsubscribe(endpoint) {
    const safeEndpoint = validateEndpoint(endpoint);
    const before = this.configuration.subscriptions.length;
    this.configuration.subscriptions = this.configuration.subscriptions.filter(
      (subscription) => subscription.endpoint !== safeEndpoint,
    );
    if (this.configuration.subscriptions.length !== before) await this.#persist();
    return this.configuration.subscriptions.length !== before;
  }

  async send(notification) {
    const expired = new Set();
    await Promise.all(this.configuration.subscriptions.map(async (subscription) => {
      try {
        await this.webPush.sendNotification(
          subscription,
          JSON.stringify(notification),
        );
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          expired.add(subscription.endpoint);
          return;
        }
        this.logger.error?.("push notification failed", {
          statusCode: error?.statusCode,
          endpointOrigin: new URL(subscription.endpoint).origin,
        });
      }
    }));

    if (expired.size > 0) {
      this.configuration.subscriptions = this.configuration.subscriptions.filter(
        ({ endpoint }) => !expired.has(endpoint),
      );
      await this.#persist();
    }
  }
}

export async function loadWebPushService(
  filePath = defaultPushFilePath(),
  { webPush, logger = console } = {},
) {
  const library = webPush || await defaultWebPushLibrary();
  let configuration;
  try {
    configuration = validateStoredConfiguration(
      JSON.parse(await readFile(filePath, "utf8")),
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error("HerdRabbit push configuration is not valid JSON", {
          cause: error,
        });
      }
      throw error;
    }
    configuration = {
      version: CONFIG_VERSION,
      vapid: library.generateVAPIDKeys(),
      subscriptions: [],
    };
    await writeConfiguration(filePath, configuration);
  }
  return new WebPushService({ filePath, configuration, webPush: library, logger });
}
