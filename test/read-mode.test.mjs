import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extension = await jiti.import("../index.ts");
const {
  ReadModeComponent,
  default: registerReadMode,
  editDraftInExternalEditor,
  getExternalEditorCommand,
  getExternalEditorSpawnInvocation,
  splitEditorCommand,
} = extension;

const theme = {
  fg(_color, text) {
    return text;
  },
};

function fakeKeybindings() {
  return {
    matches(data, action) {
      if (action === "app.editor.external") return data === "\x07";
      return false;
    },
  };
}

function makeTui(rows = 16) {
  const writes = [];
  return {
    children: [],
    renders: [],
    started: 0,
    stopped: 0,
    terminal: {
      rows,
      columns: 80,
      write(data) {
        writes.push(data);
      },
    },
    writes,
    requestRender(force) {
      this.renders.push(force === true);
    },
    start() {
      this.started++;
    },
    stop() {
      this.stopped++;
    },
  };
}

function makeReadMode({ rows = 16, historyLines = 24, notifyError = () => {} } = {}) {
  const tui = makeTui(rows);
  const doneResults = [];
  const history = {
    invalidate() {},
    render() {
      return Array.from({ length: historyLines }, (_, i) => `history-${String(i + 1).padStart(2, "0")}`);
    },
  };
  const component = new ReadModeComponent(tui, theme, fakeKeybindings(), (result) => doneResults.push(result), notifyError);
  const container = {
    children: [component],
    invalidate() {},
    render(width) {
      return component.render(width);
    },
  };
  tui.children = [history, container];
  return { component, tui, doneResults };
}

async function mount(component, width = 60) {
  component.render(width);
  await new Promise((resolve) => setImmediate(resolve));
  return component.render(width);
}

function input(component, text) {
  for (const char of text) component.handleInput(char);
}

function nodeEditorCommand(code) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

test("extension registers /read and Alt+R", () => {
  const registered = { commands: [], shortcuts: [] };

  registerReadMode({
    registerCommand(name, options) {
      registered.commands.push({ name, options });
    },
    registerShortcut(shortcut, options) {
      registered.shortcuts.push({ shortcut, options });
    },
  });

  assert.equal(registered.commands[0].name, "read");
  assert.equal(registered.shortcuts[0].shortcut, "alt+r");
});

test("openReadMode sends submitted multiline text once", async () => {
  let mounted;
  const sent = [];

  await extension.openReadMode(
    {
      sendUserMessage(text) {
        sent.push(text);
      },
    },
    {
      async custom(factory) {
        const tui = makeTui();
        const component = factory(tui, theme, fakeKeybindings(), (result) => {
          mounted.result = result;
        });
        mounted = { component, result: undefined };
        component.setDraft("first\nsecond");
        component.handleInput("\r");
        return mounted.result;
      },
    },
  );

  assert.deepEqual(sent, ["first\nsecond"]);
});

test("native editor accepts newline input and submits multiline text once", async () => {
  const { component, doneResults } = makeReadMode();
  await mount(component);

  input(component, "first line");
  component.handleInput("\n");
  input(component, "second line");
  component.handleInput("\r");

  assert.deepEqual(doneResults, [{ text: "first line\nsecond line" }]);
});

test("unmodified navigation stays with editor while Alt navigation scrolls history", async () => {
  const { component } = makeReadMode({ rows: 14, historyLines: 40 });
  await mount(component);
  component.render(60);
  const initialOffset = component.scrollOffset;

  component.handleInput("\x1b[A");
  assert.equal(component.scrollOffset, initialOffset, "plain Up must not scroll history");

  component.handleInput("\x1b[1;3A");
  assert.equal(component.scrollOffset, initialOffset - 1, "Alt+Up scrolls history one line");

  component.handleInput("\x1b[1;3F");
  assert.equal(component.scrollOffset, component.contentLines.length - component.viewportRows, "Alt+End jumps to bottom");

  component.handleInput("\x1b[1;3H");
  assert.equal(component.scrollOffset, 0, "Alt+Home jumps to top");

  component.handleInput("\x1b[6;3~");
  assert.equal(component.scrollOffset, Math.max(1, component.viewportRows - 2), "Alt+PageDown scrolls by page");
});

