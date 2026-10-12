// Ported from herdr-web-ui (MIT), src/lib/terminalWidths.ts.
//
// herdr lays its screen out with current Unicode widths, and its attach stream
// counts on xterm advancing the cursor exactly as far. xterm's grapheme addon
// agrees with herdr except in three places, each corrected here:
// - a spacing mark (Thai SARA AM, a Devanagari vowel sign) gets its own cell;
// - an emoji newer than the addon's tables, which the browser knows as
//   emoji-presentation, takes two cells and joins like any other emoji;
// - invisible format characters (zero-width space, direction marks, Hangul
//   filler) take no cell. ZWJ, variation selectors, tags and Hangul jamo stay
//   with the addon.

export const HERDR_UNICODE_VERSION = "15-herdr";

const SPACING_MARK = /[\p{Mc}ำຳ]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const INVISIBLE = /(?![­ᄀ-ᇿ‍︀-️\u{e0000}-\u{e0fff}])\p{Default_Ignorable_Code_Point}/u;
// Below these, the tests above cannot match.
const FIRST_INVISIBLE = 0x034f;
const FIRST_SPACING_MARK = 0x0903;
const FIRST_EMOJI_PRESENTATION = 0x231a;
// Regional indicators are emoji-presentation one at a time, but only a pair is a flag.
const REGIONAL_INDICATORS = [0x1f1e6, 0x1f1ff];
// A two-cell emoji the addon knows, standing in for a newer one that joins the same way.
const KNOWN_WIDE_EMOJI = 0x1f600;
// A zero-width character the addon joins to the cell before, standing in for one it does not.
const KNOWN_INVISIBLE = 0x200c;

export function herdrWidthProvider(UnicodeGraphemesAddon) {
  // The addon hands its providers only to terminal.unicode.register.
  let graphemes;
  const collector = {
    unicode: {
      register: (provider) => { if (provider.version === "15-graphemes") graphemes = provider; },
      activeVersion: "",
    },
  };
  new UnicodeGraphemesAddon().activate(collector);
  if (!graphemes) throw new Error("the grapheme addon registered no 15-graphemes provider");
  const inner = graphemes;
  const kinds = new Map();
  const kindOf = (codepoint) => {
    if (codepoint < FIRST_INVISIBLE) return "plain";
    let kind = kinds.get(codepoint);
    if (kind === undefined) {
      const char = String.fromCodePoint(codepoint);
      if (INVISIBLE.test(char)) kind = "invisible";
      else if (codepoint >= FIRST_SPACING_MARK && SPACING_MARK.test(char)) kind = "spacing-mark";
      else if (
        codepoint >= FIRST_EMOJI_PRESENTATION
        && (codepoint < REGIONAL_INDICATORS[0] || codepoint > REGIONAL_INDICATORS[1])
        && inner.wcwidth(codepoint) === 1
        && EMOJI_PRESENTATION.test(char)
      ) kind = "newer-emoji";
      else kind = "plain";
      kinds.set(codepoint, kind);
    }
    return kind;
  };
  return {
    version: HERDR_UNICODE_VERSION,
    wcwidth: (codepoint) => {
      const kind = kindOf(codepoint);
      return kind === "newer-emoji" ? 2 : kind === "invisible" ? 0 : inner.wcwidth(codepoint);
    },
    charProperties: (codepoint, preceding) => {
      switch (kindOf(codepoint)) {
        case "newer-emoji": return inner.charProperties(KNOWN_WIDE_EMOJI, preceding);
        case "spacing-mark": return inner.charProperties(codepoint, 0);
        // At the start of a line there is no cell to join; the addon's answer stands there.
        case "invisible": return inner.charProperties(preceding === 0 ? codepoint : KNOWN_INVISIBLE, preceding);
        default: return inner.charProperties(codepoint, preceding);
      }
    },
  };
}

// Makes `term` count cells as herdr does.
export function matchHerdrWidths(term, UnicodeGraphemesAddon) {
  term.unicode.register(herdrWidthProvider(UnicodeGraphemesAddon));
  term.unicode.activeVersion = HERDR_UNICODE_VERSION;
}
