/**
 * The keyboard shortcut for the review queue's Undo control: Cmd+Z on Apple
 * platforms and Ctrl+Z everywhere else, as in the platform's own undo.
 */

type UndoKeyPress = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

// Input types with no text of their own to undo.
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit"
]);

/** Whether the browser runs on a platform whose undo is Cmd+Z. */
export function isApplePlatform(userAgent: string) {
  return /Macintosh|iPhone|iPad|iPod/.test(userAgent);
}

/** The shortcut in `aria-keyshortcuts` form. */
export function undoShortcutKeys(applePlatform: boolean) {
  return applePlatform ? "Meta+Z" : "Control+Z";
}

/**
 * Whether a key press is the undo shortcut: the platform's modifier alone
 * with Z. The key is matched by the letter it types, so the shortcut follows
 * QWERTZ, AZERTY and Dvorak layouts. A key that types a non-ASCII character
 * (a Cyrillic or Greek layout, say) is matched by its position instead.
 */
export function isUndoShortcut(event: UndoKeyPress, applePlatform: boolean) {
  const typesNonAscii =
    event.key.length === 1 && event.key.charCodeAt(0) > 0x7f;
  const z = typesNonAscii
    ? event.code === "KeyZ"
    : event.key.toLowerCase() === "z";
  const modifier = applePlatform
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  return z && modifier && !event.shiftKey && !event.altKey;
}

/**
 * Whether the element a key press went to keeps the shortcut for itself: a
 * field with text to undo, or anything inside a dialog.
 */
export function keepsUndoShortcut(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog, [role="dialog"]')) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  return target instanceof HTMLElement && target.isContentEditable;
}
