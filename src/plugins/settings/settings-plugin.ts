import "./settings.css";
import { OpenAIProvider } from "../../core/providers/openai";
import type { ChatPlugin, ChatProvider, PluginContext } from "../../core/types";
import { el } from "../../utils/dom";
import { ICON_SETTINGS } from "../../utils/icons";

export interface SettingsState {
	endpoint: string;
	apiKey: string;
	model: string;
	titleModel: string;
	systemPrompt: string;
}

export interface SettingsStorage {
	get: () => Promise<Partial<SettingsState> | null>;
	set: (state: SettingsState) => Promise<void>;
}

export interface SettingsPluginConfig {
	defaultEndpoint?: string;
	defaultModel?: string;
	defaultTitleModel?: string;
	defaultSystemPrompt?: string;
	storage?: SettingsStorage;

	/**
	 * Optional. A CSS selector for an existing button in your custom HTML.
	 * If provided, the plugin will NOT create its own button, but will instead
	 * attach the settings modal click-listener to your existing element.
	 */
	triggerSelector?: string;
	/**
	 * A factory function that returns the correct provider based on the settings.
	 * Defaults to returning an OpenAIProvider.
	 */
	createProvider?: (settings: SettingsState) => ChatProvider;
}

const STORAGE_KEY = "mur_chat_settings";
let nextSettingsModalId = 0;

const defaultLocalStorageSettingsStorage: SettingsStorage = {
	async get() {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<SettingsState> | null;
	},
	async set(state) {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	},
};

