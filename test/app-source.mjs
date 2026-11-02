import { readdir, readFile } from "node:fs/promises";

// The page's own script: public/app.js and the modules it is split into under
// public/app/. Tests that read the page's source read all of it, so moving a
// function between these files changes nothing they check.
const publicRoot = new URL("../public/", import.meta.url);

export async function appModuleFiles() {
  const names = await readdir(new URL("app/", publicRoot)).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.filter((name) => name.endsWith(".js")).sort().map((name) => `app/${name}`);
}

export async function readAppSource() {
  const files = ["app.js", ...await appModuleFiles()];
  const parts = await Promise.all(files.map((name) => readFile(new URL(name, publicRoot), "utf8")));
  return parts.join("\n");
}
