import "./settings.css";
import { OpenAIProvider } from "../../core/providers/openai";
import type { ChatPlugin, ChatProvider, PluginContext } from "../../core/types";
import { el } from "../../utils/dom";
import { ICON_SETTINGS } from "../../utils/icons";

export interface SettingsState {
	endpoint: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
}

export interface SettingsPluginConfig {
	defaultEndpoint?: string;
	defaultModel?: string;
	defaultSystemPrompt?: string;

	/**
	 * Optional. A CSS selector for an existing button in your custom HTML.
	 * If provided, the plugin will NOT create its own button, but will instead
	 * attach the settings modal click-listener to your existing element.
	 */
	triggerSelector?: string;
	/**
	 * A factory function that returns the correct ProviderAdapter based on the settings.
	 * Defaults to returning an OpenAIAdapter.
	 */
	createAdapter?: (settings: SettingsState) => ChatProvider;
}

export function SettingsPlugin(config?: SettingsPluginConfig): ChatPlugin {
	const STORAGE_KEY = "llm_chat_settings";

	// Default fallback values
	const defaults = {
		endpoint: config?.defaultEndpoint || "https://api.openai.com/v1/chat/completions",
		apiKey: "",
		model: config?.defaultModel || "gpt-4o-mini",
		systemPrompt: config?.defaultSystemPrompt || "",
	};

	let currentSettings = { ...defaults };

	// Load from local storage
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			currentSettings = { ...defaults, ...JSON.parse(saved) };
		}
	} catch (e) {
		console.warn("Could not read settings from localStorage");
	}

	let modalOverlay: HTMLElement | null = null;
	let mountedTriggerEl: Element | null = null;
	let mountedTriggerHandler: (() => void) | null = null;

	const buildAdapter = config?.createAdapter ?? ((s) => new OpenAIProvider(s.apiKey, s.endpoint, s.model));

	function applySettings(ctx: PluginContext, settings: typeof currentSettings) {
		currentSettings = settings;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
		} catch (e) {}

		ctx.engine.setProvider(buildAdapter(settings));

		ctx.engine.setRequestDefaults({
			systemPrompt: settings.systemPrompt || undefined,
		});
	}

	function createModal(ctx: PluginContext) {
		const overlay = el("div", "settings-overlay");

		const modal = el("div", "settings-modal", {
			innerHTML: `
				<div class="settings-header">
					<h3>Chat Settings</h3>
					<button class="settings-close-btn">&times;</button>
				</div>
				<div class="settings-body">
					<div class="settings-group">
						<label>API Endpoint</label>
						<input type="text" class="llm-set-endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
						<div class="settings-hint">Compatible with OpenAI, OpenRouter, LMStudio, Ollama, etc.</div>
					</div>
					<div class="settings-group">
						<label>API Key</label>
						<input type="password" class="llm-set-apikey" placeholder="sk-..." />
					</div>
					<div class="settings-group">
						<label>Model Name</label>
						<input type="text" class="llm-set-model" placeholder="gpt-4o-mini" />
					</div>
					<div class="settings-group">
						<label>System Prompt</label>
						<textarea class="llm-set-sysprompt" rows="3" placeholder="You are a helpful assistant..."></textarea>
					</div>
				</div>
				<div class="settings-footer">
					<button class="llm-set-save-btn btn-primary">Save & Apply</button>
				</div>
			`,
		});

		overlay.appendChild(modal);

		(modal.querySelector(".llm-set-endpoint") as HTMLInputElement).value = currentSettings.endpoint;
		(modal.querySelector(".llm-set-apikey") as HTMLInputElement).value = currentSettings.apiKey;
		(modal.querySelector(".llm-set-model") as HTMLInputElement).value = currentSettings.model;
		(modal.querySelector(".llm-set-sysprompt") as HTMLTextAreaElement).value = currentSettings.systemPrompt;

		const close = () => {
			overlay.remove();
			modalOverlay = null;
		};

		modal.querySelector(".settings-close-btn")!.addEventListener("click", close);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close();
		});

		modal.querySelector(".llm-set-save-btn")!.addEventListener("click", () => {
			const newSettings = {
				endpoint: (modal.querySelector(".llm-set-endpoint") as HTMLInputElement).value.trim(),
				apiKey: (modal.querySelector(".llm-set-apikey") as HTMLInputElement).value.trim(),
				model: (modal.querySelector(".llm-set-model") as HTMLInputElement).value.trim(),
				systemPrompt: (modal.querySelector(".llm-set-sysprompt") as HTMLTextAreaElement).value.trim(),
			};
			applySettings(ctx, newSettings);
			close();
		});

		return overlay;
	}

	return {
		name: "settings",

		onMount: (ctx) => {
			applySettings(ctx, currentSettings);

			const openModal = () => {
				if (!modalOverlay) {
					modalOverlay = createModal(ctx);
					ctx.container.appendChild(modalOverlay);
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

			const footer = ctx.container.querySelector(".sidebar-footer");
			if (footer) {
				const btn = el("button", "settings-btn", {
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
			modalOverlay?.remove();
			modalOverlay = null;
			mountedTriggerEl = null;
			mountedTriggerHandler = null;
		},
	};
}
