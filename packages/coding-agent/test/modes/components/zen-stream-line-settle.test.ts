import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Markdown, streamingMarkdownSource } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { logger } from "@oh-my-pi/pi-utils";
import { Lexer } from "@oh-my-pi/pi-utils/marked";

const W = 100;

function msg(text: string | AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content: typeof text === "string" ? [{ type: "text", text }] : text,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

/** Exercise both the row-prefix contract and actual retirement into scrollback. */
function stream(text: string): readonly string[] {
	const component = new AssistantMessageComponent();
	const transcript = new TranscriptContainer();
	transcript.addChild(component);
	const warn = spyOn(logger, "warn");
	let published: readonly string[] = [];
	try {
		for (let end = 1; end <= text.length; end++) {
			component.updateContent(msg(text.slice(0, end)), { transient: true });
			const rows = trimBlankEdges(component.render(W));
			const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
			expect(rows.slice(0, stable.length)).toEqual([...stable]);
			expect(stable.slice(0, published.length)).toEqual([...published]);
			published = [...stable];
			const batch = transcript.peekFinalizedBatch(W, 8);
			if (batch) transcript.acknowledgeFinalizedBatch(batch.id);
			transcript.renderViewport(W, 8, { tick: end, now: end });
		}
		component.updateContent(msg(text));
		component.markTranscriptBlockFinalized();
		expect(trimBlankEdges(component.render(W)).slice(0, published.length)).toEqual([...published]);
		expect(component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W)).toEqual(published);
		const reflow = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, 50);
		expect(trimBlankEdges(component.render(50)).slice(0, reflow.length)).toEqual([...reflow]);
		transcript.renderViewport(W, 8, { tick: text.length + 1, now: text.length + 1 });
		expect(warn.mock.calls.filter(([message]) => message === "Append-only transcript block frozen")).toEqual([]);
		return published;
	} finally {
		warn.mockRestore();
	}
}

