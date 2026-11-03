// Colours for a few languages an agent writes most (JavaScript/TypeScript,
// Python, shell, JSON, CSS, diff), in the chat's code blocks. A small
// tokenizer cuts the code into pieces; each coloured piece is a <span> whose
// text is set as text, so nothing in the code is ever read as markup. Any
// other language, or a block too long to cut cheaply, stays plain.
//
// The tokens are only a reader's aid: no parser, so a JavaScript regex
// literal or a shell heredoc may colour wrong. The text is always the code.

// Past this many characters a block is left plain.
export const MAX_HIGHLIGHT_CHARS = 30_000;

const ALIASES = {
  javascript: ["js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx", "mts", "cts"],
  python: ["py", "python", "python3"],
  shell: ["sh", "bash", "zsh", "shell"],
  json: ["json", "jsonc", "json5"],
  css: ["css"],
  diff: ["diff", "patch"],
};
const LANGUAGE_OF = new Map(Object.entries(ALIASES).flatMap(([language, names]) => names.map((name) => [name, language])));

// The language a fence's name stands for, or null for one not coloured.
export function codeLanguage(name) {
  return LANGUAGE_OF.get(String(name ?? "").toLowerCase()) ?? null;
}

const words = (text) => new Set(text.split(" "));

// Each language: its pieces in the order they are tried at a place, a word
// pattern, and the words that are keywords. A rule is [kind, sticky regex].
// No pattern looks further back than the character before it, or ahead past
// what it takes, so a block is read once, left to right.
const stringLine = (quote) => new RegExp(`${quote}(?:[^${quote}\\\\\\n]|\\\\.)*${quote}?`, "uy");
const LANGUAGES = {
  javascript: {
    rules: [
      ["comment", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/uy],
      ["string", /`(?:[^`\\]|\\[\s\S])*`?/uy],
      ["string", stringLine('"')],
      ["string", stringLine("'")],
      ["number", /(?:0[xX][\da-fA-F_]+|0[bBoO][\d_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)n?/uy],
    ],
    word: /[A-Za-z_$][\w$]*/uy,
    // digits run into a name (`1a`) are no number: the run reads as plain
    tail: /[\w$]+/uy,
    keywords: words("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of true false null undefined interface type enum implements private protected public readonly declare namespace abstract as satisfies keyof infer is"),
  },
  python: {
    rules: [
      ["comment", /#[^\n]*/uy],
      ["string", /(?:[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)/uy],
      ["number", /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)j?/uy],
    ],
    word: /[A-Za-z_]\w*/uy,
    tail: /\w+/uy,
    keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case True False None self"),
  },
  shell: {
    rules: [
      // a comment begins a word: `a#b` and `${#list}` are no comments
      ["comment", /(?<![^\s;|&()])#[^\n]*/uy],
      ["string", /'[^']*'?/uy],
      ["string", /"(?:[^"\\]|\\[\s\S])*"?/uy],
    ],
    // a flag is one word: `--if-present` holds no keyword
    word: /[\w.-]+/uy,
    keywords: words("if then else elif fi for while until do done case esac in function select return export local readonly"),
  },
  json: {
    rules: [
      ["string", stringLine('"')],
      ["number", /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/uy],
    ],
    word: /[A-Za-z_]\w*/uy,
    keywords: words("true false null"),
  },
  css: {
    rules: [
      ["comment", /\/\*[\s\S]*?(?:\*\/|$)/uy],
      ["string", stringLine('"')],
      ["string", stringLine("'")],
      ["keyword", /@[\w-]+/uy],
      ["number", /#[\da-fA-F]{3,8}(?![\w-])|-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?/uy],
    ],
    word: /[\w-]+/uy,
    keywords: new Set(),
  },
};

// [{ kind, text }] that joined are `code`; `kind` is null for plain text,
// else "keyword", "string", "comment", "number", or for a diff "add", "del",
// "meta". Null when the language is not coloured or the code is too long.
export function codeTokens(code, name) {
  const language = codeLanguage(name);
  const text = String(code);
  if (language === null || text.length > MAX_HIGHLIGHT_CHARS) return null;
  const tokens = [];
  const push = (kind, piece) => {
    const last = tokens.at(-1);
    if (kind === null && last?.kind === null) last.text += piece;
    else tokens.push({ kind, text: piece });
  };
  if (language === "diff") {
    text.split("\n").forEach((line, index) => {
      if (index > 0) push(null, "\n");
      if (line === "") return;
      const kind = /^(?:\+\+\+|---|@@)/u.test(line) ? "meta" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : null;
      push(kind, line);
    });
    return tokens;
  }
  const { rules, word, tail, keywords } = LANGUAGES[language];
  let at = 0;
  outer: while (at < text.length) {
    for (const [kind, pattern] of rules) {
      pattern.lastIndex = at;
      const match = pattern.exec(text);
      // (a pattern that took nothing would never move on)
      if (match !== null && match[0].length > 0) {
        let piece = match[0];
        let pieceKind = kind;
        if (kind === "number" && tail) {
          tail.lastIndex = at + piece.length;
          const rest = tail.exec(text);
          if (rest !== null) { piece += rest[0]; pieceKind = null; }
        }
        push(pieceKind, piece);
        at += piece.length;
        continue outer;
      }
    }
    word.lastIndex = at;
    const match = word.exec(text);
    if (match !== null) {
      push(keywords.has(match[0]) ? "keyword" : null, match[0]);
      at += match[0].length;
      continue;
    }
    // one character (a whole surrogate pair), plain
    const piece = String.fromCodePoint(text.codePointAt(at));
    push(null, piece);
    at += piece.length;
  }
  return tokens;
}

// Colours one code element in place from its own text, by `language`: a text
// node per plain run, a span per token, its text set as text. False when the
// language is not coloured, and the element is left as it was.
export function highlightCode(code, language, document) {
  const tokens = codeTokens(code.textContent, language);
  if (tokens === null) return false;
  code.replaceChildren(...tokens.map((token) => {
    if (token.kind === null) return document.createTextNode(token.text);
    const span = document.createElement("span");
    span.className = `md-tok is-${token.kind}`;
    span.textContent = token.text;
    return span;
  }));
  return true;
}

// Colours every code block markdown.js drew under `root`, by the language
// its fence named.
export function highlightCodeBlocks(root) {
  for (const block of root.querySelectorAll(".md-code[data-language]")) {
    const code = block.querySelector("pre > code");
    if (code) highlightCode(code, block.dataset.language, root.ownerDocument);
  }
}
