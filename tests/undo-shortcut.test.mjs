import assert from "node:assert/strict";
import test from "node:test";

import {
  isApplePlatform,
  isUndoShortcut,
  undoShortcutKeys
} from "../src/components/human/undo-shortcut.ts";

/**
 * A key press, by what the key types, where it sits and what is held.
 * @param {string} key
 * @param {string} code
 * @param {("ctrl" | "meta" | "shift" | "alt")[]} held
 */
function press(key, code, held) {
  return {
    key,
    code,
    ctrlKey: held.includes("ctrl"),
    metaKey: held.includes("meta"),
    shiftKey: held.includes("shift"),
    altKey: held.includes("alt")
  };
}

const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("undo is Cmd+Z on Apple platforms and Ctrl+Z elsewhere", () => {
  assert.deepEqual(
    [MAC, IPHONE, WINDOWS, LINUX, ANDROID].map(isApplePlatform),
    [true, true, false, false, false]
  );
  assert.equal(undoShortcutKeys(true), "Meta+Z");
  assert.equal(undoShortcutKeys(false), "Control+Z");

  assert.equal(isUndoShortcut(press("z", "KeyZ", ["ctrl"]), false), true);
  assert.equal(isUndoShortcut(press("z", "KeyZ", ["meta"]), true), true);
  // The other platform's shortcut does nothing, so Ctrl+Z on a Mac cannot
  // reverse an answer by accident.
  assert.equal(isUndoShortcut(press("z", "KeyZ", ["meta"]), false), false);
  assert.equal(isUndoShortcut(press("z", "KeyZ", ["ctrl"]), true), false);
});

test("only the modifier alone with Z is the undo shortcut", () => {
  for (const apple of [true, false]) {
    const modifier = apple ? "meta" : "ctrl";
    // Caps Lock types an uppercase letter.
    assert.equal(isUndoShortcut(press("Z", "KeyZ", [modifier]), apple), true);
    assert.equal(isUndoShortcut(press("z", "KeyZ", []), apple), false);
    assert.equal(isUndoShortcut(press("y", "KeyY", [modifier]), apple), false);
    // Redo, and presses with a second modifier, are other shortcuts.
    for (const extra of /** @type {const} */ (["shift", "alt"])) {
      assert.equal(
        isUndoShortcut(press("z", "KeyZ", [modifier, extra]), apple),
        false
      );
    }
    assert.equal(
      isUndoShortcut(press("z", "KeyZ", ["ctrl", "meta"]), apple),
      false
    );
  }
});

test("the shortcut follows the letter Z across keyboard layouts", () => {
  // QWERTZ: Z is typed where a US keyboard has Y, and Y where it has Z.
  assert.equal(isUndoShortcut(press("z", "KeyY", ["ctrl"]), false), true);
  assert.equal(isUndoShortcut(press("y", "KeyZ", ["ctrl"]), false), false);
  // AZERTY: Z is typed where a US keyboard has W.
  assert.equal(isUndoShortcut(press("z", "KeyW", ["ctrl"]), false), true);
  assert.equal(isUndoShortcut(press("w", "KeyZ", ["ctrl"]), false), false);
  // Dvorak: the US Z position types a semicolon, which is not undo.
  assert.equal(isUndoShortcut(press(";", "KeyZ", ["ctrl"]), false), false);
  // Layouts without Latin letters use the position of Z.
  assert.equal(isUndoShortcut(press("я", "KeyZ", ["ctrl"]), false), true);
  assert.equal(isUndoShortcut(press("ζ", "KeyZ", ["meta"]), true), true);
  assert.equal(isUndoShortcut(press("я", "KeyX", ["ctrl"]), false), false);
});
