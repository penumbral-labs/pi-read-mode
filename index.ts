/**
 * Penumbral Labs Read Mode extension.
 *
 * Alt+R or /read opens a fullscreen viewer that captures pi's already-rendered
 * component output and displays it in a scrollable viewport with Pi TUI's native
 * multiline Editor pinned at the bottom for composing a follow-up.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Component,
	type Focusable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

interface ReadModeResult { text: string }

interface MinimalTui {
	children: Component[];
	terminal: {
		columns?: number;
		rows: number;
		write(data: string): void;
	};
	requestRender(force?: boolean): void;
	start(): void;
	stop(): void;
}

interface ExternalEditorOptions {
	editorCommand?: string;
	tmpDir?: string;
	announce?: boolean;
	cleanupDraftDir?: (draftDir: string) => void;
}

type NotifyError = (message: string) => void;

interface EditorSpawnInvocation {
	command: string;
	args: string[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const SCROLL_STEP_MOUSE = 3;
const EXTERNAL_EDITOR_ERROR_MESSAGE = "External editor failed";

// Pre-compiled regexes for mouse sequence parsing
const SGR_MOUSE_RE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;
// Bitmask: keep button ID (bits 0-1) and wheel direction (bits 6-7), ignore modifier bits (2-5)
const MOUSE_BUTTON_MASK = 0xc3;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

// ── External editor helpers ─────────────────────────────────────────────────

export function splitEditorCommand(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let tokenStarted = false;
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		const next = command[i + 1];

		if (char === "\\" && next !== undefined) {
			if (next === "\\" && current === "" && (!tokenStarted || quote !== null)) {
				current += "\\\\";
				tokenStarted = true;
				i++;
				continue;
			}
			if (next === "\\" || next === "'" || next === '"' || /\s/.test(next)) {
				current += next;
				tokenStarted = true;
				i++;
				continue;
			}
			current += char;
			tokenStarted = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (tokenStarted) {
				parts.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (tokenStarted) parts.push(current);
	return parts;
}

function isWindowsCommandScript(editor: string): boolean {
	return /\.(?:cmd|bat)$/i.test(editor);
}

export function getExternalEditorSpawnInvocation(
	editor: string,
	editorArgs: string[],
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnInvocation {
	const args = [...editorArgs, tmpFile];
	if (platform === "win32" && isWindowsCommandScript(editor)) {
		throw new Error("Windows .cmd/.bat editor commands are not supported; configure VISUAL/EDITOR to use an .exe or native executable.");
	}
	return { command: editor, args };
}

export function getExternalEditorCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return env.VISUAL || env.EDITOR || (platform === "win32" ? "notepad" : "nano");
}

export async function editDraftInExternalEditor(
	currentText: string,
	tui: Pick<MinimalTui, "start" | "stop" | "requestRender">,
	options: ExternalEditorOptions = {},
): Promise<string | undefined> {
	const editorCommand = options.editorCommand ?? getExternalEditorCommand();
	const [editor, ...editorArgs] = splitEditorCommand(editorCommand);
	if (!editor) return undefined;

	let draftDir: string | undefined;
	let tmpFile: string | undefined;
	let tuiStopped = false;
	let editorCompleted = false;
	let completedEditorResult: string | undefined;
	let successfulEditorResult: string | undefined;
	let hasEarlierError = false;
	let earlierError: unknown;
	let hasCleanupError = false;
	let cleanupError: unknown;

	try {
		draftDir = mkdtempSync(join(options.tmpDir ?? tmpdir(), "pi-read-mode-"));
		tmpFile = join(draftDir, "draft.md");
		writeFileSync(tmpFile, currentText, { encoding: "utf-8", flag: "wx", mode: 0o600 });

		tui.stop();
		tuiStopped = true;
		if (options.announce !== false) {
			process.stdout.write(`Launching external editor: ${editorCommand}\nPi will resume when the editor exits.\n`);
		}

		const invocation = getExternalEditorSpawnInvocation(editor, editorArgs, tmpFile);
		const status = await new Promise<number | null>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				stdio: "inherit",
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (status === 0) {
			successfulEditorResult = readFileSync(tmpFile, "utf-8").replace(/\r\n/g, "\n").replace(/\n$/, "");
			completedEditorResult = successfulEditorResult;
		}
		editorCompleted = true;
	} catch (error) {
		hasEarlierError = true;
		earlierError = error;
	}

	try {
		if (draftDir) (options.cleanupDraftDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true })))(draftDir);
	} catch (error) {
		hasCleanupError = true;
		cleanupError = error;
	} finally {
		if (tuiStopped) {
			tui.start();
			tui.requestRender(true);
		}
	}

	if (editorCompleted) return completedEditorResult;
	if (hasEarlierError) throw earlierError;
	if (hasCleanupError) throw cleanupError;
	return undefined;
}

// ── Theme adapter ───────────────────────────────────────────────────────────

function themeFg(theme: any, color: string, text: string): string {
	return typeof theme?.fg === "function" ? theme.fg(color, text) : text;
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (text: string) => themeFg(theme, "border", text),
		selectList: {
			selectedPrefix: (text: string) => themeFg(theme, "accent", text),
			selectedText: (text: string) => themeFg(theme, "accent", text),
			description: (text: string) => themeFg(theme, "dim", text),
			scrollInfo: (text: string) => themeFg(theme, "dim", text),
			noMatch: (text: string) => themeFg(theme, "dim", text),
		},
	};
}

// ── Component ───────────────────────────────────────────────────────────────

export class ReadModeComponent implements Component, Focusable {
	private isFocused = false;
	private readonly editor: Editor;
	private contentLines: string[] = [];
	private scrollOffset = 0;
	private wrappedDone: (result: ReadModeResult | null) => void;
	private tui: MinimalTui;
	private theme: any;
	private keybindings: KeybindingsManager;
	private cachedRenderWidth = 0;
	private capturedChildren: Component[] = [];
	private savedTuiChildren: Component[] = [];
	private fullscreenActive = false;
	private needsFullscreenSetup = true;
	private startAtBottom = false;
	private viewportRows = 1;
	private externalEditorOpen = false;
	private notifyError: NotifyError;

	constructor(
		tui: MinimalTui,
		theme: any,
		keybindings: KeybindingsManager,
		externalDone: (r: ReadModeResult | null) => void,
		notifyError: NotifyError,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.notifyError = notifyError;
		this.editor = new Editor(tui as any, createEditorTheme(theme), { paddingX: 0 });
		this.editor.focused = this.isFocused;
		this.editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (trimmed) this.wrappedDone({ text: trimmed });
		};

		this.wrappedDone = (result: ReadModeResult | null) => {
			this.exitFullscreen();
			externalDone(result);
		};
	}

	get focused(): boolean { return this.isFocused; }
	set focused(value: boolean) {
		this.isFocused = value;
		this.editor.focused = value;
	}

	getDraft(): string { return this.editor.getExpandedText(); }
	setDraft(text: string): void { this.editor.setText(text); }

	// ── Fullscreen lifecycle ──────────────────────────────────────────────

	private enterFullscreen(): void {
		if (this.fullscreenActive) return;

		// Find the tui child (editorContainer) that holds this component.
		let myContainer: any = null;
		for (const child of this.tui.children) {
			if ((child as any)?.children?.includes?.(this)) {
				myContainer = child;
				break;
			}
		}
		if (!myContainer) return;

		// Save all children and capture references for rendering.
		this.savedTuiChildren = [...this.tui.children];
		this.capturedChildren = this.savedTuiChildren.filter((c: any) => c !== myContainer);

		// Replace tui children with only our container.
		this.tui.children.length = 0;
		this.tui.children.push(myContainer);
		this.fullscreenActive = true;
		this.startAtBottom = true;
		this.cachedRenderWidth = 0;

		// Enable mouse wheel reporting for trackpad scrolling.
		this.tui.terminal.write("\x1b[?1000h\x1b[?1006h");
		this.tui.requestRender(true);
	}

	private exitFullscreen(): void {
		// Disable mouse reporting even on partial setup.
		this.tui.terminal.write("\x1b[?1000l\x1b[?1006l");

		if (this.fullscreenActive && this.savedTuiChildren.length > 0) {
			this.tui.children.length = 0;
			this.tui.children.push(...this.savedTuiChildren);
			this.savedTuiChildren = [];
			this.capturedChildren = [];
			this.fullscreenActive = false;
		}

		this.tui.requestRender(true);
	}

	// ── Scroll helpers ────────────────────────────────────────────────────

	private maxScroll(): number {
		return Math.max(0, this.contentLines.length - Math.max(1, this.viewportRows));
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, Math.min(this.maxScroll(), this.scrollOffset + delta));
		this.tui.requestRender();
	}

	// ── Mouse parsing ─────────────────────────────────────────────────────

	/** Returns scroll lines (negative=up, positive=down) or 0 if not a wheel event. */
	private parseMouseScroll(data: string): number {
		// SGR extended format: \x1b[<button;col;rowM
		const sgr = data.match(SGR_MOUSE_RE);
		if (sgr) {
			const base = parseInt(sgr[1]!, 10) & MOUSE_BUTTON_MASK;
			if (base === WHEEL_UP) return -SCROLL_STEP_MOUSE;
			if (base === WHEEL_DOWN) return SCROLL_STEP_MOUSE;
		}
		// Legacy X10 format: \x1b[M + 3 raw bytes
		if (data.length === 6 && data.startsWith("\x1b[M")) {
			const base = (data.charCodeAt(3) - 32) & MOUSE_BUTTON_MASK;
			if (base === WHEEL_UP) return -SCROLL_STEP_MOUSE;
			if (base === WHEEL_DOWN) return SCROLL_STEP_MOUSE;
		}
		return 0;
	}

	// ── Input handling ────────────────────────────────────────────────────

	private async openExternalEditor(): Promise<void> {
		if (this.externalEditorOpen) return;
		this.externalEditorOpen = true;
		this.tui.terminal.write("\x1b[?1000l\x1b[?1006l");
		try {
			const edited = await editDraftInExternalEditor(this.editor.getExpandedText(), this.tui);
			if (edited !== undefined) {
				this.editor.setText(edited);
				this.tui.requestRender(true);
			} else {
				this.notifyError(EXTERNAL_EDITOR_ERROR_MESSAGE);
				this.tui.requestRender(true);
			}
		} catch {
			this.notifyError(EXTERNAL_EDITOR_ERROR_MESSAGE);
			this.tui.requestRender(true);
		} finally {
			if (this.fullscreenActive) this.tui.terminal.write("\x1b[?1000h\x1b[?1006h");
			this.externalEditorOpen = false;
		}
	}

	handleInput(data: string): void {
		// Mouse wheel and trackpad history scrolling stay outside the editor.
		const wheelDelta = this.parseMouseScroll(data);
		if (wheelDelta !== 0) { this.scrollBy(wheelDelta); return; }

		if (matchesKey(data, "escape")) { this.wrappedDone(null); return; }

		// App-level external-editor binding comes from Pi's keybinding manager.
		if (this.keybindings.matches(data, "app.editor.external")) {
			void this.openExternalEditor();
			return;
		}

		// Alt-modified keys own history scrolling; unmodified navigation belongs to the editor.
		const pageDelta = Math.max(1, this.viewportRows - 2);
		if (matchesKey(data, "alt+pageUp")) { this.scrollBy(-pageDelta); return; }
		if (matchesKey(data, "alt+pageDown")) { this.scrollBy(pageDelta); return; }
		if (matchesKey(data, "alt+up")) { this.scrollBy(-1); return; }
		if (matchesKey(data, "alt+down")) { this.scrollBy(1); return; }
		if (matchesKey(data, "alt+home")) { this.scrollOffset = 0; this.tui.requestRender(); return; }
		if (matchesKey(data, "alt+end")) { this.scrollOffset = this.maxScroll(); this.tui.requestRender(); return; }

		this.editor.handleInput(data);
	}

	// ── Rendering ─────────────────────────────────────────────────────────

	private renderContent(width: number): string[] {
		if (this.cachedRenderWidth !== width) {
			const lines: string[] = [];
			for (const child of this.capturedChildren) {
				lines.push(...child.render(width));
			}
			// Strip CURSOR_MARKER so captured history cannot move the read-mode cursor.
			this.contentLines = lines.map(line => line.replaceAll(CURSOR_MARKER, ""));
			this.cachedRenderWidth = width;
		}
		return this.contentLines;
	}

	private renderHr(width: number, text?: string): string {
		if (width <= 0) return "";
		if (!text) return themeFg(this.theme, "border", "─".repeat(width));
		const label = truncateToWidth(` ${text} `, width);
		const lw = visibleWidth(label);
		const rem = Math.max(0, width - lw);
		const left = Math.min(3, rem);
		return themeFg(this.theme, "border", "─".repeat(left))
			+ themeFg(this.theme, "accent", label)
			+ themeFg(this.theme, "border", "─".repeat(rem - left));
	}

	private fitEditorLines(lines: string[], rows: number): string[] {
		if (lines.length <= rows) return lines;
		const cursorIndex = lines.findIndex(line => line.includes(CURSOR_MARKER));
		if (cursorIndex === -1) return lines.slice(lines.length - rows);
		const start = Math.max(0, Math.min(lines.length - rows, cursorIndex - Math.floor(rows / 2)));
		return lines.slice(start, start + rows);
	}

	private renderEditor(width: number, termRows: number): string[] {
		const raw = this.editor.render(Math.max(1, width));
		const fitted = this.fitEditorLines(raw, termRows);
		return fitted.map(line => truncateToWidth(line, width));
	}

	render(width: number): string[] {
		if (this.needsFullscreenSetup) {
			this.needsFullscreenSetup = false;
			process.nextTick(() => this.enterFullscreen());
		}

		const th = this.theme;
		const termRows = Math.max(1, this.tui.terminal.rows);
		const wasAtBottom = this.scrollOffset >= this.maxScroll();
		const all = this.renderContent(width);
		const editorLines = this.renderEditor(width, termRows);
		const editorRowCount = editorLines.length;

		let showTitle = true;
		let showStatus = true;
		let showAbove = true;
		let showHeaderRule = true;
		let showBelow = true;
		let showPreRule = true;
		let showHelp = true;
		const availableBeforeEditor = Math.max(0, termRows - editorRowCount);
		const chromeCount = () => [showTitle, showStatus, showAbove, showHeaderRule, showBelow, showPreRule, showHelp]
			.filter(Boolean).length;
		for (const drop of [
			() => { showHelp = false; },
			() => { showPreRule = false; },
			() => { showBelow = false; },
			() => { showAbove = false; },
			() => { showStatus = false; },
			() => { showHeaderRule = false; },
			() => { showTitle = false; },
		]) {
			if (chromeCount() <= availableBeforeEditor) break;
			drop();
		}

		const contentRows = Math.max(0, availableBeforeEditor - chromeCount());
		const total = all.length;
		this.viewportRows = Math.max(1, contentRows);
		const maxS = this.maxScroll();
		// On first fullscreen render, jump to bottom so most recent content is visible.
		if (this.startAtBottom) {
			this.startAtBottom = false;
			this.scrollOffset = maxS;
		} else if (wasAtBottom) {
			this.scrollOffset = maxS;
		}
		if (this.scrollOffset > maxS) this.scrollOffset = maxS;

		const lines: string[] = [];
		const below = total - (this.scrollOffset + contentRows);

		if (showTitle) lines.push(this.renderHr(width, "Read Mode"));
		if (showStatus) {
			const status = contentRows > 0 && total > contentRows
				? `  lines ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + contentRows, total)} of ${total}`
				: `  ${total} lines`;
			lines.push(truncateToWidth(themeFg(th, "dim", status), width));
		}
		if (showAbove) {
			lines.push(this.scrollOffset > 0
				? truncateToWidth(themeFg(th, "dim", `  ↑ ${this.scrollOffset} more above`), width)
				: "");
		}
		if (showHeaderRule) lines.push(this.renderHr(width));

		const visible = contentRows > 0 ? all.slice(this.scrollOffset, this.scrollOffset + contentRows) : [];
		for (const line of visible) lines.push(truncateToWidth(line, width));
		for (let i = visible.length; i < contentRows; i++) lines.push("");

		if (showBelow) {
			lines.push(below > 0
				? truncateToWidth(themeFg(th, "dim", `  ↓ ${below} more below`), width)
				: "");
		}
		if (showPreRule) lines.push(this.renderHr(width));
		if (showHelp) {
			lines.push(truncateToWidth(
				themeFg(th, "dim", "  Alt+↑/↓ scroll • Alt+PgUp/PgDn page • Alt+Home/End • Ctrl+G editor • Esc cancel"),
				width,
			));
		}

		while (lines.length + editorLines.length < termRows) lines.push("");
		lines.push(...editorLines);

		if (lines.length > termRows) lines.length = termRows;
		return lines;
	}

	invalidate(): void {
		this.cachedRenderWidth = 0;
		this.editor.invalidate();
	}

	dispose(): void { this.exitFullscreen(); }
}

// ── Entry points ────────────────────────────────────────────────────────────

export function openReadMode(pi: ExtensionAPI, ui: any): Promise<void> {
	return ui.custom(
		(tui: MinimalTui, theme: any, keybindings: KeybindingsManager, done: (r: ReadModeResult | null) => void) => {
			return new ReadModeComponent(tui, theme, keybindings, done, (message) => ui.notify(message, "error"));
		},
	).then((result: ReadModeResult | null) => {
		if (result?.text) pi.sendUserMessage(result.text);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("read", {
		description: "Scroll through conversation history while composing a follow-up",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("Read mode requires interactive mode", "error"); return; }
			if (!ctx.isIdle()) { ctx.ui.notify("Wait for the agent to finish", "warning"); return; }
			await openReadMode(pi, ctx.ui);
		},
	});

	pi.registerShortcut("alt+r", {
		description: "Enter read mode",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			if (!ctx.isIdle()) { ctx.ui.notify("Wait for the agent to finish", "warning"); return; }
			await openReadMode(pi, ctx.ui);
		},
	});
}
