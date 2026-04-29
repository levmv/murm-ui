import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatEngine } from "../../core/chat-engine";
import type { ChatProvider, RequestOptions } from "../../core/types";
import { SettingsPlugin } from "./settings-plugin";

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
	setGlobal("document", originalDocument);
	setGlobal("localStorage", originalLocalStorage);
});

function setGlobal(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
		writable: true,
	});
}

function installDom(): HTMLElement {
	const dom = new JSDOM('<div class="mur-app"><div class="mur-sidebar-footer"></div></div>', {
		url: "https://example.test/",
	});
	setGlobal("document", dom.window.document);
	setGlobal("localStorage", dom.window.localStorage);
	return dom.window.document.querySelector(".mur-app") as HTMLElement;
}

test("SettingsPlugin saves and applies title model settings", () => {
	const container = installDom();
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};
	let setProviderCalls = 0;
	const titleOptionCalls: Partial<RequestOptions>[] = [];
	const providerSettings: { model: string; titleModel: string }[] = [];
	const engine = {
		setProvider: () => {
			setProviderCalls++;
		},
		setRequestDefaults: () => {},
		setTitleOptions: (options: Partial<RequestOptions>) => {
			titleOptionCalls.push(options);
		},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin({
		defaultModel: "chat-model",
		defaultTitleModel: "title-default",
		createProvider: (settings) => {
			providerSettings.push({ model: settings.model, titleModel: settings.titleModel });
			return provider;
		},
	});

	plugin.onMount?.({ engine, container });

	assert.deepEqual(titleOptionCalls[0], { model: "title-default" });
	assert.equal(setProviderCalls, 1);
	assert.deepEqual(providerSettings, [{ model: "chat-model", titleModel: "title-default" }]);

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();
	let titleInput = container.querySelector(".mur-set-title-model") as HTMLInputElement;
	assert.equal(titleInput.value, "title-default");
	titleInput.value = "cheap-title";
	(container.querySelector(".mur-set-save-btn") as HTMLButtonElement).click();

	let saved = JSON.parse(localStorage.getItem("mur_chat_settings") ?? "{}") as { titleModel?: string };
	assert.equal(saved.titleModel, "cheap-title");
	assert.deepEqual(titleOptionCalls.at(-1), { model: "cheap-title" });
	assert.equal(setProviderCalls, 1);
	assert.equal(providerSettings.length, 1);

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();
	titleInput = container.querySelector(".mur-set-title-model") as HTMLInputElement;
	titleInput.value = "";
	(container.querySelector(".mur-set-save-btn") as HTMLButtonElement).click();

	saved = JSON.parse(localStorage.getItem("mur_chat_settings") ?? "{}") as { titleModel?: string };
	assert.equal(saved.titleModel, "");
	assert.deepEqual(titleOptionCalls.at(-1), { model: undefined });
	assert.equal(setProviderCalls, 1);
	assert.equal(providerSettings.length, 1);

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();
	const modelInput = container.querySelector(".mur-set-model") as HTMLInputElement;
	modelInput.value = "new-chat-model";
	(container.querySelector(".mur-set-save-btn") as HTMLButtonElement).click();

	assert.equal(setProviderCalls, 2);
	assert.deepEqual(providerSettings.at(-1), { model: "new-chat-model", titleModel: "" });
});
