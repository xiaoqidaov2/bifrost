import { zhCN, zhCNPhrases } from "./zh-CN";

/** Default UI locale for this OSS deployment (solo Chinese operator). */
export const UI_LOCALE = "zh-CN" as const;

/**
 * Translate an English UI string to Chinese.
 * Falls back to the original string when no mapping exists.
 */
export function t(en: string | undefined | null): string {
	if (en == null || en === "") return en ?? "";
	return zhCN[en] ?? en;
}

/** Translate title+description pairs commonly used in sidebar items. */
export function tNav(item: { title: string; description?: string }) {
	return {
		...item,
		title: t(item.title),
		description: item.description != null ? t(item.description) : item.description,
	};
}

export function getZhPhrases() {
	return zhCNPhrases;
}

export { zhCN };
