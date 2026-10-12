import ts from "typescript";
import { build } from "esbuild";
import { join, resolve } from "node:path";
const root = resolve(process.argv[2]);
const source = join(root, "node_modules/@xterm/xterm/src");
const output = join(root, "out/xterm-src");
const program = ts.createProgram(ts.sys.readDirectory(source, [".ts"], undefined, ["**/*"]), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  rootDir: source, outDir: output, baseUrl: source, paths: { "browser/*": ["browser/*"], "common/*": ["common/*"] },
  experimentalDecorators: true, useDefineForClassFields: false, skipLibCheck: true, types: [], noEmitOnError: true,
});
const emitted = program.emit();
if (emitted.emitSkipped) {
  console.error(ts.formatDiagnostics(ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics), { getCanonicalFileName: n => n, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  process.exit(1);
}
const entry = join(root, "out/entry.mjs");
await import("node:fs/promises").then(fs => fs.writeFile(entry, `export { Terminal } from ${JSON.stringify(join(output, "browser/public/Terminal.js"))};
export { FitAddon } from "@xterm/addon-fit";
export { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
export { WebLinksAddon } from "@xterm/addon-web-links";
`));
await build({ entryPoints: [entry], bundle: true, format: "esm", minify: true, target: "es2020", outfile: join(root, "out/xterm.mjs"),
  nodePaths: [output, join(root, "node_modules")], legalComments: "eof", logLevel: "warning" });
