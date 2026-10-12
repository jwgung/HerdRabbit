# xterm.js bundle

`public/vendor/xterm.mjs` is xterm.js 5.5.0 built from its TypeScript source with
`xterm-5.5.0-ime.patch` applied, bundled with `@xterm/addon-fit` 0.10.0,
`@xterm/addon-unicode-graphemes` 0.4.0 and `@xterm/addon-web-links` 0.11.0 into one
minified ES module. `public/vendor/xterm.css` is the package's `css/xterm.css`.

The patch comes from herdr-web-ui (MIT). It fixes Korean and Android (Gboard)
composition in xterm's textarea; the fix is in xterm's source, not its published
bundle, so the bundle is built here instead of copied.

The sources and build tools are pinned in `devDependencies`. After `npm ci`:

```sh
npm run build:xterm   # writes public/vendor/xterm.mjs and public/vendor/xterm.css
npm run check:xterm   # fails when the committed bundle differs from a fresh build (CI runs this)
```

The build copies xterm's source to a temporary directory and applies the patch
there, so `node_modules` stays as npm installed it. It needs the `patch` command.
Changing the xterm version means checking the patch again against the new source.
