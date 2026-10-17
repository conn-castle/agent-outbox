import { decodeHTML } from "entities";

function htmlTagStrippedText(html: string) {
  return collapseWhitespace(html.replace(/<[^>]*>/g, " "));
}

// Human-visible and accessible text. Decode only after stripping tags because
// caller HTML encodes literal angle brackets as `&lt;` and `&gt;`.
// If decoding semantics change (including entities upgrades), add a migration
// setting review_text_source_sha256 = null so maintenance re-derives stored text.
export function htmlToPlainText(html: string) {
  return collapseWhitespace(decodeHTML(htmlTagStrippedText(html)));
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
