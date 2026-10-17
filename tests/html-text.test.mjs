import assert from "node:assert/strict";
import test from "node:test";

import { htmlToPlainText } from "../src/shared/html-text.ts";

test("plain text decodes named, decimal, and hex character references", () => {
  assert.equal(
    htmlToPlainText(
      "<strong>AT&amp;T</strong> caf&eacute; &mdash; &#8212; &#x2014;"
    ),
    "AT&T café — — —"
  );
});

test("plain text keeps encoded angle brackets as literal text", () => {
  assert.equal(
    htmlToPlainText("<p>Use &lt;b&gt;bold&lt;/b&gt; sparingly</p>"),
    "Use <b>bold</b> sparingly"
  );
});

test("plain text separates tags and collapses whitespace", () => {
  assert.equal(
    htmlToPlainText("<p>first</p><p>second<br>third&nbsp;&nbsp; fourth</p>"),
    "first second third fourth"
  );
});

test("plain text collapses JavaScript whitespace including U+FEFF", () => {
  assert.equal(htmlToPlainText("Visible\uFEFFphrase"), "Visible phrase");
  assert.equal(htmlToPlainText("<b>Send:</b>\n  “Your"), "Send: “Your");
});
