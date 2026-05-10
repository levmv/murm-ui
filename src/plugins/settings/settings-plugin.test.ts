import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
import type { ChatEngine } from "../../core/chat-engine";
import type { ChatProvider, ChatRequestDefaults, RequestOptions } from "../../core/types";
import { SettingsPlugin, type SettingsState, type SettingsStorage } from "./settings-plugin";

const originalDocument = globalThis.document;
const originalLocalStorage = globalThis.localStorage;
const originalConsoleWarn = console.warn;

afterEach(() => {
	setGlobal("document", originalDocument);
	setGlobal("localStorage", originalLocalStorage);
	console.warn = originalConsoleWarn;
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

async function waitFor(assertion: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!assertion()) {
		if (Date.now() - start > 1000) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function captureWarnings(): unknown[][] {
	const warnings: unknown[][] = [];
	console.warn = (...args: unknown[]) => {
		warnings.push(args);
	};
	return warnings;
}

test("SettingsPlugin saves and applies title model settings", async () => {
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

	await waitFor(() => titleOptionCalls.length === 1, "initial settings load");

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

test("SettingsPlugin modal exposes useful names for assistive tech", async () => {
	const container = installDom();
	const engine = {
		setProvider: () => {},
		setRequestDefaults: () => {},
		setTitleOptions: () => {},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin();

	plugin.onMount?.({ engine, container });

	await waitFor(() => container.querySelector(".mur-settings-btn") !== null, "settings button");
	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();

	const modal = container.querySelector<HTMLElement>(".mur-settings-modal");
	assert.ok(modal);
	assert.equal(modal.getAttribute("role"), "dialog");
	assert.equal(modal.getAttribute("aria-modal"), "true");
	assert.equal(document.getElementById(modal.getAttribute("aria-labelledby") ?? "")?.textContent, "Chat Settings");
	assert.equal(container.querySelector(".mur-settings-close-btn")?.getAttribute("aria-label"), "Close settings");
	const modelInput = container.querySelector<HTMLInputElement>(".mur-set-model");
	const modelLabel = container.querySelector<HTMLLabelElement>(`label[for="${modelInput?.id}"]`);
	assert.equal(modelLabel?.textContent, "Model Name");

	plugin.destroy?.();
});

test("SettingsPlugin modal focuses the first field and closes on Escape", async () => {
	const container = installDom();
	const engine = {
		setProvider: () => {},
		setRequestDefaults: () => {},
		setTitleOptions: () => {},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin();

	plugin.onMount?.({ engine, container });

	await waitFor(() => container.querySelector(".mur-settings-btn") !== null, "settings button");
	const settingsBtn = container.querySelector<HTMLButtonElement>(".mur-settings-btn");
	assert.ok(settingsBtn);

	settingsBtn.focus();
	settingsBtn.click();

	const endpointInput = container.querySelector<HTMLInputElement>(".mur-set-endpoint");
	assert.equal(document.activeElement, endpointInput);

	document.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Escape" }));

	assert.equal(container.querySelector(".mur-settings-modal"), null);
	assert.equal(document.activeElement, settingsBtn);

	plugin.destroy?.();
});

test("SettingsPlugin modal keeps Tab focus inside the dialog", async () => {
	const container = installDom();
	const engine = {
		setProvider: () => {},
		setRequestDefaults: () => {},
		setTitleOptions: () => {},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin();

	plugin.onMount?.({ engine, container });

	await waitFor(() => container.querySelector(".mur-settings-btn") !== null, "settings button");
	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();

	const closeBtn = container.querySelector<HTMLButtonElement>(".mur-settings-close-btn");
	const endpointInput = container.querySelector<HTMLInputElement>(".mur-set-endpoint");
	const saveBtn = container.querySelector<HTMLButtonElement>(".mur-set-save-btn");
	assert.ok(closeBtn);
	assert.ok(endpointInput);
	assert.ok(saveBtn);

	saveBtn.focus();
	document.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
	assert.equal(document.activeElement, closeBtn);

	closeBtn.focus();
	document.dispatchEvent(
		new document.defaultView!.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
	);
	assert.equal(document.activeElement, saveBtn);

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).focus();
	document.dispatchEvent(new document.defaultView!.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
	assert.equal(document.activeElement, closeBtn);

	plugin.destroy?.();
});

test("SettingsPlugin loads and saves through a custom storage adapter", async () => {
	const container = installDom();
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};
	let getCalls = 0;
	const savedStates: SettingsState[] = [];
	const storage: SettingsStorage = {
		async get() {
			getCalls++;
			return {
				model: "stored-model",
				titleModel: "stored-title",
				systemPrompt: "stored prompt",
			};
		},
		async set(state) {
			savedStates.push({ ...state });
		},
	};
	const providerSettings: SettingsState[] = [];
	const requestDefaults: Partial<ChatRequestDefaults>[] = [];
	const titleOptionCalls: Partial<RequestOptions>[] = [];
	const engine = {
		setProvider: () => {},
		setRequestDefaults: (defaults: Partial<ChatRequestDefaults>) => {
			requestDefaults.push(defaults);
		},
		setTitleOptions: (options: Partial<RequestOptions>) => {
			titleOptionCalls.push(options);
		},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin({
		defaultEndpoint: "https://default.test/chat",
		defaultModel: "default-model",
		defaultTitleModel: "default-title",
		defaultSystemPrompt: "default prompt",
		storage,
		createProvider: (settings) => {
			providerSettings.push({ ...settings });
			return provider;
		},
	});

	plugin.onMount?.({ engine, container });

	await waitFor(() => providerSettings.length === 1, "custom settings load");

	assert.equal(getCalls, 1);
	assert.deepEqual(providerSettings[0], {
		endpoint: "https://default.test/chat",
		apiKey: "",
		model: "stored-model",
		titleModel: "stored-title",
		systemPrompt: "stored prompt",
	});
	assert.deepEqual(requestDefaults[0], { instructions: "stored prompt" });
	assert.deepEqual(titleOptionCalls[0], { model: "stored-title" });

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();
	(container.querySelector(".mur-set-endpoint") as HTMLInputElement).value = "https://saved.test/chat";
	(container.querySelector(".mur-set-apikey") as HTMLInputElement).value = "saved-key";
	(container.querySelector(".mur-set-model") as HTMLInputElement).value = "saved-model";
	(container.querySelector(".mur-set-title-model") as HTMLInputElement).value = "saved-title";
	(container.querySelector(".mur-set-sysprompt") as HTMLTextAreaElement).value = "saved prompt";
	(container.querySelector(".mur-set-save-btn") as HTMLButtonElement).click();

	await waitFor(() => savedStates.length === 1, "custom settings save");

	assert.deepEqual(savedStates[0], {
		endpoint: "https://saved.test/chat",
		apiKey: "saved-key",
		model: "saved-model",
		titleModel: "saved-title",
		systemPrompt: "saved prompt",
	});
});

test("SettingsPlugin falls back to defaults when storage load fails", async () => {
	const container = installDom();
	const warnings = captureWarnings();
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};
	const providerSettings: SettingsState[] = [];
	const engine = {
		setProvider: () => {},
		setRequestDefaults: () => {},
		setTitleOptions: () => {},
	} as unknown as ChatEngine;
	const plugin = SettingsPlugin({
		defaultModel: "fallback-model",
		defaultTitleModel: "fallback-title",
		storage: {
			async get() {
				throw new Error("load failed");
			},
			async set() {},
		},
		createProvider: (settings) => {
			providerSettings.push({ ...settings });
			return provider;
		},
	});

	plugin.onMount?.({ engine, container });

	await waitFor(() => providerSettings.length === 1, "fallback settings load");

	assert.equal(providerSettings[0].model, "fallback-model");
	assert.equal(providerSettings[0].titleModel, "fallback-title");
	assert.match(String(warnings[0][0]), /Could not read settings from storage/);
});

test("SettingsPlugin applies settings when storage save fails", async () => {
	const container = installDom();
	const warnings = captureWarnings();
	const provider: ChatProvider = {
		async streamChat(): Promise<void> {},
	};
	let setProviderCalls = 0;
	const titleOptionCalls: Partial<RequestOptions>[] = [];
	const setAttempts: SettingsState[] = [];
	const engine = {
		setProvider: () => {
			setProviderCalls++;
		},
		setRequestDefaults: () => {},
		setTitleOptions: (options: Partial<RequestOptions>) => {
			titleOptionCalls.push(options);
		},
	} as unknown as ChatEngine;
	const storage: SettingsStorage = {
		async get() {
			return { model: "loaded-model" };
		},
		async set(state) {
			setAttempts.push({ ...state });
			throw new Error("save failed");
		},
	};
	const plugin = SettingsPlugin({
		storage,
		createProvider: () => provider,
	});

	plugin.onMount?.({ engine, container });
	await waitFor(() => titleOptionCalls.length === 1, "initial settings load");

	(container.querySelector(".mur-settings-btn") as HTMLButtonElement).click();
	(container.querySelector(".mur-set-title-model") as HTMLInputElement).value = "new-title";
	(container.querySelector(".mur-set-save-btn") as HTMLButtonElement).click();

	await waitFor(() => warnings.length === 1, "save warning");

	assert.equal(setProviderCalls, 1);
	assert.equal(setAttempts[0].titleModel, "new-title");
	assert.deepEqual(titleOptionCalls.at(-1), { model: "new-title" });
	assert.match(String(warnings[0][0]), /Could not save settings to storage/);
});
