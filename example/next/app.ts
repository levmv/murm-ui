import { AttachmentPlugin } from "../../src/plugins/attachment/attachment-plugin";
import { CopyPlugin } from "../../src/plugins/copy/copy-plugin";
import { thinking } from "../../src/plugins/thinking/thinking-plugin";
import { tools } from "../../src/plugins/tools/tools-plugin";
import { Sidebar, type SidebarSession } from "../../src/sidebar";
import { ICON_SIDEBAR } from "../../src/utils/icons";
import { type ChatLabels, ChatView, Composer } from "../../src/view";
import "../../src/styles/base.css";
import "../../src/styles/sidebar.css";
import "../../src/styles/dropdown.css";
import "../../src/styles/input.css";
import "../../src/styles/feed.css";
import "../../src/styles/view.css";
import "../../src/styles/composer.css";
import "./demo.css";
import { researchCard } from "./card";
import { MockAgent } from "./mock-agent";

const backend = new MockAgent();
const conversation = document.querySelector<HTMLSelectElement>("#conversation")!;
const readonly = document.querySelector<HTMLInputElement>("#readonly")!;
const sessions: SidebarSession[] = [
	{ id: "research", title: "Исследование" },
	{ id: "notes", title: "Заметки" },
];
const footer = document.createElement("label");
footer.className = "mur-sidebar-nav-btn";
footer.innerHTML = '<input id="dark" type="checkbox" /><span>Тёмная тема</span>';
document.querySelector(".mur-open-sidebar-btn")!.innerHTML = ICON_SIDEBAR;
const sidebar = new Sidebar({
	container: "#demo",
	header: "murm-ui",
	links: [
		{
			label: "Подробный чат",
			href: "#detailed",
			onClick: () => document.querySelector("#detailed")!.scrollIntoView({ block: "nearest" }),
		},
		{
			label: "Краткий чат",
			href: "#summary",
			onClick: () => document.querySelector("#summary")!.scrollIntoView({ block: "nearest" }),
		},
	],
	footer,
	labels: {
		close: "Свернуть меню",
		rename: "Переименовать",
		pin: "Закрепить",
		unpin: "Открепить",
		empty: "Нет бесед",
		options: (title) => `Действия: ${title}`,
		renameChat: (title) => `Название: ${title}`,
		pinned: "Закреплено",
	},
	onSelect: (id) => {
		conversation.value = id;
		selectConversation();
	},
	onRename: (id, title) => {
		sessions.find((session) => session.id === id)!.title = title;
		Array.from(conversation.options).find((option) => option.value === id)!.textContent = title;
		syncSidebar();
	},
	onPin: (id, isPinned) => {
		sessions.find((session) => session.id === id)!.isPinned = isPinned;
		syncSidebar();
	},
});

function syncSidebar() {
	sidebar.update({
		sessions: [...sessions].sort((a, b) => Number(!!b.isPinned) - Number(!!a.isPinned)),
		activeId: conversation.value,
	});
}

const labels: Partial<ChatLabels> = {
	message: "Сообщение",
	messagePlaceholder: "Написать сообщение…",
	send: "Отправить",
	stop: "Остановить",
	attach: "Прикрепить файлы",
	attachments: "Вложения",
	uploading: "Загрузка…",
	removeAttachment: (name) => `Удалить ${name}`,
	loadingOlder: "Загружаем историю…",
	assistant: "Ответ ассистента",
	copyMessage: "Копировать сообщение",
	copyCode: "Копировать код",
	thinking: "Размышляем…",
	thoughtProcess: "Ход рассуждений",
	hiddenReasoning: "Модель скрыла ход рассуждений.",
	toggleReasoning: "Развернуть рассуждения",
	toolArguments: "Аргументы",
	toolResult: "Результат",
	toolError: "Ошибка",
	toolFailed: "Не удалось выполнить действие.",
	toolRunning: "Выполняется…",
	toolWaiting: "Ожидаем результат…",
	toolNoResult: "Нет результата.",
	toolStatus: (status) =>
		({ pending: "В очереди", streaming: "Подготовка", running: "Выполняется", complete: "Готово", error: "Ошибка" })[
			status
		] ?? status,
	workSummary: (count, reasoningOnly, duration) =>
		`${count ? `Действий: ${count}` : reasoningOnly ? "Рассуждения" : "Работа"}${duration ? ` · ${Math.round(duration / 1000)} с` : ""}`,
};
const onAttach = (request: Parameters<MockAgent["attach"]>[0]) => backend.attach(request);
const onStop = ({ conversationId }: { conversationId: string }) => backend.stop(conversationId);
const views = ["detailed", "summary"].map(
	(mode) =>
		new ChatView({
			container: `#${mode}`,
			plugins: [researchCard(), tools({ details: mode === "detailed" }), thinking(), CopyPlugin()],
			labels,
			showReasoning: mode === "detailed",
			onAction: (command) => backend.action(command),
			onReachTop: () => void loadOlder(),
		}),
);

