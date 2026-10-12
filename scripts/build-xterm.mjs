// Builds public/vendor/xterm.mjs: xterm.js from its TypeScript source with
// vendor/xterm/xterm-5.5.0-ime.patch applied, bundled with its addons into one
// minified ES module. `--check` builds into a temporary directory and fails
// when the result differs from the committed bundle.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const xtermPackage = join(root, "node_modules/@xterm/xterm");
const version = JSON.parse(readFileSync(join(xtermPackage, "package.json"), "utf8")).version;
if (version !== "5.5.0") throw new Error("Check the composition patch again before building another xterm version");
const bundlePath = join(root, "public/vendor/xterm.mjs");
const check = process.argv.includes("--check");

const work = mkdtempSync(join(tmpdir(), "herdrabbit-xterm-"));
try {
  // The patch goes on a copy: node_modules stays as npm installed it.
  const source = join(work, "src");
  cpSync(join(xtermPackage, "src"), source, { recursive: true });
  execFileSync("patch", ["-p1", "--quiet", "-i", join(root, "vendor/xterm/xterm-5.5.0-ime.patch")], { cwd: work });
  const compiled = join(work, "compiled");
  const program = ts.createProgram(ts.sys.readDirectory(source, [".ts"], undefined, ["**/*"]), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: source, outDir: compiled, baseUrl: source, paths: {
      "browser/*": ["browser/*"], "common/*": ["common/*"],
      // The copy is outside node_modules: point it at the package's own typings.
      "@xterm/xterm": [join(xtermPackage, "typings/xterm.d.ts")],
    },
    experimentalDecorators: true, useDefineForClassFields: false, skipLibCheck: true, types: [], noEmitOnError: true,
  });
  const emitted = program.emit();
  if (emitted.emitSkipped) {
    throw new Error(ts.formatDiagnostics(ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics), {
      getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
    }));
  }
  const entry = join(work, "entry.mjs");
  writeFileSync(entry, `export { Terminal } from ${JSON.stringify(join(compiled, "browser/public/Terminal.js"))};
export { FitAddon } from "@xterm/addon-fit";
export { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
export { WebLinksAddon } from "@xterm/addon-web-links";
`);
  const output = join(work, "xterm.mjs");
  await build({
    entryPoints: [entry], bundle: true, format: "esm", minify: true, target: "es2020", outfile: output,
    nodePaths: [compiled, join(root, "node_modules")], legalComments: "eof", logLevel: "warning",
  });
  const built = readFileSync(output);
  if (check) {
    if (!built.equals(readFileSync(bundlePath))) {
      console.error("public/vendor/xterm.mjs differs from a build of its sources; run npm run build:xterm");
      process.exit(1);
    }
    console.log("public/vendor/xterm.mjs matches its sources");
  } else {
    writeFileSync(bundlePath, built);
    cpSync(join(xtermPackage, "css/xterm.css"), join(root, "public/vendor/xterm.css"));
    console.log(`Built ${bundlePath}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
