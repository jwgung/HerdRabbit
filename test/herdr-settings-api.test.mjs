import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdrHttpServer } from "../src/http-server.mjs";
import { HerdrSettings, MAX_CONFIG_BYTES } from "../src/herdr-settings.mjs";
import { fakeHerdrSettings } from "./fixtures/fake-herdr-settings.mjs";

const LINK = "link_11111111-1111-1111-1111-111111111111";

async function fixture(context, { required = true, settings = undefined } = {}) {
  const home = await mkdtemp(join(tmpdir(), "herdr-settings-api-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".config", "herdr"), { recursive: true });
  const configPath = join(home, ".config", "herdr", "config.toml");
  await writeFile(configPath, "onboarding = false\n");
  const fake = fakeHerdrSettings({ configPath });
  const remoteCalls = [];
  const remote = {
    async state() { remoteCalls.push(["state"]); return { channel: "preview", integrations: [], config: { path: "~/.config/herdr/config.toml", exists: false, bytes: null } }; },
    async setChannel(channel) { remoteCalls.push(["channel", channel]); return { channel, integrations: [], config: {} }; },
    async integration(action, name) { remoteCalls.push([action, name]); return { channel: "stable", integrations: [], config: {} }; },
    async readConfig() { remoteCalls.push(["read"]); return { text: "", version: "none" }; },
    async defaultConfig() { remoteCalls.push(["default"]); return { text: "# defaults" }; },
    async checkConfig(text) { remoteCalls.push(["check", text]); return { ok: true, diagnostics: "config: ok" }; },
    async saveConfig(text, version) { remoteCalls.push(["save", text, version]); return { text, version: "none" }; },
  };
  const herdr = {
    async snapshot() { return { workspaces: [], tabs: [], panes: [], agents: [] }; },
    herdrSettingsClient: (id) => (id === LINK ? remote : null),
  };
  const app = createHerdrHttpServer({
    herdr,
    csrfToken: "csrf",
    logger: { error() {} },
    auth: {
      required,
      hasValidSession: (cookie) => cookie === "session=valid",
      hasValidLaunchToken: (token) => token === "launch",
      onSessionsEnded: () => () => {},
    },
    herdrSettings: settings === undefined ? new HerdrSettings({ run: fake.run, home }) : settings,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  context.after(() => new Promise((resolve) => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const session = { Cookie: "session=valid", "X-Herdr-Launch-Token": "launch" };
  const get = (path, headers = {}) => fetch(`${origin}${path}`, { headers: { ...session, ...headers } });
  const send = (method, path, body, headers = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...session, "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const changes = () => fake.state.calls.map((call) => call.args.join(" "))
    .filter((args) => !["--help", "channel show", "integration status", "config check"].includes(args));
  return { origin, get, send, fake, changes, remoteCalls, configPath };
}

test("the Herdr settings routes sit behind the sign-in, same origin and the write token", async (context) => {
  const { origin, get, send, changes } = await fixture(context);
  assert.equal((await fetch(`${origin}/api/herdr/settings`)).status, 401);
  assert.equal((await get("/api/herdr/settings", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await send("POST", "/api/herdr/channel", { channel: "preview" }, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.equal((await send("PUT", "/api/herdr/config", { text: "", version: "none" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await send("POST", "/api/herdr/integrations/pi/install", {}, { "X-Herdr-CSRF": "wrong" })).status, 403);
  assert.deepEqual(changes(), []);
});

test("with sign-in off every Herdr settings route refuses, and bootstrap says the page is there", async (context) => {
  const { origin, changes } = await fixture(context, { required: false });
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json();
  assert.equal(bootstrap.herdrSettings, true);
  for (const [method, path] of [
    ["GET", "/api/herdr/settings"], ["GET", "/api/herdr/config"], ["GET", "/api/herdr/config/default"],
    ["POST", "/api/herdr/channel"], ["POST", "/api/herdr/integrations/pi/install"], ["POST", "/api/herdr/config/check"],
    ["PUT", "/api/herdr/config"],
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { "Content-Type": "application/json", "X-Herdr-CSRF": "csrf", Origin: origin },
      body: method === "GET" ? undefined : JSON.stringify({ channel: "preview", text: "", version: "none" }),
    });
    assert.equal(response.status, 409, path);
    assert.equal((await response.json()).error.code, "password_auth_required", path);
  }
  assert.deepEqual(changes(), []);
});

test("without a settings manager the page is not offered and the routes say so", async (context) => {
  const { get } = await fixture(context, { settings: null });
  assert.equal((await (await get("/api/bootstrap")).json()).herdrSettings, false);
  const response = await get("/api/herdr/settings");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "herdr_settings_unavailable");
});

test("reads and changes this PC's channel and integrations", async (context) => {
  const { get, send, changes } = await fixture(context);
  const state = await (await get("/api/herdr/settings")).json();
  assert.equal(state.server, "local");
  assert.equal(state.channel, "stable");
  assert.ok(state.integrations.some((item) => item.name === "claude" && item.state === "current"));
  assert.doesNotMatch(JSON.stringify(state), /\/home\/me/u);

  let response = await send("POST", "/api/herdr/channel", { channel: "preview" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).channel, "preview");
  response = await send("POST", "/api/herdr/integrations/pi/install", {});
  assert.equal(response.status, 200);
  response = await send("POST", "/api/herdr/integrations/--all/install", {});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "invalid_integration");
  assert.equal((await send("POST", "/api/herdr/integrations/pi/repair", {})).status, 404);
  assert.equal((await send("POST", "/api/herdr/channel", { channel: "nightly" })).status, 400);
  assert.equal((await send("DELETE", "/api/herdr/channel", {})).status, 405);
  assert.deepEqual(changes(), ["channel set preview", "integration install pi"]);
});

test("checks and saves config.toml; a refused config keeps the file and says why", async (context) => {
  const { get, send, changes, configPath } = await fixture(context);
  const read = await (await get("/api/herdr/config")).json();
  assert.equal(read.text, "onboarding = false\n");
  assert.equal(read.path.endsWith("/.config/herdr/config.toml"), true);

  let response = await send("POST", "/api/herdr/config/check", { text: "[ui\n" });
  assert.equal(response.status, 200);
  const checked = await response.json();
  assert.equal(checked.ok, false);
  assert.match(checked.diagnostics, /invalid table header/u);

  response = await send("PUT", "/api/herdr/config", { text: "[ui\n", version: read.version });
  assert.equal(response.status, 422);
  const refused = await response.json();
  assert.equal(refused.error.code, "config_invalid");
  assert.match(refused.error.details.diagnostics, /invalid table header/u);
  assert.equal(await readFile(configPath, "utf8"), "onboarding = false\n");

  response = await send("PUT", "/api/herdr/config", { text: "onboarding = true\n", version: read.version });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.reloaded, true);
  assert.match(saved.backup, /^config\.toml\.bak-/u);
  assert.equal(await readFile(configPath, "utf8"), "onboarding = true\n");

  response = await send("PUT", "/api/herdr/config", { text: "onboarding = false\n", version: read.version });
  assert.equal(response.status, 409, "the version read before the save is stale");
  assert.deepEqual(changes(), ["server reload-config"]);

  const defaults = await (await get("/api/herdr/config/default")).json();
  assert.match(defaults.text, /^# herdr configuration/u);
});

test("a config up to the cap gets through the body limit; a larger one is refused", async (context) => {
  const { send } = await fixture(context);
  const big = `# ${"\"".repeat(MAX_CONFIG_BYTES - 3)}\n`;
  let response = await send("POST", "/api/herdr/config/check", { text: big });
  assert.equal(response.status, 200);
  response = await send("POST", "/api/herdr/config/check", { text: `${big}#` });
  assert.equal(response.status, 413);
  assert.equal((await send("POST", "/api/herdr/channel", { channel: "stable", pad: "x".repeat(32 * 1024) })).status, 413,
    "the other routes keep the usual limit");
});

test("a connected PC is addressed by its id; an unknown one is refused", async (context) => {
  const { get, send, remoteCalls, changes } = await fixture(context);
  const state = await (await get(`/api/herdr/settings?server=${LINK}`)).json();
  assert.deepEqual([state.server, state.channel], [LINK, "preview"]);
  await send("POST", "/api/herdr/channel", { server: LINK, channel: "stable" });
  await send("POST", "/api/herdr/integrations/codex/uninstall", { server: LINK });
  await send("POST", "/api/herdr/config/check", { server: LINK, text: "a = 1\n" });
  await send("PUT", "/api/herdr/config", { server: LINK, text: "a = 1\n", version: "none" });
  assert.deepEqual(remoteCalls, [["state"], ["channel", "stable"], ["uninstall", "codex"], ["check", "a = 1\n"], ["save", "a = 1\n", "none"]]);
  assert.equal((await get("/api/herdr/settings?server=link_nope")).status, 404);
  assert.deepEqual(changes(), []);
});
