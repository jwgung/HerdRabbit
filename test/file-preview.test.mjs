import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TEXT_PREVIEW_BYTES,
  inlineTypeFor,
  looksLikeText,
  parseByteRange,
  previewFor,
} from "../public/file-preview.js";

test("hands the browser a type only for formats that cannot execute", () => {
  // The whole reason downloads are octet-stream attachments is that a stored
  // page or SVG rendered at this origin sits inside the session it could steal.
  // The viewer opens a second door, so the list it opens for is the point.
  assert.deepEqual(previewFor("shot.png"), { kind: "image", type: "image/png" });
  assert.deepEqual(previewFor("clip.MP4"), { kind: "video", type: "video/mp4" });
  assert.deepEqual(previewFor("note.m4a"), { kind: "audio", type: "audio/mp4" });

  // A framed document does get a type, because what makes it safe is the CSP
  // its response carries rather than the absence of one.
  assert.equal(inlineTypeFor("page.html"), "text/html");
  assert.equal(inlineTypeFor("manual.pdf"), "application/pdf");
  // Text has none: it is read as bytes and written in as characters.
  assert.equal(inlineTypeFor("server.log"), null);
  assert.equal(inlineTypeFor("archive.zip"), null);
});

test("draws markup instead of spelling it out, and keeps the spelling available", () => {
  // Refusing to draw an SVG would have been the easy call and the wrong one: a
  // picture shown as its own source is a picture nobody can see. It is safe
  // because of how it is shown -- an <img> runs no script, and this app's
  // script-src 'self' blocks inline script even for someone who opens the raw
  // URL. Both were measured against a probe SVG that tried to call home.
  assert.deepEqual(previewFor("logo.svg"), { kind: "image", type: "image/svg+xml", source: true });
  assert.deepEqual(previewFor("report.html"), { kind: "document", type: "text/html", source: true });
  assert.deepEqual(previewFor("manual.pdf"), { kind: "pdf", type: "application/pdf" });
});

test("still draws markup too long to read as text", () => {
  // Length is a limit on holding a file in the page as characters, not on
  // letting the browser draw it, so only the source half goes away.
  const huge = MAX_TEXT_PREVIEW_BYTES + 1;
  assert.deepEqual(previewFor("big.svg", huge), { kind: "image", type: "image/svg+xml", source: false });
  assert.equal(previewFor("big.html", huge).source, false);
  assert.equal(previewFor("big.html", huge).kind, "document");
  // A PDF is never read as characters, so length was never its limit.
  assert.equal(previewFor("big.pdf", huge).kind, "pdf");
});

test("shows ordinary text as characters", () => {
  assert.equal(previewFor("server.log").kind, "text");
  assert.equal(previewFor(".gitignore").kind, "text");
  assert.equal(previewFor("Dockerfile").kind, "text");
});

test("offers nothing for a file that is surely not text", () => {
  assert.equal(previewFor("archive.zip"), null);
  assert.equal(previewFor("report.docx"), null);
  assert.equal(previewFor("lib.so"), null);
  assert.equal(previewFor(""), null);
  assert.equal(previewFor(null), null);
  // The last dot decides, so a name that ends in a known one still counts.
  assert.equal(previewFor("release.tar.gz"), null);
  assert.equal(previewFor("photo.tar.png").kind, "image");
});

test("tries any other name as text, and says it is only a try", () => {
  // Plenty of text has an extension nobody listed (a unit file, a LICENSE, a
  // .mdc rule). Text never reaches the browser as a type of its own -- bytes in,
  // characters out -- so trying costs nothing but a read, and the viewer looks
  // at the bytes before it shows them.
  for (const name of ["herdr.service", "LICENSE", "rules.mdc", "herdr", "notes.org"]) {
    assert.deepEqual(previewFor(name), { kind: "text", type: null, probe: true }, name);
  }
  // A name on the list is text for sure.
  assert.equal(previewFor("server.log").probe, undefined);
  // A try is still held to the text length.
  assert.equal(previewFor("LICENSE", MAX_TEXT_PREVIEW_BYTES + 1), null);
});

test("tells text from binary by its bytes", () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(looksLikeText(bytes("[Unit]\nDescription=한글도 텍스트\n")), true);
  assert.equal(looksLikeText(new Uint8Array(0)), true);
  assert.equal(looksLikeText(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00])), false);
});

test("keeps a text view from swallowing a file the tab cannot render", () => {
  assert.equal(previewFor("huge.log", MAX_TEXT_PREVIEW_BYTES + 1), null);
  assert.equal(previewFor("huge.log", MAX_TEXT_PREVIEW_BYTES).kind, "text");
  // A media file is streamed, not held, so its size is not this check's business.
  assert.equal(previewFor("film.mp4", 5e9).kind, "video");
});

test("reads the one range form a player actually sends", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseByteRange("bytes=-200", 1000), { start: 800, end: 999 });
  // Past the end is clamped, not refused: a player guessing long is normal.
  assert.deepEqual(parseByteRange("bytes=900-5000", 1000), { start: 900, end: 999 });
});

test("separates a range it cannot satisfy from one it cannot read", () => {
  // Unsatisfiable earns a 416; unreadable is treated as no range at all, which
  // is what RFC 9110 asks for -- the whole file is a correct answer there.
  assert.deepEqual(parseByteRange("bytes=1000-", 1000), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=300-100", 1000), { unsatisfiable: true });
  assert.equal(parseByteRange("bytes=0-99, 200-299", 1000), null);
  assert.equal(parseByteRange("items=0-99", 1000), null);
  assert.equal(parseByteRange("bytes=-", 1000), null);
  assert.equal(parseByteRange(undefined, 1000), null);
  // Nothing is known about the length, so nothing can be sliced out of it.
  assert.equal(parseByteRange("bytes=0-99", null), null);
});
