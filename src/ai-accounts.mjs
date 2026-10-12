import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ADAPTERS } from "./ai-account-adapters.mjs";
import { InputValidationError } from "./herdr-client.mjs";

// One machine, one active sign-in per CLI. Saved accounts are copies of a
// CLI's credential files kept in a private directory; switching copies one back.
//
// Nothing here returns a credential. Callers get who an account belongs to --
// email, organization, plan, when it will need a new sign-in -- and nothing
// that could be used to act as that account.

export const SLOT_ID_PATTERN = /^acct_[a-f0-9-]{36}$/u;
export const LOGIN_ID_PATTERN = /^login_[a-f0-9-]{36}$/u;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export class AiAccountError extends Error {
  constructor(code, message, { status = 409, details } = {}) {
    super(message);
    this.name = "AiAccountError";
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function publicAccount(id, identity, active) {
  return {
    id,
    email: identity.email,
    organization: identity.organization,
    plan: identity.plan,
    refreshExpiresAt: identity.refreshExpiresAt,
    active,
  };
}

// Herdr already knows which panes an agent was detected in; that is what a
// switch warns about. An agent started outside Herdr is not seen.
export async function runningAgentsIn(client) {
  const snapshot = await client.snapshot();
  const labels = new Map((snapshot.workspaces ?? []).map((workspace) => [workspace.workspace_id, workspace.label]));
  return (snapshot.agents ?? [])
    .filter((agent) => typeof agent.agent === "string" && typeof agent.pane_id === "string")
    .map((agent) => ({ paneId: agent.pane_id, agent: agent.agent, label: labels.get(agent.workspace_id) ?? null }));
}

export class AiAccounts {
  constructor({
    directory,
    adapters = DEFAULT_ADAPTERS,
    env = process.env,
    runningAgents = async () => [],
    now = () => Date.now(),
  }) {
    this.directory = directory;
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.env = env;
    this.runningAgents = runningAgents;
    this.now = now;
    this.pending = Promise.resolve();
  }

  // Switching reads the live files, saves them back and installs others; two of
  // those interleaved could save one account's tokens under another's name.
  #serial(operation) {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }

  #adapter(cli) {
    const adapter = typeof cli === "string" ? this.adapters.get(cli) : undefined;
    if (!adapter) throw new InputValidationError("Unknown CLI");
    return adapter;
  }

  async #ensureDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }

  async #supported(adapter) {
    const support = await adapter.support(this.env);
    if (!support.supported) throw new AiAccountError("unsupported", support.reason);
    return support;
  }

  #slotDirectory(adapter, id) {
    if (typeof id !== "string" || !SLOT_ID_PATTERN.test(id)) throw new InputValidationError("Invalid account id");
    return join(this.directory, adapter.id, id);
  }

  #stagingDirectory(adapter, id) {
    if (typeof id !== "string" || !LOGIN_ID_PATTERN.test(id)) throw new InputValidationError("Invalid sign-in id");
    return join(this.directory, "staging", adapter.id, id);
  }

  async #slots(adapter) {
    let names = [];
    try {
      names = await readdir(join(this.directory, adapter.id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const slots = [];
    for (const id of names.filter((name) => SLOT_ID_PATTERN.test(name)).sort()) {
      const identity = await adapter.identify(adapter.slot(join(this.directory, adapter.id, id))).catch(() => null);
      if (identity) slots.push({ id, identity });
    }
    return slots;
  }

  async #current(adapter) {
    return adapter.identify(adapter.locate(this.env)).catch(() => null);
  }

  // Copies a sign-in -- the live one, or one just made in a sign-in directory --
  // into the slot that already holds the same account, so tokens the CLI has
  // since rotated replace the stale copy. A new slot that fails is removed.
  async #captureIntoSlot(adapter, source, identity) {
    const existing = (await this.#slots(adapter)).find((slot) => slot.identity.accountId === identity.accountId);
    const id = existing?.id ?? `acct_${randomUUID()}`;
    const directory = join(this.directory, adapter.id, id);
    for (const path of [this.directory, join(this.directory, adapter.id), directory]) {
      await this.#ensureDirectory(path);
    }
    try {
      await adapter.capture(source, adapter.slot(directory));
    } catch (error) {
      if (!existing) await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return id;
  }

  async #removeStaleLogins() {
    for (const adapter of this.adapters.values()) {
      const parent = join(this.directory, "staging", adapter.id);
      let names = [];
      try {
        names = await readdir(parent);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const name of names) {
        const path = join(parent, name);
        const info = await stat(path).catch(() => null);
        if (!info || this.now() - info.mtimeMs > STAGING_MAX_AGE_MS) await rm(path, { recursive: true, force: true });
      }
    }
  }

  // Sign-ins still open, by id. A page that reloaded while one was waiting asks
  // for these to pick the wait back up; an id names a directory, never what the
  // CLI wrote into it.
  async #openLogins(adapter) {
    try {
      return (await readdir(join(this.directory, "staging", adapter.id))).filter((name) => LOGIN_ID_PATTERN.test(name)).sort();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  list() {
    return this.#serial(async () => {
      await this.#removeStaleLogins();
      const clis = [];
      for (const adapter of this.adapters.values()) {
        const support = await adapter.support(this.env);
        const current = await this.#current(adapter);
        const accounts = (await this.#slots(adapter)).map((slot) =>
          publicAccount(slot.id, slot.identity, slot.identity.accountId === current?.accountId));
        clis.push({
          id: adapter.id,
          label: adapter.label,
          supported: support.supported,
          reason: support.reason,
          current: current
            ? { ...publicAccount(null, current, true), id: accounts.find((item) => item.active)?.id ?? null }
            : null,
          accounts,
          logins: await this.#openLogins(adapter),
        });
      }
      return { clis };
    });
  }

  async saveCurrent(cli) {
    const adapter = this.#adapter(cli);
    return this.#serial(async () => {
      await this.#supported(adapter);
      const current = await this.#current(adapter);
      if (!current) throw new AiAccountError("not_signed_in", `${adapter.label} is not signed in on this machine`);
      const id = await this.#captureIntoSlot(adapter, adapter.locate(this.env), current);
      return { cli: adapter.id, account: publicAccount(id, current, true) };
    });
  }

  // The new account signs in inside its own empty directory. Signing in where
  // the live account lives would revoke that account's tokens.
  async startLogin(cli) {
    const adapter = this.#adapter(cli);
    return this.#serial(async () => {
      await this.#supported(adapter);
      await this.#removeStaleLogins();
      const loginId = `login_${randomUUID()}`;
      const directory = this.#stagingDirectory(adapter, loginId);
      for (const path of [this.directory, join(this.directory, "staging"), join(this.directory, "staging", adapter.id), directory]) {
        await this.#ensureDirectory(path);
      }
      const command = ["env", `${adapter.homeEnv}=${shellQuote(directory)}`, ...adapter.loginCommand].join(" ");
      return { cli: adapter.id, label: adapter.label, loginId, command };
    });
  }

  async finishLogin(cli, loginId) {
    const adapter = this.#adapter(cli);
    const directory = this.#stagingDirectory(adapter, loginId);
    return this.#serial(async () => {
      if (!(await stat(directory).catch(() => null))) throw new AiAccountError("login_not_found", "This sign-in has expired", { status: 404 });
      const staged = adapter.locate({ ...this.env, [adapter.homeEnv]: directory });
      const identity = await adapter.identify(staged).catch(() => null);
      if (!identity) throw new AiAccountError("login_incomplete", "Finish signing in in the terminal first");
      const id = await this.#captureIntoSlot(adapter, staged, identity);
      await rm(directory, { recursive: true, force: true });
      const current = await this.#current(adapter);
      return { cli: adapter.id, account: publicAccount(id, identity, identity.accountId === current?.accountId) };
    });
  }

  async cancelLogin(cli, loginId) {
    const adapter = this.#adapter(cli);
    const directory = this.#stagingDirectory(adapter, loginId);
    return this.#serial(async () => {
      await rm(directory, { recursive: true, force: true });
      return { cli: adapter.id, loginId };
    });
  }

  async switch(cli, accountId, { confirmRunning = false } = {}) {
    const adapter = this.#adapter(cli);
    const directory = this.#slotDirectory(adapter, accountId);
    return this.#serial(async () => {
      await this.#supported(adapter);
      const target = await adapter.identify(adapter.slot(directory)).catch(() => null);
      if (!target) throw new AiAccountError("account_not_found", "Saved account not found", { status: 404 });

      const running = (await this.runningAgents()).filter((agent) => agent.agent === adapter.id);
      if (running.length > 0 && !confirmRunning) {
        throw new AiAccountError("agents_running", `${adapter.label} is running in ${running.length} pane(s)`, {
          details: { panes: running.map(({ paneId, label }) => ({ paneId, label: label ?? null })) },
        });
      }

      const current = await this.#current(adapter);
      if (current?.accountId === target.accountId) {
        return { cli: adapter.id, account: publicAccount(accountId, target, true), changed: false };
      }
      // The live sign-in is saved first. It may hold tokens rotated since it
      // was last saved, and it is also what a failed switch is restored from.
      const location = adapter.locate(this.env);
      const previous = current ? await this.#captureIntoSlot(adapter, location, current) : null;
      try {
        await adapter.install(adapter.slot(directory), location);
        const installed = await adapter.identify(location).catch(() => null);
        if (installed?.accountId !== target.accountId) throw new Error("installed account does not match");
      } catch {
        if (previous) {
          await adapter.install(adapter.slot(join(this.directory, adapter.id, previous)), location).catch(() => {});
        }
        throw new AiAccountError("switch_failed", `Could not switch ${adapter.label} accounts`, { status: 500 });
      }
      return { cli: adapter.id, account: publicAccount(accountId, target, true), changed: true };
    });
  }

  async remove(cli, accountId) {
    const adapter = this.#adapter(cli);
    const directory = this.#slotDirectory(adapter, accountId);
    return this.#serial(async () => {
      if (!(await stat(directory).catch(() => null))) throw new AiAccountError("account_not_found", "Saved account not found", { status: 404 });
      const [slot, current] = [await adapter.identify(adapter.slot(directory)).catch(() => null), await this.#current(adapter)];
      if (slot && slot.accountId === current?.accountId) {
        throw new AiAccountError("account_active", "Switch to another account before removing this one");
      }
      await rm(directory, { recursive: true, force: true });
      return { cli: adapter.id, id: accountId };
    });
  }
}