describe("zen streaming line settlement", () => {
	it("retires all but the last few soft lines of a growing paragraph", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `LINE-${i + 1}: **粗体** and \`代码\` stay paired.`);
		const stable = stream(`Intro.\n\n${lines.join("\n")}`);
		expect(stable.some(row => row.includes("LINE-58:"))).toBe(true);
		expect(stable.some(row => row.includes("LINE-59:"))).toBe(false);
		expect(stable.some(row => row.includes("LINE-60:"))).toBe(false);
	});

	it("retires complete open-fence lines without a synthetic closing border", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = "CODE-${i + 1}:";`);
		const stable = stream(`Intro.\n\n\`\`\`ts\n${lines.join("\n")}`);
		expect(stable.some(row => row.includes("CODE-59:"))).toBe(true);
		expect(stable.some(row => row.includes("CODE-60:"))).toBe(false);
		expect(stable.filter(row => row.includes("```"))).toHaveLength(1);
	});

	const literalMathCode =
		"const pattern = /\\(/;\nconst bracket = String.raw`\\[`;\nconst environment = String.raw`\\begin{`;";
	it("retires open-fence lines containing literal math openers", () => {
		const stable = stream(
			`Intro.\n\n\`\`\`ts\n${literalMathCode}\nconst complete = \"LITERAL-COMPLETE\";\nconst pending =`,
		);
		expect(stable.some(row => row.includes("pattern"))).toBe(true);
		expect(stable.some(row => row.includes("bracket"))).toBe(true);
		expect(stable.some(row => row.includes("environment"))).toBe(true);
		expect(stable.some(row => row.includes("LITERAL-COMPLETE"))).toBe(true);
		expect(stable.some(row => row.includes("pending"))).toBe(false);
	});

	it("settles prose through a closed fence containing literal math openers", () => {
		const stable = stream(
			`Intro.\n\n\`\`\`ts\n${literalMathCode}\n\`\`\`\nfirst prose line\nsecond prose line\nthird prose line\npending`,
		);
		expect(stable.some(row => row.includes("environment"))).toBe(true);
		expect(stable.some(row => row.includes("first prose line"))).toBe(true);
		expect(stable.some(row => row.includes("second prose line"))).toBe(true);
		expect(stable.some(row => row.includes("pending"))).toBe(false);
	});

	for (const intro of ["intro line", "first line\nsecond line\nLine 120 is complete"]) {
		it(`retires a fence interrupting prose without a blank line: ${intro.split("\n")[0]}`, () => {
			const lines = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = "CODE-${i + 1}:";`);
			const stable = stream(`${intro}\n\`\`\`ts\n${lines.join("\n")}`);
			expect(stable.some(row => row.includes(intro.split("\n").at(-1)!))).toBe(true);
			expect(stable.some(row => row.includes("CODE-59:"))).toBe(true);
			expect(stable.some(row => row.includes("CODE-60:"))).toBe(false);
		});
	}

	it("retires soft lines immediately after a heading without a blank line", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `LINE-${i + 1}: **paired** prose.`);
		const stable = stream(`# Title\n${lines.join("\n")}`);
		expect(stable.some(row => row.includes("Title"))).toBe(true);
		expect(stable.some(row => row.includes("LINE-58:"))).toBe(true);
		expect(stable.some(row => row.includes("LINE-59:"))).toBe(false);
	});

	it("bridges headings, rules, closed fences, and prose in sequence", () => {
		const stable = stream(
			"# Title\n***\n```ts\nconst closed = 1;\n```\nintro line\n```ts\nconst first = 1;\nconst second = 2;\nconst pending =",
		);
		expect(stable.some(row => row.includes("intro line"))).toBe(true);
		expect(stable.some(row => row.includes("second"))).toBe(true);
		expect(stable.some(row => row.includes("pending"))).toBe(false);
	});

	for (const [name, bridge] of [
		["list", "- list item\n# Bridge"],
		["table", "| a | b |\n|---|---|\n| 1 | 2 |\n# Bridge"],
		["unmatched paragraph delimiter", "intro **open"],
		["open inline backslash math", "prefix \\(x\nsecond\nthird"],
		["open display backslash math", "prefix \\[x\nsecond\nthird"],
		["open bare environment", "prefix \\begin{align}\nsecond\nthird"],
	] as const) {
		it(`does not publish code through a volatile ${name} bridge`, () => {
			const stable = stream(`Intro.\n\n${bridge}\n\`\`\`ts\nconst first = 1;\nconst second = 2;\nconst pending =`);
			expect(stable.some(row => row.includes("first"))).toBe(false);
			expect(stable.some(row => row.includes("second"))).toBe(false);
		});
	}

	for (const [opener, closer] of [
		["\\(", "\\)"],
		["\\[", "\\]"],
		["\\begin{align}", "\\end{align}"],
	] as const) {
		it(`holds a soft line containing unfinished ${opener}`, () => {
			const stable = stream(`Intro.\n\nprefix ${opener}x\nsecond\nthird`);
			expect(stable.some(row => row.includes("prefix"))).toBe(false);
			stream(`Intro.\n\nprefix ${opener}x\nsecond\nthird ${closer}\n\nDone.`);
		});
	}

	it("does not publish a setext heading hiding an unclosed display-math opener", () => {
		const open = "Intro.\n\n$$\n===\nfirst\nsecond\nthird";
		const stable = stream(open);
		expect(stable.some(row => row.includes("first"))).toBe(false);
		expect(stable.some(row => row.includes("second"))).toBe(false);
		stream(`${open}\n$$\n\nDone.`);
	});

	for (const [opener, closer] of [
		["\\(", "\\)"],
		["\\[", "\\]"],
		["\\begin{align}", "\\end{align}"],
	] as const) {
		it(`does not publish a setext heading hiding unfinished ${opener}`, () => {
			const open = `Intro.\n\n${opener}\n===\nfirst\nsecond\nthird`;
			const stable = stream(open);
			expect(stable.some(row => row.includes("first"))).toBe(false);
			expect(stable.some(row => row.includes("second"))).toBe(false);
			stream(`${open}\n${closer}\n\nDone.`);
		});
	}

	for (const info of ["", "\u00a0"]) {
		it(`keeps repairable blank-info fences out of published code rows: ${JSON.stringify(info)}`, () => {
			const stable = stream(`Intro.\n\n\`\`\`${info}\n# Heading\n| a | b |\n|---|---|\n| 1 | 2 |\npending`);
			expect(stable.some(row => row.includes("Heading"))).toBe(false);
			expect(stable.some(row => row.includes("```"))).toBe(false);
		});
	}

	for (const lang of ["mermaid", "svg"]) {
		it(`does not settle an open ${lang} diagram as literal lines`, () => {
			const theme = getMarkdownTheme();
			expect(theme.resolveMermaidAscii).toBeDefined();
			const md = new Markdown("", 0, 0, theme);
			md.transientRenderCache = true;
			const text = `Intro.\n\n\`\`\`${lang}\ngraph TD\nA --> B\nB --> C\nC --> D`;
			for (let end = 1; end <= text.length; end++) {
				md.setText(text.slice(0, end));
				md.render(W);
				expect(md.getLastRenderStableText().length).toBeLessThanOrEqual("Intro.\n\n".length);
			}
		});
	}

	it("checks paragraph lines and scans raw math characters linearly without a blank-line lex prefix", () => {
		const md = new Markdown("", 0, 0, getMarkdownTheme());
		md.transientRenderCache = true;
		const inline = spyOn(Lexer.prototype, "inlineTokens");
		const matchAll = RegExp.prototype[Symbol.matchAll];
		let mathScanChars = 0;
		const mathScan = spyOn(RegExp.prototype, Symbol.matchAll).mockImplementation(function (
			this: RegExp,
			source: string,
		) {
			if (this.source === /\\[([]/g.source || this.source === /\\begin\{([^}\n]*)\}?/g.source) {
				mathScanChars += source.length;
			}
			return matchAll.call(this, source);
		});
		let text = "";
		try {
			for (let line = 0; line < 2000; line++) {
				text += `row ${line}\n`;
				md.setText(text);
				md.render(W);
			}
			const lineChecks = inline.mock.calls.filter(([source]) => /^row \d+$/.test(source)).length;
			expect(lineChecks).toBeGreaterThanOrEqual(1998);
			expect(lineChecks).toBeLessThanOrEqual(2000);
			expect(md.getLastRenderStableText()).toContain("row 1998\n");
			// Both raw-math regexes see each complete source line exactly once.
			expect(mathScanChars).toBe(2 * (text.length - 2000));
			md.setText("prefix \\(x\nsecond\nthird");
			md.render(W);
			expect(md.getLastRenderStableText()).toBe("");
			md.setText("safe first\nsafe second\nlast");
			md.render(W);
			expect(md.getLastRenderStableText()).toBe("safe first\n");
		} finally {
			inline.mockRestore();
			mathScan.mockRestore();
		}
	});

	it("checks a long intervening paragraph only once as code lines grow", () => {
		const paragraph = Array.from({ length: 200 }, (_, i) => `bridge row ${i}`).join("\n");
		const md = new Markdown("", 0, 0, getMarkdownTheme());
		md.transientRenderCache = true;
		let text = `${paragraph}\n\`\`\`ts\n`;
		const inline = spyOn(Lexer.prototype, "inlineTokens");
		try {
			for (let line = 0; line < 1000; line++) {
				text += `const value${line} = ${line};\n`;
				md.setText(text);
				md.render(W);
			}
			// marked supplies an output-token array to its document inline pass;
			// the independent settlement check uses the isolated one-arg pass.
			const bridgeChecks = inline.mock.calls.filter(args => args.length === 1 && args[0] === paragraph).length;
			expect(bridgeChecks).toBe(1);
			expect(md.getLastRenderStableText()).toContain("const value998 = 998;");
			md.setText(`changed **open\n\`\`\`ts\nconst first = 1;\nconst pending =`);
			md.render(W);
			expect(md.getLastRenderStableText()).toBe("");
		} finally {
			inline.mockRestore();
		}
	});

	it("closes a prior part's synthetic border when another part starts", () => {
		const first = "Intro.\n\n```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;";
		const second = "First thought.\n\nSecond thought.\n\nStill thinking";
		const component = new AssistantMessageComponent();
		let published: readonly string[] = [];
		for (let end = 1; end <= first.length + second.length; end++) {
			const content: AssistantMessage["content"] = [{ type: "text", text: first.slice(0, end) }];
			if (end > first.length) content.push({ type: "thinking", thinking: second.slice(0, end - first.length) });
			component.updateContent(msg(content), { transient: true });
			const rows = trimBlankEdges(component.render(W));
			const stable = component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W);
			expect(rows.slice(0, stable.length)).toEqual([...stable]);
			expect(stable.slice(0, published.length)).toEqual([...published]);
			published = [...stable];
		}
		expect(published.filter(row => row.includes("```"))).toHaveLength(2);
		component.updateContent(
			msg([
				{ type: "text", text: first },
				{ type: "thinking", thinking: second },
			]),
		);
		component.markTranscriptBlockFinalized();
		expect(component.renderTranscriptStableRows(component.getTranscriptStableRows().length, W)).toEqual(published);
		expect(trimBlankEdges(component.render(W)).slice(0, published.length)).toEqual([...published]);
	});

	const docs = [
		["cross-line emphasis", "a **b\nc** d\nplain line\nlast line"],
		["cross-line link", "[x\ny](u)\nplain line\nlast line"],
		["cross-line inline code", "a `b\nc` d\nplain line\nlast line"],
		["later reference definition", "first line\n[t]\nplain line\nlast line\n[t]: https://example.com"],
		["table after paragraph", "intro\n| a | b |\n|---|---|\n| 1 | 2 |"],
		["list interruption", "first line\nsecond line\nthird line\n- item one\n- item two"],
		["heading interruption", "first line\nsecond line\nthird line\n# Heading\n\nTail"],
		["fence interruption", "first line\nsecond line\nthird line\n```ts\nconst x = 1;\nconst y = 2;\n```"],
		[
			"TypeScript template and backticks",
			"```ts\nconst text = `first\nsecond ${1 + 2}\nthird`;\nconst quote = \"'''\";\n// ``` is literal here\nconst end = 1;\n```",
		],
		[
			"Python multiline strings",
			"```py\ntext = '''first\nsecond `backtick`\nthird'''\nother = \"\"\"first\nsecond\nthird\"\"\"\nprint(text)\n```",
		],
		["paragraph after closed fence", "```ts\nconst x = 1;\nconst y = 2;\n```\nfirst line\nsecond line\nthird line"],
		["tilde fence", "~~~ts\nconst x = `value`;\nconst y = 2;\nconst z = 3;\n~~~"],
		["longer closing fence", "```ts\nconst x = 1;\nconst y = 2;\nconst z = 3;\n`````"],
		["display math before paragraph", "$$\nx = 1\n\nfirst line\nsecond line\nthird line\n$$"],
		["closed display math before paragraph", "$$\nx = 1\n$$\n\nfirst line\nsecond line\nthird line"],
		["nested fence in list", "- item\n\n  ```ts\n  const x = 1;\n  const y = 2;\n  ```\n- next item"],
		["quoted fence", "> ```ts\n> const x = 1;\n> const y = 2;\n> ```"],
	] as const;

	for (const [name, doc] of docs) {
		it(`never publishes mutable rows: ${name}`, () => {
			stream(`Intro.\n\n${doc}\n\nDone.`);
		});
	}
});

