# xterm.js bundle

`public/vendor/xterm.mjs` is xterm.js 5.5.0 built from its TypeScript source with
`xterm-5.5.0-ime.patch` applied, bundled with `@xterm/addon-fit` 0.10.0,
`@xterm/addon-unicode-graphemes` 0.4.0 and `@xterm/addon-web-links` 0.11.0 into one
minified ES module. `public/vendor/xterm.css` is the package's `css/xterm.css`.

The patch comes from herdr-web-ui (MIT). It fixes Korean and Android (Gboard)
composition in xterm's textarea; the fix is in xterm's source, not its published
bundle, so the bundle is built here instead of copied.

To rebuild, in an empty directory outside this repository:

```sh
npm init -y
npm install @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0 @xterm/addon-unicode-graphemes@0.4.0 @xterm/addon-web-links@0.11.0 typescript@5.6.3 esbuild@0.24.0
(cd node_modules/@xterm/xterm && patch -p1 < /path/to/herdrabbit/vendor/xterm/xterm-5.5.0-ime.patch)
cp /path/to/herdrabbit/vendor/xterm/build.mjs . && node build.mjs .
cp out/xterm.mjs /path/to/herdrabbit/public/vendor/xterm.mjs
cp node_modules/@xterm/xterm/css/xterm.css /path/to/herdrabbit/public/vendor/xterm.css
```

Changing the xterm version means checking the patch again against the new source.
