import type { ContentBlock } from "../../src/core/types";
import {
	type BlockAction,
	type ConversationChange,
	ConversationModel,
	type ConversationSnapshot,
	type ConversationUpdate,
	type Message,
	type SubmitCommand,
} from "../../src/view";

interface HistoryPage {
	messages: Message[];
	olderCursor: string | null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const HISTORY_LENGTH = 36;

/** Mock application/backend boundary. Replace these methods with HTTP + SSE/WS. */
export class MockAgent {
	private readonly conversations = new Map<string, ConversationModel>();
	private readonly listeners = new Set<(update: ConversationUpdate) => void>();
	private readonly accepted = new Set<string>();
	private readonly runs = new Map<string, { conversationId: string; cancel: () => void }>();
	private revision = 0;
	onRunningChange?: (conversationId: string) => void;

	constructor() {
		for (const id of ["research", "notes"]) {
			const model = new ConversationModel();
			model.setConversation({ id, messages: seed(id) });
			this.conversations.set(id, model);
		}
	}

	subscribe(listener: (update: ConversationUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshot(id: string): ConversationSnapshot & { olderCursor: string | null } {
		const state = structuredClone(this.model(id).state);
		const messages = state.messages.slice(HISTORY_LENGTH);
		return { ...state, messages, olderCursor: state.messages.length > messages.length ? messages[0].id : null };
	}

	canStop(id: string): boolean {
		return Array.from(this.runs.values()).some((run) => run.conversationId === id);
	}

	async loadOlder(id: string, cursor: string): Promise<HistoryPage> {
		await delay(450);
		const all = this.model(id).state.messages;
		const end = all.findIndex((message) => message.id === cursor);
		if (end < 0) throw new Error("Unknown history cursor");
		const start = Math.max(0, end - 12);
		return { messages: structuredClone(all.slice(start, end)), olderCursor: start > 0 ? all[start].id : null };
	}

	async attach({ file, signal }: { conversationId: string; file: File; signal: AbortSignal }): Promise<ContentBlock> {
		await delay(900);
		if (signal.aborted) throw new Error("Загрузка отменена");
		if (file.size > 2 * 1024 * 1024) throw new Error("В этом примере допустимы файлы до 2 МБ");
		return {
			id: crypto.randomUUID(),
			type: "custom",
			kind: "attachment",
			data: { fileId: crypto.randomUUID(), size: file.size },
			fallbackText: `📎 ${file.name}`,
		};
	}

	async submit(command: SubmitCommand): Promise<void> {
		await delay(250);
		if (command.signal.aborted) throw new Error("Submission detached");
		const { conversationId, clientRequestId: id, blocks } = command;
		const text =
			command.text || blocks.map((block) => (block.type === "custom" ? block.fallbackText : block.id)).join(", ");
		if (this.accepted.has(id)) return;
		this.accepted.add(id);
		const stepId = `${id}-step`;
		const answerId = `${id}-answer`;
		const tool = {
			id: "tool",
			type: "tool_call" as const,
			toolCallId: `${id}-call`,
			name: "web_search",
			argsText: JSON.stringify({ query: text, limit: 5 }),
			summary: "Ищем информацию на пяти сайтах",
			status: "running" as const,
		};
		this.publish(conversationId, [
			{
				type: "message.put",
				message: {
					id,
					runId: id,
					role: "user",
					blocks: [...(command.text ? [{ id: "text", type: "text" as const, text: command.text }] : []), ...blocks],
				},
			},
			{
				type: "message.put",
				message: {
					id: stepId,
					runId: id,
					role: "assistant",
					status: "streaming",
					blocks: [
						{ id: "reasoning", type: "reasoning", text: "Сначала проверю источники, затем сопоставлю результаты." },
						tool,
					],
				},
			},
			{
				type: "message.put",
				message: {
					id: answerId,
					runId: id,
					role: "assistant",
					status: "streaming",
					blocks: [{ id: "answer", type: "text", text: "" }],
				},
			},
		]);
		const answer = `По запросу «${text}» нашлось **пять источников**.\n\nЭто локальный пример потока: можно отправить второй запрос до завершения первого, переключить беседу или написать заметку в карточке выше. Каждый ответ продолжит обновляться по своему ID.\n\n- Подробное представление сохраняет reasoning, аргументы и результаты инструментов.\n- Обобщённое показывает понятные действия без JSON.\n- Данные и выполнение принадлежат приложению.\n`;
		const chunks = answer.match(/.{1,8}|\n/g) ?? [];
		let index = 0;
		const finish = (cancelled: boolean) => {
			clearInterval(timer);
			this.runs.delete(id);
			this.onRunningChange?.(conversationId);
			this.publish(conversationId, [
				{
					type: "block.put",
					messageId: stepId,
					block: {
						...tool,
						status: cancelled ? "error" : "complete",
						summary: cancelled ? "Поиск отменён" : "Посмотрели пять сайтов",
					},
				},
				{ type: "message.state", messageId: stepId, status: "complete" },
				{
					type: "message.state",
					messageId: answerId,
					status: cancelled ? "error" : "complete",
					error: cancelled ? "Остановлено пользователем" : undefined,
				},
			]);
		};
		const timer = setInterval(() => {
			if (index >= chunks.length) {
				finish(false);
				return;
			}
			const changes: ConversationChange[] = [
				{ type: "text.append", messageId: answerId, blockId: "answer", delta: chunks[index++] },
			];
			if (index === 10)
				changes.push({
					type: "message.put",
					beforeId: answerId,
					message: {
						id: `${id}-result`,
						runId: id,
						role: "tool",
						blocks: [
							{
								id: "result",
								type: "tool_result",
								toolCallId: tool.toolCallId,
								outputText: JSON.stringify(
									{
										sites: ["one.example", "two.example", "three.example", "four.example", "five.example"],
										matches: 12,
									},
									null,
									2,
								),
							},
						],
					},
				});
			if (index % 8 === 0) changes.push(this.cardUpdate(conversationId));
			this.publish(conversationId, changes);
		}, 100);
		this.runs.set(id, { conversationId, cancel: () => finish(true) });
		this.onRunningChange?.(conversationId);
	}

	stop(conversationId: string): void {
		for (const run of this.runs.values()) {
			if (run.conversationId === conversationId) run.cancel();
		}
	}

	action(command: BlockAction): void {
		if (command.action !== "save-note") return;
		const payload = command.payload;
		const note =
			payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.text === "string"
				? payload.text
				: "";
		this.publish(command.conversationId, [this.cardUpdate(command.conversationId, `Сохранено: ${note}`)]);
	}

	dispose(): void {
		this.onRunningChange = undefined;
		for (const run of this.runs.values()) run.cancel();
		this.listeners.clear();
	}

	private cardUpdate(conversationId: string, note?: string): ConversationChange {
		const block = this.model(conversationId).state.messages.find((message) => message.id === "card")!.blocks[0];
		if (block.type !== "custom") throw new Error("Missing card");
		const data = block.data as { revision: number; note: string };
		return {
			type: "block.put",
			messageId: "card",
			block: { ...block, data: { revision: ++this.revision, note: note ?? data.note } },
		};
	}

	private model(id: string): ConversationModel {
		const model = this.conversations.get(id);
		if (!model) throw new Error(`Unknown conversation: ${id}`);
		return model;
	}

	private publish(conversationId: string, changes: ConversationChange[]): void {
		const update = { conversationId, changes };
		this.model(conversationId).apply(update);
		for (const listener of this.listeners) listener(update);
	}
}

function seed(id: string): Message[] {
	const history: Message[] = Array.from({ length: HISTORY_LENGTH }, (_, i) => ({
		id: `${id}-old-${i}`,
		role: i % 2 ? "assistant" : "user",
		blocks: [
			{
				id: "text",
				type: "text",
				text: `Прошлое сообщение ${i + 1}. ${i % 2 ? "Сохранённый ответ агента." : "Вопрос из истории беседы."}`,
			},
		],
	}));
	return [
		...history,
		{
			id: "intro",
			role: "user",
			blocks: [
				{
					id: "text",
					type: "text",
					text: id === "research" ? "Проверь источники и подготовь краткий результат." : "Собери заметки по проекту.",
				},
			],
		},
		{
			id: "work",
			role: "assistant",
			blocks: [
				{ id: "thought", type: "reasoning", text: "Сопоставлю источники и проверю локальные заметки." },
				{
					id: "tool",
					type: "tool_call",
					toolCallId: "seed-call",
					name: "read_files",
					argsText: '{"paths":["notes.md","plan.md","sources.json"]}',
					summary: "Прочитали три файла",
					status: "complete",
				},
			],
		},
		{
			id: "result",
			role: "tool",
			blocks: [
				{
					id: "output",
					type: "tool_result",
					toolCallId: "seed-call",
					outputText: '{"files":3,"notes":["check sources","compare results"]}',
				},
			],
		},
		{
			id: "intro-answer",
			role: "assistant",
			blocks: [
				{
					id: "text",
					type: "text",
					text: "Источники проверены. Рабочие шаги можно раскрыть выше; заметку к результату — оставить в карточке ниже.",
				},
			],
		},
		{
			id: "card",
			role: "assistant",
			blocks: [
				{
					id: "research-card",
					type: "custom",
					kind: "demo/research",
					data: { revision: 0, note: "" },
					fallbackText: "Исследование подготовлено",
				},
			],
		},
	];
}
