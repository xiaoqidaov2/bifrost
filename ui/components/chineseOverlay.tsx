import { getZhPhrases, UI_LOCALE } from "@/lib/i18n";
import { useEffect } from "react";

/**
 * Runtime Chinese overlay for residual English UI text.
 * Bifrost OSS has no official i18n framework; this walks text nodes and
 * replaces known English phrases with zh-CN. Structural keys use t() at source.
 */
export default function ChineseOverlay() {
	useEffect(() => {
		if (typeof document === "undefined") return;
		document.documentElement.lang = UI_LOCALE;

		const phrases = getZhPhrases();
		const skipTags = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE", "PRE", "KBD", "SAMP"]);

		const translateText = (raw: string): string | null => {
			const text = raw;
			const trimmed = text.trim();
			if (!trimmed) return null;
			// Exact full-string match first
			for (const [en, zh] of phrases) {
				if (trimmed === en) {
					const lead = text.match(/^\s*/)?.[0] ?? "";
					const trail = text.match(/\s*$/)?.[0] ?? "";
					return lead + zh + trail;
				}
			}
			// Multi-word phrase containment (only if whole phrase appears as token-ish)
			let out = text;
			let changed = false;
			for (const [en, zh] of phrases) {
				if (en.length < 3) continue;
				if (out.includes(en)) {
					out = out.split(en).join(zh);
					changed = true;
				}
			}
			return changed ? out : null;
		};

		const walk = (root: Node) => {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			const nodes: Text[] = [];
			let n: Node | null;
			while ((n = walker.nextNode())) {
				const parent = n.parentElement;
				if (!parent) continue;
				if (skipTags.has(parent.tagName)) continue;
				if (parent.closest("[data-no-i18n],[contenteditable=true]")) continue;
				nodes.push(n as Text);
			}
			for (const node of nodes) {
				const next = translateText(node.nodeValue ?? "");
				if (next != null && next !== node.nodeValue) {
					node.nodeValue = next;
				}
			}
			// Common attributes
			root.querySelectorAll?.("[placeholder],[title],[aria-label]").forEach((el) => {
				for (const attr of ["placeholder", "title", "aria-label"] as const) {
					const v = el.getAttribute(attr);
					if (!v) continue;
					const nv = translateText(v);
					if (nv != null) el.setAttribute(attr, nv.trim());
				}
			});
		};

		walk(document.body);

		const mo = new MutationObserver((mutations) => {
			for (const m of mutations) {
				if (m.type === "characterData" && m.target.nodeType === Node.TEXT_NODE) {
					const next = translateText(m.target.nodeValue ?? "");
					if (next != null && next !== m.target.nodeValue) {
						m.target.nodeValue = next;
					}
				}
				m.addedNodes.forEach((node) => {
					if (node.nodeType === Node.ELEMENT_NODE) walk(node);
					else if (node.nodeType === Node.TEXT_NODE) {
						const next = translateText(node.nodeValue ?? "");
						if (next != null) node.nodeValue = next;
					}
				});
			}
		});
		mo.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => mo.disconnect();
	}, []);

	return null;
}