test("mouse wheel scrolls history while composing", async () => {
  const { component } = makeReadMode({ rows: 14, historyLines: 40 });
  await mount(component);
  component.handleInput("\x1b[1;3H");

  component.handleInput("\x1b[<65;1;1M");
  assert.equal(component.scrollOffset, 3);

  component.handleInput("\x1b[<64;1;1M");
  assert.equal(component.scrollOffset, 0);
});

test("composer growth reduces history viewport and render stays bounded", async () => {
  const { component, tui } = makeReadMode({ rows: 14, historyLines: 40 });
  const initial = await mount(component, 50);
  const initialViewportRows = component.viewportRows;

  component.setDraft(["one", "two", "three", "four", "five", "six"].join("\n"));
  const grown = component.render(50);

  assert.equal(initial.length, tui.terminal.rows);
  assert.equal(grown.length, tui.terminal.rows);
  assert.ok(component.viewportRows < initialViewportRows);
});

test("focus propagates to the embedded editor cursor marker", async () => {
  const { component } = makeReadMode({ rows: 12, historyLines: 4 });
  await mount(component, 50);

  component.focused = true;
  assert.match(component.render(50).join("\n"), /\x1b_pi:c\x07/);

  component.focused = false;
  assert.doesNotMatch(component.render(50).join("\n"), /\x1b_pi:c\x07/);
});

test("external editor helpers resolve and split editor commands", () => {
  assert.equal(getExternalEditorCommand({ VISUAL: "nvim", EDITOR: "vim" }, "darwin"), "nvim");
  assert.equal(getExternalEditorCommand({ EDITOR: "vim" }, "darwin"), "vim");
  assert.equal(getExternalEditorCommand({}, "win32"), "notepad");
  assert.deepEqual(splitEditorCommand('"/Applications/MacVim.app/Contents/bin/mvim" --wait'), [
    "/Applications/MacVim.app/Contents/bin/mvim",
    "--wait",
  ]);
  assert.deepEqual(splitEditorCommand('emacsclient -a "" -c'), ["emacsclient", "-a", "", "-c"]);
});

test("Windows editor spawn invocation preserves spaced executable and temp paths", () => {
  assert.deepEqual(
    getExternalEditorSpawnInvocation(
      "C:\\Program Files\\Editor\\editor.exe",
      ["--wait", "--name=two words"],
      "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\pi-read-mode-123\\draft.md",
      "win32",
    ),
    {
      command: "C:\\Program Files\\Editor\\editor.exe",
      args: [
        "--wait",
        "--name=two words",
        "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\pi-read-mode-123\\draft.md",
      ],
    },
  );
});

test("Windows editor spawn invocation rejects command scripts", () => {
  assert.throws(
    () => getExternalEditorSpawnInvocation(
      "C:\\Program Files\\Editor\\editor.cmd",
      ["--wait", "two words"],
      "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\pi-read-mode-123\\draft.md",
      "win32",
    ),
    /Windows \.cmd\/\.bat editor commands are not supported/,
  );
});

