import { extractPlainText } from "../../core/msg-utils";
import type { ChatPlugin } from "../../core/types";
import { defaultLabels } from "../../labels";
import { ICON_CHECK, ICON_COPY } from "../../utils/icons";

export function CopyPlugin(): ChatPlugin {
	return {
		name: "copy",
		getActionButtons: (msg, labels = defaultLabels) => {
			if (msg.role !== "assistant") return [];
			if (typeof navigator === "undefined" || !navigator.clipboard) return [];
			if (!msg.blocks.some((block) => block.type === "text" && /\S/.test(block.text))) return [];

			return [
				{
					id: "copy",
					mutates: false,
					title: labels.copyMessage,
					iconHtml: ICON_COPY,
					onClick: async ({ message, buttonEl }) => {
						try {
							const textToCopy = extractPlainText(message);
							await navigator.clipboard.writeText(textToCopy);
							buttonEl.innerHTML = ICON_CHECK;
							setTimeout(() => {
								if (buttonEl.isConnected) {
									buttonEl.innerHTML = ICON_COPY;
								}
							}, 2000);
						} catch {
							// Leave the icon unchanged when clipboard access fails.
						}
					},
				},
			];
		},
	};
}
