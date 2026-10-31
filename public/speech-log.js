// What dictation's recognizer said, kept in this page only (never stored or
// sent): each result event as the browser gave it, its starts, ends and
// errors, and what the text box held after each. Settings → Speech log shows
// it, so a phone's duplicated words can be seen as the browser sent them.
export const SPEECH_LOG_LIMIT = 300;

const quoted = (text) => JSON.stringify(String(text ?? ""));

// One line of the log. `at` is seconds since the log's first entry.
export function speechLogLine(entry, at) {
  const time = `+${at.toFixed(2)}s`;
  if (entry.type === "result") {
    const results = entry.results
      .map((result, index) => `${index}${result.final ? "F" : "i"} ${quoted(result.text)}`)
      .join(" | ");
    return `${time} result i=${entry.resultIndex} n=${entry.results.length} | ${results} => box ${quoted(entry.box)}`;
  }
  if (entry.type === "error") return `${time} error ${entry.error}${entry.message ? ` ${quoted(entry.message)}` : ""} => box ${quoted(entry.box)}`;
  return `${time} ${entry.type} => box ${quoted(entry.box)}`;
}

// `now` is a clock in milliseconds; a test passes its own.
export function createSpeechLog({ limit = SPEECH_LOG_LIMIT, now = () => Date.now() } = {}) {
  let lines = [];
  let first = null;
  return {
    add(entry) {
      const time = now();
      if (first === null) first = time;
      lines.push(speechLogLine(entry, (time - first) / 1000));
      if (lines.length > limit) lines = lines.slice(-limit);
    },
    clear() { lines = []; first = null; },
    text() { return lines.join("\n"); },
    get size() { return lines.length; },
  };
}
