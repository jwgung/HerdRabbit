// Ported from herdr-web-ui (MIT), shared/secret-prompt.ts.

// Deliberately narrow: prose that mentions passwords must not become a prompt.
export function secretPrompt(screen, columns = Infinity) {
  const lines = String(screen).split(/\r?\n/u);
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  let line = lines.pop()?.trimEnd() ?? "";
  for (;;) {
    const candidate = line.trimStart();
    if (!candidate || candidate.length > 120 || /\?|y\s*\/\s*n/iu.test(candidate)) return null;
    if (/^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/iu.test(candidate)) return candidate;
    // herdr's screen text loses xterm's soft-wrap flags: only a row that
    // reached the right edge continues onto the next.
    const previous = lines.pop()?.trimEnd();
    if (!previous || previous.length < columns - 1 || previous.length > columns) return null;
    line = (previous.padEnd(columns) + line).trimStart();
  }
}