/** Compare completed renderer rows after every single-line native push against
 * the whole-block path. Keep an incomplete sentinel so every sampled source
 * line is complete, including any ANSI reset carried across a push boundary. */
function assertHighlightLines(lang: string, source: string): void {
	const theme = getMarkdownTheme();
	const md = new Markdown("", 0, 0, theme, undefined, 0);
	md.transientRenderCache = true;
	const lines = streamingMarkdownSource(source).trimEnd().split("\n");
	let complete = "";
	for (let index = 0; index < lines.length; index++) {
		complete += `${lines[index]}\n`;
		const code = `${complete}pending`;
		md.setText(`\`\`\`\`\`\`\`\`\`\`\`\`${lang}\n${code}`);
		const rows = md.render(1000).slice(1, index + 2);
		expect(rows).toEqual(theme.highlightCode!(code, lang).slice(0, index + 1));
	}
}

describe("zen streaming native highlight line identity", () => {
	const samples = [
		["ts", "const text = `first\nsecond ${1 + 2}\nthird`;\n/* block\ncomment */\nconst end = 1;"],
		["py", "text = '''first\nsecond `tick`\nthird'''\nother = \"\"\"first\nsecond\nthird\"\"\"\nprint(text)"],
		["rust", 'fn main() {\n/* outer\n/* inner */\nend */\nlet text = r#"first\nsecond"#;\nprintln!("{}", text);\n}'],
		["go", "package main\n/* block\ncomment */\nfunc main() {\ntext := `first\nsecond`\nprintln(text)\n}"],
		["bash", "#!/bin/bash\ncat <<'EOF'\nfirst $literal\nsecond `tick`\nEOF\nprintf '%s\\n' \"done\""],
		["json", '{\n  "name": "value",\n  "items": [1,\n    2, 3],\n  "ok": true\n}'],
		["md", "# Heading\n\n**bold** and `code`\n```ts\nconst x = 1;\n```\n<!-- first\nsecond -->\n"],
		["diff", "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n unchanged"],
	] as const;
	for (const [lang, source] of samples) {
		it(`matches whole-block bytes for ${lang} across multiline constructs`, () => {
			assertHighlightLines(lang, source);
		});
	}
	for (const [lang, path] of [
		["ts", "../../../../tui/src/components/markdown.ts"],
		["rust", "../../../../../crates/pi-natives/src/highlight.rs"],
	] as const) {
		it(`matches whole-block bytes for a real ${lang} source excerpt`, async () => {
			const source = await Bun.file(new URL(path, import.meta.url)).text();
			assertHighlightLines(lang, source.split("\n").slice(0, 200).join("\n"));
		});
	}
});
