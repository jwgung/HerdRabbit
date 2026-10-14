import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { posix } from "node:path";
import { claudeAdapter, codexAdapter } from "./ai-account-adapters.mjs";
import { dataPaths } from "./config.mjs";

// What the file browser never lists the inside of, opens, or hands out --
// here, over Connect PC, or on a Herdr SSH machine. Sign-ins are changed in
// place (AI accounts) and never read out; these are the files that hold them.
//
//   - HerdRabbit's own settings: the password hash, push keys, connected PCs,
//     announcements and saved AI sign-ins, wherever the environment put them;
//   - ~/.ssh, ~/.gnupg, ~/.aws, ~/.azure, ~/.kube, ~/.password-store,
//     ~/.local/share/keyrings and ~/.config/{gh,gcloud,rclone};
//   - ~/.netrc, ~/.git-credentials, ~/.docker/config.json, ~/.npmrc, ~/.pypirc
//     and ~/.cargo/credentials(.toml);
//   - the AI CLIs' sign-ins, at the paths ai-account-adapters.mjs swaps them
//     at, and ~/.config/claude*.
//
// Every comparison is between real paths, so a symbolic link to a key is the
// key. A path is protected when it is one of the files, or inside one of the
// folders.

const SHARED_FOLDERS = new Set(["/", "/tmp", "/var/tmp", posix.resolve(tmpdir())]);

// A folder of its own is protected whole; a settings file moved into a folder
// that holds other things (home, /tmp) is protected alone.
function ownFolder(folder, home) {
  if (SHARED_FOLDERS.has(folder)) return false;
  return !(home === folder || home.startsWith(`${folder}/`));
}

// The HerdRabbit data a machine without HerdRabbit's environment would have:
// the defaults under its home.
export function defaultDataPaths(home) {
  const settings = posix.join(home, ".config", "herdr-bridge");
  return {
    authFile: posix.join(settings, "auth.json"),
    serversFile: posix.join(settings, "servers.json"),
    announcementsFile: posix.join(settings, "announced.json"),
    aiAccountsDir: posix.join(settings, "ai-accounts"),
    pushFile: posix.join(settings, "push.json"),
  };
}

// The rules for one machine: `home` is its home folder, `env` its environment
// as far as the AI CLIs read it, and `data` where HerdRabbit keeps its own.
export function credentialRules({ home, env = {}, data = defaultDataPaths(home) }) {
  const root = posix.resolve(home);
  const at = (...parts) => posix.join(root, ...parts);
  const environment = { ...env, HOME: root };
  const trees = [at(".ssh"), at(".gnupg"), at(".aws"), at(".azure"), at(".kube"), at(".password-store"),
    at(".local", "share", "keyrings"), at(".config", "gh"), at(".config", "gcloud"), at(".config", "rclone"),
    at(".config", "herdr-bridge"), posix.resolve(data.aiAccountsDir)];
  const files = [at(".netrc"), at(".git-credentials"), at(".docker", "config.json"), at(".npmrc"), at(".pypirc"),
    at(".cargo", "credentials"), at(".cargo", "credentials.toml")];
  for (const file of [data.authFile, data.pushFile, data.serversFile, data.announcementsFile]) {
    const resolved = posix.resolve(file);
    files.push(resolved);
    if (ownFolder(posix.dirname(resolved), root)) trees.push(posix.dirname(resolved));
  }
  const claude = claudeAdapter.locate(environment);
  const codex = codexAdapter.locate(environment);
  files.push(claude.credentials, claude.global, codex.auth);
  return {
    trees: trees.map((path) => posix.resolve(path)),
    files: files.map((path) => posix.resolve(path)),
    // A name that starts this way, directly inside the folder: the Claude
    // configuration folders, and ~/.claude.json's backups beside it.
    prefixes: [
      { parent: at(".config"), prefix: "claude" },
      { parent: posix.dirname(posix.resolve(claude.global)), prefix: posix.basename(claude.global) },
    ],
  };
}

function allRulePaths(rules) {
  return [...rules.trees, ...rules.files, ...rules.prefixes.map((rule) => rule.parent)];
}

// Each rule's path as written and as it resolves, so a settings folder that is
// itself a link into dotfiles is matched by where it really is.
async function resolvedRules(rules, resolve) {
  const paths = allRulePaths(rules);
  const real = await resolve(paths);
  const asWrittenAndResolved = (path) => [...new Set([path, real.get(path) ?? path])];
  return {
    trees: rules.trees.flatMap(asWrittenAndResolved),
    files: rules.files.flatMap(asWrittenAndResolved),
    prefixes: rules.prefixes.flatMap((rule) => asWrittenAndResolved(rule.parent).map((parent) => ({ parent, prefix: rule.prefix }))),
  };
}

function matcher(rules) {
  return (path) => {
    if (typeof path !== "string") return false;
    if (rules.files.includes(path)) return true;
    if (rules.trees.some((tree) => path === tree || path.startsWith(`${tree}/`))) return true;
    return rules.prefixes.some(({ parent, prefix }) => {
      if (!path.startsWith(`${parent}/`)) return false;
      return path.slice(parent.length + 1).split("/", 1)[0].startsWith(prefix);
    });
  };
}

// Builds a guard. `resolve` takes paths and answers a Map of their real paths,
// for paths that do not exist yet as far as they do.
export function protectedPaths(rules, resolve) {
  return {
    // A predicate over real paths. It resolves the rules when asked, so a key
    // folder made or turned into a link since is seen -- by whoever asks again
    // (the local guard asks on every request; an SSH machine, once per
    // connection).
    async matcher() {
      return matcher(await resolvedRules(rules, resolve));
    },
  };
}

// A path that does not exist yet resolves through the part that does.
async function realOrNearest(path) {
  try {
    return await realpath(path);
  } catch {
    const parent = posix.dirname(path);
    if (parent === path) return path;
    return posix.join(await realOrNearest(parent), posix.basename(path));
  }
}

async function resolveLocal(paths) {
  const real = new Map();
  await Promise.all(paths.map(async (path) => real.set(path, await realOrNearest(path))));
  return real;
}

// This machine's guard, from its own environment.
export function localProtectedPaths({ env = process.env, home = env.HOME || homedir(), data = dataPaths(env) } = {}) {
  return protectedPaths(credentialRules({ home, env, data }), resolveLocal);
}

let shared = null;
export function defaultProtectedPaths() {
  shared ??= localProtectedPaths();
  return shared;
}

// Whether `path` -- existing or not -- is, or would land in, a protected path.
// The uploads folder is checked with this before anything is written there.
export async function isProtectedPath(guard, path) {
  const real = await realOrNearest(posix.resolve(path));
  return (await guard.matcher())(real);
}
