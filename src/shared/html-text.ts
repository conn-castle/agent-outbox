import { decodeHTML } from "entities";

// Mirrors the production SQL title sort text: tags become spaces and character
// references stay encoded, matching the encoded-text semantics of SQL search.
export function htmlTagStrippedText(html: string) {
  return collapseWhitespace(html.replace(/<[^>]*>/g, " "));
}

// Human-visible and accessible text. Decode only after stripping tags because
// caller HTML encodes literal angle brackets as `&lt;` and `&gt;`.
export function htmlToPlainText(html: string) {
  return collapseWhitespace(decodeHTML(htmlTagStrippedText(html)));
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