test("external editor success replaces draft, restores TUI, redraws, and removes temp file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-read-mode-test-"));
  try {
    const tui = makeTui();
    const command = nodeEditorCommand("require('node:fs').writeFileSync(process.argv.at(-1), 'edited\\n')");

    const edited = await editDraftInExternalEditor("draft", tui, {
      editorCommand: command,
      tmpDir: tmp,
      announce: false,
    });

    assert.equal(edited, "edited");
    assert.equal(tui.stopped, 1);
    assert.equal(tui.started, 1);
    assert.deepEqual(tui.renders, [true]);
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("pi-read-mode-")), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external editor success normalizes CRLF line endings and removes the final newline", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-read-mode-test-"));
  try {
    const tui = makeTui();
    const command = nodeEditorCommand("require('node:fs').writeFileSync(process.argv.at(-1), 'first\\r\\nsecond\\r\\n')");

    const edited = await editDraftInExternalEditor("draft", tui, {
      editorCommand: command,
      tmpDir: tmp,
      announce: false,
    });

    assert.equal(edited, "first\nsecond");
    assert.doesNotMatch(edited, /\r/);
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("pi-read-mode-")), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external editor failure preserves draft by returning undefined and still restores TUI", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-read-mode-test-"));
  try {
    const tui = makeTui();
    const command = nodeEditorCommand("process.exit(2)");

    const edited = await editDraftInExternalEditor("draft", tui, {
      editorCommand: command,
      tmpDir: tmp,
      announce: false,
    });

    assert.equal(edited, undefined);
    assert.equal(tui.stopped, 1);
    assert.equal(tui.started, 1);
    assert.deepEqual(tui.renders, [true]);
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("pi-read-mode-")), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external editor cleanup failure still restarts TUI and preserves cleanup error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pi-read-mode-test-"));
  try {
    const tui = makeTui();
    const command = nodeEditorCommand("process.exit(0)");
    const cleanupError = new Error("cleanup failed");

    await assert.rejects(
      () => editDraftInExternalEditor("draft", tui, {
        editorCommand: command,
        tmpDir: tmp,
        announce: false,
        cleanupDraftDir() {
          throw cleanupError;
        },
      }),
      cleanupError,
    );

    assert.equal(tui.stopped, 1);
    assert.equal(tui.started, 1);
    assert.deepEqual(tui.renders, [true]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("external editor process failure preserves draft, notifies, redraws, and restores state", async () => {
  const notifications = [];
  const { component, tui } = makeReadMode({ notifyError: (message) => notifications.push(message) });
  await mount(component);
  input(component, "keep this draft");

  const originalEnv = {
    VISUAL: process.env.VISUAL,
    EDITOR: process.env.EDITOR,
  };

  try {
    process.env.VISUAL = nodeEditorCommand("process.exit(2)");
    delete process.env.EDITOR;

    component.handleInput("\x07");
    for (let i = 0; i < 50 && notifications.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(component.getDraft(), "keep this draft");
  assert.equal(tui.stopped, 1);
  assert.equal(tui.started, 1);
  assert.deepEqual(tui.writes.slice(-2), ["\x1b[?1000l\x1b[?1006l", "\x1b[?1000h\x1b[?1006h"]);
  assert.deepEqual(tui.renders.slice(-2), [true, true]);
  assert.equal(component.externalEditorOpen, false);
  assert.deepEqual(notifications, ["External editor failed"]);
});

test("external editor temp creation rejection preserves draft, notifies, and restores mouse state", async () => {
  const notifications = [];
  const { component, tui } = makeReadMode({ notifyError: (message) => notifications.push(message) });
  await mount(component);
  input(component, "keep this draft");

  const originalEnv = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };
  const missingTmp = join(tmpdir(), `pi-read-mode-missing-${process.pid}-${Date.now()}`, "child");
  const unhandledRejections = [];
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    process.env.TMPDIR = missingTmp;
    process.env.TMP = missingTmp;
    process.env.TEMP = missingTmp;

    component.handleInput("\x07");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.equal(component.getDraft(), "keep this draft");
  assert.equal(tui.stopped, 0);
  assert.equal(tui.started, 0);
  assert.deepEqual(tui.writes.slice(-2), ["\x1b[?1000l\x1b[?1006l", "\x1b[?1000h\x1b[?1006h"]);
  assert.ok(tui.renders.includes(true));
  assert.deepEqual(notifications, ["External editor failed"]);
  assert.deepEqual(unhandledRejections, []);
});

test(
  "external editor creates owner-only temp drafts on Unix",
  { skip: process.platform === "win32" ? "POSIX file modes are not portable on Windows" : false },
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "pi-read-mode-test-"));
    const modesFile = join(tmp, "modes.json");
    const tui = makeTui();
    const command = nodeEditorCommand([
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const draft = process.argv.at(-1);",
      `fs.writeFileSync(${JSON.stringify(modesFile)}, JSON.stringify({`,
      "  dir: (fs.statSync(path.dirname(draft)).mode & 0o777).toString(8),",
      "  file: (fs.statSync(draft).mode & 0o777).toString(8),",
      "  text: fs.readFileSync(draft, 'utf8'),",
      "}));",
    ].join(" "));
    const oldUmask = process.umask(0);

    try {
      const edited = await editDraftInExternalEditor("draft", tui, {
        editorCommand: command,
        tmpDir: tmp,
        announce: false,
      });

      assert.equal(edited, "draft");
      assert.deepEqual(JSON.parse(readFileSync(modesFile, "utf-8")), {
        dir: "700",
        file: "600",
        text: "draft",
      });
      assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith("pi-read-mode-")), []);
    } finally {
      process.umask(oldUmask);
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);
