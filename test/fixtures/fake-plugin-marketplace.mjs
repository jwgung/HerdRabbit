// A small Herdr plugin marketplace index (https://assets.herdr.dev/plugins/index.json,
// schemaVersion 1) and a fetch that answers it, for src/plugin-marketplace.mjs's
// tests and scripts/check-plugins.mjs. The entries copy the real index's shape.

function repository(fields) {
  const { owner, name } = fields;
  return {
    id: 1, fullName: `${owner}/${name}`, owner, name, description: null,
    url: `https://github.com/${owner}/${name}`, stars: 0, forks: 0, openIssues: 0, language: "Rust",
    topics: ["herdr-plugin"], createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    pushedAt: "2026-10-01T00:00:00Z", headCommit: "ad4614fcee1a9049a08ea9ca421889b9ce6966f8",
    manifests: [], firstSeenAt: "2026-08-01T00:00:00.000Z", starsDelta7d: 0, starsDelta30d: null,
    ...fields,
  };
}

const manifest = (fields) => ({
  path: "herdr-plugin.toml", version: "0.1.0", minHerdrVersion: "0.8.0", description: null, platforms: ["linux", "macos"], ...fields,
});

export function marketplaceIndex() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-11-03T21:00:33.655Z",
    pluginCount: 7,
    repositoryCount: 6,
    source: { provider: "github", query: "topic:herdr-plugin is:public", totalCount: 6, truncated: false },
    plugins: [
      repository({
        owner: "zenbu-labs", name: "terminal-browser", description: "A real browser inside your terminal", stars: 4403,
        starsDelta7d: 127, pushedAt: "2026-11-03T20:48:08Z", firstSeenAt: "2026-08-11T04:31:10.754Z", topics: ["browser", "herdr-plugin"],
        manifests: [manifest({
          path: "herdr-plugin/herdr-plugin.toml", id: "zenbu-labs.terminal-browser", name: "Terminal Browser",
          version: "0.1.1", minHerdrVersion: "0.8.2", description: "Open a browser inside herdr",
        })],
      }),
      repository({
        owner: "someone", name: "herdr-notes", description: "Notes beside a pane", stars: 120, starsDelta7d: 40,
        pushedAt: "2026-10-20T00:00:00Z", firstSeenAt: "2026-10-30T00:00:00.000Z",
        manifests: [manifest({ id: "notes", name: "Notes", version: "0.2.0", platforms: ["linux", "macos", "windows"] })],
      }),
      repository({
        owner: "annotate-dev", name: "annotate", description: "Comment on\u200b selections\u0007\u202e", stars: 300,
        pushedAt: "2026-11-01T00:00:00Z",
        manifests: [
          manifest({ id: "annotate", name: "Annotate", version: "0.9.9" }),
          manifest({ path: "links/herdr-plugin.toml", id: "annotate-links", name: "Annotate Links", description: "Ctrl-click links\nin Annotate" }),
        ],
      }),
      repository({
        owner: "jwgung", name: "HerdRabbit", description: "Open your Herdr sessions from a phone", stars: 1,
        manifests: [manifest({ id: "herdrabbit", name: "HerdRabbit", version: "1.4.28", minHerdrVersion: "0.9.0" })],
      }),
      // Each of these is left out: a bad owner, a .git name, a folder with
      // `..`, a manifest that is not herdr-plugin.toml, a bad id.
      repository({ owner: "-bad", name: "x", manifests: [manifest({ id: "x", name: "X" })] }),
      repository({ owner: "ok", name: "tool.git", manifests: [manifest({ id: "tool", name: "Tool" })] }),
      repository({
        owner: "ok", name: "tricks", stars: "lots", pushedAt: "yesterday", url: "javascript:alert(1)",
        manifests: [
          manifest({ path: "../herdr-plugin.toml", id: "up", name: "Up" }),
          manifest({ path: "plugin.toml", id: "other", name: "Other" }),
          manifest({ path: "a/herdr-plugin.toml", id: "--yes", name: "Option" }),
          manifest({ path: "ok/herdr-plugin.toml", id: "tricks", name: "", version: "1.0.0; rm -rf", minHerdrVersion: "latest",
            platforms: ["linux", "Linux!", 3, "linux"] }),
        ],
      }),
      // The same plugin twice is listed once.
      repository({ owner: "someone", name: "herdr-notes", manifests: [manifest({ id: "notes-again", name: "Notes again" })] }),
    ],
  };
}

// A fetch that answers `body` (an object, a string or bytes) with `status`;
// each call is counted, and `hold` keeps it waiting until released.
export function fakeFetch(body = marketplaceIndex(), { status = 200, hold = false, headers = {} } = {}) {
  const calls = [];
  let release = () => {};
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (hold) await new Promise((resolve) => { release = resolve; });
    if (body instanceof Error) throw body;
    const payload = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
    return new Response(payload, { status, headers });
  };
  return { fetch, calls, release: () => release() };
}
