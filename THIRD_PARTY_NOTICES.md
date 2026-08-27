# Third-Party Notices

The [PolyForm Perimeter License 1.0.1](LICENSE) in this repository covers Agent
Outbox itself. It does not cover the third-party components listed below, which
are vendored into this repository and remain under their own licenses and
copyright holders.

This file is the canonical inventory of vendored third-party content. Add an
entry here whenever third-party source, documentation, or assets are committed
into the tree.

## Vendored Components

| Path                                                  | Upstream                                                                                               | License    | Copyright                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------- |
| `.agent-layer/skills-imported/apple-design/`          | [emilkowalski/skills](https://github.com/emilkowalski/skills) (`skills/apple-design`)                  | MIT        | Copyright (c) 2026 Emil Kowalski    |
| `.agent-layer/skills-imported/request-html-comments/` | [nicholasjconn/skills](https://github.com/nicholasjconn/skills) (`skills/tools/request-html-comments`) | MIT        | Copyright (c) 2026 Nicholas J. Conn |
| `.agent-layer/skills/playwright/`                     | Playwright project                                                                                     | Apache-2.0 | Copyright (c) Microsoft Corporation |

The two imported skills are managed by Agent Layer; their pinned upstream
commits are recorded in
[`.agent-layer/skills.lock.json`](.agent-layer/skills.lock.json).

`nicholasjconn/skills` is the personal repository of Nicholas J. Conn and is a
separate copyright holder from Hardware Breakout LLC doing business as Conn
Castle Studios, which owns Agent Outbox. It is listed here for that reason.

`.agent-layer/skills/playwright/` retains its upstream Apache License 2.0 text
at
[`.agent-layer/skills/playwright/LICENSE`](.agent-layer/skills/playwright/LICENSE).
Upstream ships no `NOTICE` file, so there is no additional attribution notice to
reproduce.

## MIT License — Copyright (c) 2026 Emil Kowalski

Applies to `.agent-layer/skills-imported/apple-design/`.

```text
MIT License

Copyright (c) 2026 Emil Kowalski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT License — Copyright (c) 2026 Nicholas J. Conn

Applies to `.agent-layer/skills-imported/request-html-comments/`.

```text
MIT License

Copyright (c) 2026 Nicholas J. Conn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache License 2.0 — Copyright (c) Microsoft Corporation

Applies to `.agent-layer/skills/playwright/`. The full license text is retained
in that directory at
[`.agent-layer/skills/playwright/LICENSE`](.agent-layer/skills/playwright/LICENSE)
and is not duplicated here.
