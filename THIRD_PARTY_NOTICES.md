# Third-party notices

## herdr-web-ui

Parts of the terminal attachment (`src/pane-attachments.mjs`, `src/output-window.mjs`,
`src/attach-output.mjs`, `public/secret-prompt.js`, `public/xterm-terminal.js`,
`public/terminal-widths.js`), the Claude and Codex conversation readers (`src/conversation/pages.mjs`,
`src/conversation/claude.mjs`, `src/conversation/codex.mjs`, `src/conversation/monitor.mjs`, and the Codex
rollout fixtures in `test/conversation-codex.test.mjs`), the Chat lens (`public/chat/chat-view.js`,
`public/chat/chat-view.css`, `public/chat/markdown.js`, `public/chat/diff.js`, `public/chat/work-blocks.js`,
`public/chat/conversation-refresh.js`), the prompt cards (`src/prompt/screen.mjs`, `src/prompt/claude.mjs`,
`src/prompt/codex.mjs`, `src/prompt/fallback.mjs`, `src/prompt/service.mjs`, `public/chat/prompt-card.js`,
`public/chat/prompt-card.css`, and the Claude and Codex screens in `test/prompt-claude.test.mjs`,
`test/prompt-codex.test.mjs` and `test/fixtures/codex-prompt.mjs`), the messages queued for the next turn (`src/pending-input.mjs`,
`public/chat/pending-messages.js`, `public/chat/pending-messages.css`), the editable extra-keys bar
(`public/key-bar-preference.js`, `public/key-bar.css`), the per-pane composer drafts
(`public/composer-draft-preference.js`) and the xterm composition patch
(`vendor/xterm/xterm-5.5.0-ime.patch`, applied by `scripts/build-xterm.mjs`) are adapted from herdr-web-ui,
https://github.com/devswha/herdr-web-ui

MIT License. Copyright (c) 2026 devswha. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated documentation files
(the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do so, subject to
the following conditions: The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
"AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

## xterm.js and its addons

`public/vendor/xterm.mjs` and `public/vendor/xterm.css` contain xterm.js 5.5.0,
@xterm/addon-fit, @xterm/addon-unicode-graphemes and @xterm/addon-web-links,
https://github.com/xtermjs/xterm.js

MIT License. Copyright (c) 2017-2019, The xterm.js authors; Copyright (c) 2014-2016,
SourceLair Private Company; Copyright (c) 2012-2013, Christopher Jeffrey. Same permission
notice and warranty disclaimer as above.

## node-pty

`@lydell/node-pty` repackages node-pty (MIT, Copyright (c) 2012-2015 Christopher Jeffrey,
Copyright (c) 2016 Microsoft Corporation), https://github.com/microsoft/node-pty