const composers = views.map(
	(view) =>
		new Composer({
			container: view.element.querySelector<HTMLElement>(".mur-main-area")!,
			labels,
			plugins: [AttachmentPlugin({ onAttach })],
			onStop,
			onSubmit: (command) => {
				view.scrollToLatest();
				return backend.submit(command);
			},
		}),
);

// The adapter owns subscriptions, ordering and reconnection. ChatView only
// applies the current conversation's normalized state; it never saves history.
const unsubscribe = backend.subscribe((update) => {
	for (const view of views) view.apply(update);
});
backend.onRunningChange = (id) => {
	if (id === conversation.value) syncCapabilities();
};
let olderCursor: string | null = null;
let loadingOlder = false;
let historyEpoch = 0;

async function loadOlder() {
	if (olderCursor === null || loadingOlder) return;
	const epoch = historyEpoch;
	const id = conversation.value;
	loadingOlder = true;
	for (const view of views) {
		view.setError(null);
		view.setOlderMessagesState(true, true);
	}
	try {
		const page = await backend.loadOlder(id, olderCursor);
		if (epoch !== historyEpoch) return;
		olderCursor = page.olderCursor;
		for (const view of views) view.prependMessages(id, page.messages);
	} catch (error) {
		if (epoch === historyEpoch) for (const view of views) view.setError(String(error));
	} finally {
		if (epoch === historyEpoch) {
			loadingOlder = false;
			for (const view of views) view.setOlderMessagesState(olderCursor !== null, false);
		}
	}
}

function selectConversation() {
	syncSidebar();
	const snapshot = backend.snapshot(conversation.value);
	historyEpoch++;
	loadingOlder = false;
	olderCursor = snapshot.olderCursor;
	for (const view of views) {
		view.setConversation(snapshot);
		view.setOlderMessagesState(olderCursor !== null, false);
	}
	for (const composer of composers) composer.setConversation(snapshot.id);
	syncCapabilities();
}

function syncCapabilities() {
	const capabilities = {
		canSubmit: !readonly.checked,
		canStop: !readonly.checked && backend.canStop(conversation.value),
	};
	for (const composer of composers) composer.setCapabilities(capabilities);
	for (const view of views) view.setCanAct(!readonly.checked);

	document.querySelector<HTMLButtonElement>("#parallel")!.disabled = readonly.checked;
}

conversation.addEventListener("change", selectConversation);
readonly.addEventListener("change", syncCapabilities);
document.querySelector<HTMLInputElement>("#dark")!.addEventListener("change", (event) => {
	document.body.dataset.theme = (event.target as HTMLInputElement).checked ? "dark" : "light";
});
document.querySelector("#older")!.addEventListener("click", () => {
	void loadOlder();
});
document.querySelector("#parallel")!.addEventListener("click", () => {
	for (const text of ["Найди источники", "Проверь выводы"])
		void backend.submit({
			conversationId: conversation.value,
			text,
			clientRequestId: crypto.randomUUID(),
			blocks: [],
			signal: new AbortController().signal,
		});
});
window.addEventListener("pagehide", () => {
	unsubscribe();
	for (const view of views) view.destroy();
	for (const composer of composers) composer.destroy();
	sidebar.destroy();
	backend.dispose();
});
selectConversation();
