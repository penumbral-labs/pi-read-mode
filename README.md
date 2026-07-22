# @penumbral-labs/pi-read-mode

Scroll through conversation history while composing a multiline follow-up in [pi](https://pi.dev/). Read mode captures pi's rendered conversation view and pins Pi TUI's native composer at the bottom so long drafts wrap, multiline text works, and normal editor navigation stays available.

## Install

From npm:

```bash
pi install npm:@penumbral-labs/pi-read-mode
```

From GitHub:

```bash
pi install git:github.com/penumbral-labs/pi-read-mode
```

Or from a local checkout:

```bash
pi install "$(pwd)"
```

Then reload pi:

```text
/reload
```

## Features

- Native Pi TUI multiline composer with wrapping, Unicode editing, undo, and paste handling.
- `Shift+Enter` inserts a newline; `Enter` sends the follow-up.
- `Ctrl+G` opens the draft in `$VISUAL`, then `$EDITOR`, then Pi's platform fallback.
- Mouse and trackpad scrolling continue to scroll conversation history while composing.
- Alt-modified history bindings leave unmodified navigation keys for the composer.
- Captures pi's rendered output instead of reconstructing markdown.

## Usage

| Key | Action |
| --- | --- |
| `Alt+R` | Enter read mode |
| `/read` | Enter read mode |
| Mouse / trackpad scroll | Scroll conversation history |
| `Alt+Up` / `Alt+Down` | Scroll history one line |
| `Alt+PageUp` / `Alt+PageDown` | Scroll history one page |
| `Alt+Home` / `Alt+End` | Jump history to top / bottom |
| `Shift+Enter` | Insert newline in composer |
| `Enter` | Send follow-up message |
| `Ctrl+G` | Edit draft in external editor |
| `Escape` | Cancel and exit |

Read mode is available when the agent is idle.

## External editor

`Ctrl+G` opens the current draft in an external editor. Resolution order:

1. `$VISUAL`
2. `$EDITOR`
3. `notepad` on Windows, `nano` elsewhere

When the editor exits successfully, the draft is replaced with the edited file content. If the editor exits non-zero or cannot start, the existing draft is preserved.

## How it works

When read mode starts, the extension captures pi's already-rendered TUI component tree by calling `render(width)` on the existing children. It then switches to a fullscreen custom component containing the captured history viewport and an embedded `Editor` from `@earendil-works/pi-tui`.

The composer is rendered first on each frame so read mode can reserve the actual number of composer rows. Optional help/status rows collapse before the composer on short terminals, and render output is bounded to the terminal height.

## Development

Run verification:

```bash
npm run verify
```

Inspect package contents:

```bash
npm pack --dry-run --json
```

## License

MIT. Original read-mode copyright and license are retained in `LICENSE`.
