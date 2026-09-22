import test from "node:test";

test("hangs", () => new Promise(() => {}));
