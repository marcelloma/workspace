import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface OptionItem {
	label: string;
	value: string;
	isCustom?: boolean;
}

type AnswerType = "preset" | "custom" | "multi";

interface AnswerDetails {
	question: string;
	presetAnswers: string[];
	answer: string | string[];
	answerType: AnswerType;
	presetIndex?: number;
	presetIndexes?: number[];
}

const QuestionParams = Type.Object({
	question: Type.String({ description: "Question to ask the user." }),
	options: Type.Array(
		Type.String({ description: "Preset answer text." }),
		{
			minItems: 1,
			description: "One or more preset answers. A freeform option is always included.",
		},
	),
	multiple: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple preset answers using checkbox mode." }),
	),
	customLabel: Type.Optional(
		Type.String({ description: "Label for the freeform option. Default: 'Type your own answer...'." }),
	),
});

type AskQuestionResult =
	| { answerType: "preset"; answer: string; presetIndex: number }
	| { answerType: "custom"; answer: string }
	| { answerType: "multi"; answer: string[]; presetIndexes: number[] };

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_question",
		label: "Ask Question",
		description:
			"Ask the user a single question and wait for a response before continuing reasoning.",
		promptSnippet:
			"Ask one question with preset answers and optional checkbox multi-select + freeform option.",
		promptGuidelines: [
			"Use ask_question when you need a user decision, preference, or clarification.",
			"You may pass one or more preset answers; the tool always includes one freeform option.",
			"Set multiple=true to let the user choose several preset options using checkboxes before continuing reasoning.",
		],
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: interactive UI is unavailable." }],
					details: {
						question: params.question,
						presetAnswers: params.options,
						answer: "",
						answerType: "preset",
					} as AnswerDetails,
				};
			}

			const multiple = params.multiple ?? false;
			const allOptions: OptionItem[] = [
				...params.options.map((opt) => ({ label: opt, value: opt })),
				{ value: "__custom__", label: params.customLabel ?? "Type your own answer...", isCustom: true },
			];
			const customIndex = allOptions.length - 1;
			const selectedOptions = multiple ? new Array(allOptions.length).fill(false) : null;

			const result = await ctx.ui.custom<AskQuestionResult | null>((tui, theme, _kb, done) => {
				let selectedIndex = 0;
				let customText = "";
				let customCursor = 0;
				let cache: string[] | undefined;

				function isCustomChosen(): boolean {
					return customText.trim().length > 0;
				}

				function isOptionChecked(index: number, option: OptionItem): boolean {
					if (!multiple) return false;
					if (index === customIndex) return isCustomChosen();
					return selectedOptions?.[index] ?? false;
				}

				function refresh() {
					cache = undefined;
					tui.requestRender();
				}

				function handleInput(data: string) {
					const selected = allOptions[selectedIndex];

					if (matchesKey(data, Key.escape)) {
						if (!multiple && selected?.isCustom && customText.length > 0) {
							customText = "";
							customCursor = 0;
							refresh();
							return;
						}
						done(null);
						return;
					}

					if (multiple && matchesKey(data, Key.space) && !selected?.isCustom) {
						selectedOptions![selectedIndex] = !selectedOptions![selectedIndex];
						refresh();
						return;
					}

					if (selected?.isCustom) {
						if (matchesKey(data, Key.backspace)) {
							if (customCursor > 0) {
								customText = customText.slice(0, customCursor - 1) + customText.slice(customCursor);
								customCursor--;
							}
							refresh();
							return;
						}
						if (matchesKey(data, Key.left)) {
							customCursor = Math.max(0, customCursor - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.right)) {
							customCursor = Math.min(customText.length, customCursor + 1);
							refresh();
							return;
						}
						if (data.length === 1 && data.charCodeAt(0) >= 32) {
							customText = customText.slice(0, customCursor) + data + customText.slice(customCursor);
							customCursor++;
							refresh();
							return;
						}
					}

					if (matchesKey(data, Key.up)) {
						const nextIndex = Math.max(0, selectedIndex - 1);
						if (!multiple && selected?.isCustom && nextIndex !== selectedIndex) {
							customText = "";
							customCursor = 0;
						}
						selectedIndex = nextIndex;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						const nextIndex = Math.min(allOptions.length - 1, selectedIndex + 1);
						if (!multiple && selected?.isCustom && nextIndex !== selectedIndex) {
							customText = "";
							customCursor = 0;
						}
						selectedIndex = nextIndex;
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter)) {
						if (multiple) {
							const answer: string[] = [];
							const presetIndexes: number[] = [];
							for (let i = 0; i < allOptions.length; i++) {
								const option = allOptions[i];
								if (!isOptionChecked(i, option)) continue;
								if (option.isCustom) {
									answer.push(`custom: ${customText.trim()}`);
									continue;
								}
								answer.push(`${i + 1}. ${option.value}`);
								presetIndexes.push(i + 1);
							}
							if (answer.length === 0) return;
							done({ answerType: "multi", answer, presetIndexes });
							return;
						}

						if (selected?.isCustom) {
							const answer = customText.trim();
							if (!answer) return;
							done({ answerType: "custom", answer });
							return;
						}
						done({
							answerType: "preset",
							answer: selected?.value ?? "",
							presetIndex: selectedIndex + 1,
						});
						return;
					}

					return;
				}

				function render(width: number): string[] {
					if (cache) return cache;
					const lines: string[] = [];
					const add = (line: string) => lines.push(truncateToWidth(line, width));

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("text", ` ${params.question}`));
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const option = allOptions[i];
						const sel = i === selectedIndex;
						const checked = isOptionChecked(i, option);
						const checkbox = checked ? "[x]" : "[ ]";
						let label = option.label;

						if (option.isCustom && sel) {
							const before = customText.slice(0, customCursor);
							const after = customText.slice(customCursor);
							const inlineValue = customText.length > 0 ? `${before}█${after}` : "█";
							label = customText.length > 0 ? inlineValue : `${option.label} ${inlineValue}`;
						} else if (option.isCustom && customText.length > 0) {
							label = customText;
						}

						const row = `${i + 1}. ${label}`;
						let text: string;
						if (multiple) {
							if (sel) {
								text = theme.fg("accent", `${checkbox} ${row}`);
							} else {
								const themedCheckbox = checked ? theme.fg("accent", checkbox) : theme.fg("muted", checkbox);
								text = `${themedCheckbox} ${theme.fg("text", row)}`;
							}
						} else {
							text = sel ? theme.fg("accent", `${i + 1}. ${label}`) : theme.fg("text", `${i + 1}. ${label}`);
						}

						const prefix = sel ? theme.fg("accent", "> ") : "  ";
						add(prefix + text);
					}

					lines.push("");
					add(
						theme.fg(
							"dim",
							multiple
								? " ↑↓ navigate • Space to toggle • type on freeform option • Enter to submit • Esc to cancel/clear"
								: " ↑↓ navigate • type on freeform option • Enter to submit • Esc to cancel/clear",
						),
					);
					add(theme.fg("accent", "─".repeat(width)));

					cache = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cache = undefined;
					},
					handleInput,
				};
			});

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details: {
						question: params.question,
						presetAnswers: params.options,
						answer: "",
						answerType: "preset",
					} as AnswerDetails,
				};
			}

			const details: AnswerDetails = {
				question: params.question,
				presetAnswers: params.options,
				answer: result.answer,
				answerType: result.answerType,
			};
			if (result.answerType === "preset") {
				details.presetIndex = result.presetIndex;
			}
			if (result.answerType === "multi") {
				details.presetIndexes = result.presetIndexes;
			}

			let contentText = "";
			if (result.answerType === "custom") {
				contentText = `User answered (freeform): ${result.answer}`;
			} else if (result.answerType === "multi") {
				contentText = `User selected options:\n${result.answer.map((item) => `- ${item}`).join("\n")}`;
			} else {
				contentText = `User selected option ${result.presetIndex}: ${result.answer}`;
			}

			return {
				content: [{ type: "text", text: contentText }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const count = Array.isArray(args.options) ? args.options.length : 0;
			const mode = args.multiple ? "multi-select" : "single";
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_question ")) +
					theme.fg("muted", `${count} preset + freeform option (${mode})`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AnswerDetails | undefined;
			if (!details) {
				const fallback = result.content[0];
				return new Text(fallback?.type === "text" ? fallback.text : "", 0, 0);
			}
			if (!details.answer) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

			if (details.answerType === "custom") {
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", details.answer as string) +
						theme.fg("muted", " (freeform)"),
					0,
					0,
				);
			}

			if (details.answerType === "multi") {
				const values = Array.isArray(details.answer) ? details.answer : [];
				if (values.length === 0) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				return new Text(
					theme.fg("success", "✓ Selected:\n") +
						values.map((item) => theme.fg("accent", `- ${item}`)).join("\n"),
					0,
					0,
				);
			}

			const label =
				details.presetIndex && details.presetIndex > 0
					? `${details.presetIndex}. ${details.answer}`
					: (details.answer as string);
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", label), 0, 0);
		},
	});
}