export function SettingsPlugin(config?: SettingsPluginConfig): ChatPlugin {
	// Default fallback values
	const defaults: SettingsState = {
		endpoint: config?.defaultEndpoint || "https://api.openai.com/v1/chat/completions",
		apiKey: "",
		model: config?.defaultModel || "gpt-4o-mini",
		titleModel: config?.defaultTitleModel || "",
		systemPrompt: config?.defaultSystemPrompt || "",
	};

	let currentSettings = { ...defaults };

	let modalOverlay: HTMLElement | null = null;
	let closeModal: (() => void) | null = null;
	let mountedTriggerEl: Element | null = null;
	let mountedTriggerHandler: (() => void) | null = null;
	let appliedProviderSettings: Pick<SettingsState, "apiKey" | "endpoint" | "model"> | null = null;

	const storage = config?.storage ?? defaultLocalStorageSettingsStorage;
	const buildProvider = config?.createProvider ?? ((s) => new OpenAIProvider(s.apiKey, s.endpoint, s.model));

	async function loadInitialSettings(ctx: PluginContext) {
		try {
			const saved = await storage.get();
			applySettings(ctx, { ...defaults, ...(saved ?? {}) }, false);
		} catch (error) {
			console.warn("SettingsPlugin: Could not read settings from storage.", error);
			applySettings(ctx, { ...defaults }, false);
		}
	}

	function applySettings(ctx: PluginContext, settings: SettingsState, persist = true) {
		currentSettings = settings;
		if (persist) {
			try {
				void Promise.resolve(storage.set(settings)).catch((error) => {
					console.warn("SettingsPlugin: Could not save settings to storage.", error);
				});
			} catch (error) {
				console.warn("SettingsPlugin: Could not save settings to storage.", error);
			}
		}

		const providerSettings = {
			endpoint: settings.endpoint,
			apiKey: settings.apiKey,
			model: settings.model,
		};

		if (
			!appliedProviderSettings ||
			appliedProviderSettings.endpoint !== providerSettings.endpoint ||
			appliedProviderSettings.apiKey !== providerSettings.apiKey ||
			appliedProviderSettings.model !== providerSettings.model
		) {
			ctx.engine.setProvider(buildProvider(settings));
			appliedProviderSettings = providerSettings;
		}

		ctx.engine.setRequestDefaults({
			systemPrompt: settings.systemPrompt || undefined,
		});
		ctx.engine.setTitleOptions({
			model: settings.titleModel || undefined,
		});
	}

	function createModal(ctx: PluginContext, triggerEl: Element | null) {
		const overlay = el("div", "mur-settings-overlay");
		const idPrefix = `mur-settings-${++nextSettingsModalId}`;
		const id = (suffix: string) => `${idPrefix}-${suffix}`;

		const modal = el("div", "mur-settings-modal", {
			innerHTML: `
				<div class="mur-settings-header">
					<h3 id="${id("title")}">Chat Settings</h3>
					<button type="button" class="mur-settings-close-btn" aria-label="Close settings">&times;</button>
				</div>
				<div class="mur-settings-body">
					<div class="mur-settings-group">
						<label for="${id("endpoint")}">API Endpoint</label>
						<input id="${id("endpoint")}" type="text" class="mur-set-endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
						<div class="mur-settings-hint">Compatible with OpenAI, OpenRouter, LMStudio, Ollama, etc.</div>
					</div>
					<div class="mur-settings-group">
						<label for="${id("apikey")}">API Key</label>
						<input id="${id("apikey")}" type="password" class="mur-set-apikey" placeholder="sk-..." />
					</div>
					<div class="mur-settings-group">
						<label for="${id("model")}">Model Name</label>
						<input id="${id("model")}" type="text" class="mur-set-model" placeholder="gpt-4o-mini" />
					</div>
					<div class="mur-settings-group">
						<label for="${id("title-model")}">Title Model</label>
						<input id="${id("title-model")}" type="text" class="mur-set-title-model" placeholder="Use chat model" />
					</div>
					<div class="mur-settings-group">
						<label for="${id("sysprompt")}">System Prompt</label>
						<textarea id="${id("sysprompt")}" class="mur-set-sysprompt" rows="3" placeholder="You are a helpful assistant..."></textarea>
					</div>
				</div>
				<div class="mur-settings-footer">
					<button type="button" class="mur-set-save-btn mur-btn-primary">Save & Apply</button>
				</div>
			`,
		});
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", id("title"));

		overlay.appendChild(modal);

		(modal.querySelector(".mur-set-endpoint") as HTMLInputElement).value = currentSettings.endpoint;
		(modal.querySelector(".mur-set-apikey") as HTMLInputElement).value = currentSettings.apiKey;
		(modal.querySelector(".mur-set-model") as HTMLInputElement).value = currentSettings.model;
		(modal.querySelector(".mur-set-title-model") as HTMLInputElement).value = currentSettings.titleModel;
		(modal.querySelector(".mur-set-sysprompt") as HTMLTextAreaElement).value = currentSettings.systemPrompt;

		const restoreFocus = () => {
			if (triggerEl?.isConnected && typeof (triggerEl as HTMLElement).focus === "function") {
				(triggerEl as HTMLElement).focus();
			}
		};

		const getFocusableElements = () =>
			Array.from(
				modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
			).filter((element) => !element.hidden && !element.hasAttribute("disabled"));

		const trapFocus = (event: KeyboardEvent) => {
			const focusable = getFocusableElements();
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) return;

			const activeElement = document.activeElement;
			if (!modal.contains(activeElement)) {
				event.preventDefault();
				first.focus();
			} else if (event.shiftKey && activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};

		function onKeydown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			} else if (event.key === "Tab") {
				trapFocus(event);
			}
		}

		const close = () => {
			document.removeEventListener("keydown", onKeydown);
			overlay.remove();
			modalOverlay = null;
			closeModal = null;
			restoreFocus();
		};

		modal.querySelector(".mur-settings-close-btn")!.addEventListener("click", close);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});

		modal.querySelector(".mur-set-save-btn")!.addEventListener("click", () => {
			const newSettings = {
				endpoint: (modal.querySelector(".mur-set-endpoint") as HTMLInputElement).value.trim(),
				apiKey: (modal.querySelector(".mur-set-apikey") as HTMLInputElement).value.trim(),
				model: (modal.querySelector(".mur-set-model") as HTMLInputElement).value.trim(),
				titleModel: (modal.querySelector(".mur-set-title-model") as HTMLInputElement).value.trim(),
				systemPrompt: (modal.querySelector(".mur-set-sysprompt") as HTMLTextAreaElement).value.trim(),
			};
			applySettings(ctx, newSettings);
			close();
		});

		document.addEventListener("keydown", onKeydown);
		closeModal = close;

		return overlay;
	}

	return {
		name: "settings",

		onMount: (ctx) => {
			void loadInitialSettings(ctx);

			const openModal = () => {
				if (!modalOverlay) {
					modalOverlay = createModal(ctx, mountedTriggerEl);
					ctx.container.appendChild(modalOverlay);
					(modalOverlay.querySelector(".mur-set-endpoint") as HTMLInputElement | null)?.focus();
				}
			};

			if (config?.triggerSelector) {
				const customBtn = document.querySelector(config.triggerSelector);
				if (customBtn) {
					customBtn.addEventListener("click", openModal);
					mountedTriggerEl = customBtn;
					mountedTriggerHandler = openModal;
				} else {
					console.warn(`SettingsPlugin: Could not find element matching triggerSelector "${config.triggerSelector}"`);
				}
				return;
			}

			const footer = ctx.container.querySelector(".mur-sidebar-footer");
			if (footer) {
				const btn = el("button", "mur-settings-btn", {
					title: "Settings",
					innerHTML: ICON_SETTINGS + ` Settings`,
				});

				btn.addEventListener("click", openModal);
				mountedTriggerEl = btn;
				mountedTriggerHandler = openModal;
				footer.appendChild(btn);
			}
		},

		destroy: () => {
			if (mountedTriggerEl && mountedTriggerHandler) {
				mountedTriggerEl.removeEventListener("click", mountedTriggerHandler);
			}
			closeModal?.();
			modalOverlay = null;
			closeModal = null;
			mountedTriggerEl = null;
			mountedTriggerHandler = null;
		},
	};
}
