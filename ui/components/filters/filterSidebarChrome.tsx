import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { PanelLeftClose, PanelLeftOpen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

/**
 * Shared collapse state for filter sidebars.
 * Mobile: always start collapsed (don't inherit desktop expanded cookie).
 * Desktop: restore from localStorage.
 */
export function useFilterSidebarCollapsed(storageKey: string) {
	const isMobile = useIsMobile();
	const [collapsed, setCollapsed] = useState(true);

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (isMobile) {
			setCollapsed(true);
			return;
		}
		const stored = window.localStorage.getItem(storageKey);
		if (stored === "true") setCollapsed(true);
		else if (stored === "false") setCollapsed(false);
		else setCollapsed(false);
	}, [isMobile, storageKey]);

	const toggleCollapsed = useCallback(() => {
		setCollapsed((prev) => {
			const next = !prev;
			if (!isMobile && typeof window !== "undefined") {
				window.localStorage.setItem(storageKey, String(next));
			}
			return next;
		});
	}, [isMobile, storageKey]);

	return { collapsed, setCollapsed, toggleCollapsed, isMobile };
}

type FilterSidebarChromeProps = {
	collapsed: boolean;
	toggleCollapsed: () => void;
	isMobile: boolean;
	activeFilterCount: number;
	onReset?: () => void;
	children: ReactNode;
	/** default "Filters" */
	title?: string;
	testIdPrefix?: string;
};

/**
 * Mobile: collapsed = full-width top bar; expanded = left drawer overlay.
 * Desktop: original left rail / w-64 column.
 */
export function FilterSidebarChrome({
	collapsed,
	toggleCollapsed,
	isMobile,
	activeFilterCount,
	onReset,
	children,
	title = "Filters",
	testIdPrefix = "filter-sidebar",
}: FilterSidebarChromeProps) {
	if (collapsed) {
		if (isMobile) {
			return (
				<button
					type="button"
					onClick={toggleCollapsed}
					className="bg-card border-border flex h-10 w-full shrink-0 items-center justify-between gap-2 rounded-md border px-3 text-sm font-medium"
					title="Show filters"
					aria-label="Show filters"
					data-testid={`${testIdPrefix}-toggle-show`}
				>
					<span className="flex items-center gap-2">
						<PanelLeftOpen className="text-muted-foreground size-4" />
						<span>{title}</span>
						{activeFilterCount > 0 && (
							<span className="bg-primary/10 text-primary flex size-5 items-center justify-center rounded-full text-[11px] font-medium">
								{activeFilterCount}
							</span>
						)}
					</span>
					<span className="text-muted-foreground text-xs">点开筛选</span>
				</button>
			);
		}
		return (
			<button
				type="button"
				onClick={toggleCollapsed}
				className="bg-card group flex h-full w-10 shrink-0 cursor-pointer flex-col items-center gap-3 rounded-r-md py-4 text-sm font-medium"
				title="Show filters"
				aria-label="Show filters"
				data-testid={`${testIdPrefix}-toggle-show`}
			>
				<PanelLeftOpen className="text-muted-foreground group-hover:text-foreground size-4 transition-colors" />
				<span className="rotate-180 select-none [writing-mode:vertical-rl]">{title}</span>
				{activeFilterCount > 0 && (
					<span className="bg-primary/10 text-primary flex size-6 items-center justify-center rounded-full text-xs font-medium">
						{activeFilterCount}
					</span>
				)}
			</button>
		);
	}

	return (
		<>
			{isMobile && (
				<button
					type="button"
					aria-label="Close filters"
					className="fixed inset-0 z-40 bg-black/40"
					onClick={toggleCollapsed}
					data-testid={`${testIdPrefix}-backdrop`}
				/>
			)}
			<div
				className={cn(
					"bg-card flex flex-col",
					isMobile
						? "fixed inset-y-0 left-0 z-50 h-full w-[min(18rem,88vw)] shadow-xl"
						: "h-full w-64 shrink-0 rounded-r-md",
				)}
				data-testid={`${testIdPrefix}-panel`}
			>
				<div className="flex h-11 items-center justify-between border-b pr-2 pl-5">
					<span className="text-sm font-semibold">{title}</span>
					<div className="flex items-center gap-1">
						{activeFilterCount > 0 && onReset && (
							<Button
								variant="outline"
								size="sm"
								className="text-muted-foreground h-7 px-2 text-xs"
								onClick={onReset}
								data-testid={`${testIdPrefix}-reset-button`}
							>
								<RotateCcw className="size-3" />
								Reset
							</Button>
						)}
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							onClick={toggleCollapsed}
							title="Hide filters"
							aria-label="Hide filters"
							data-testid={`${testIdPrefix}-toggle-hide`}
						>
							<PanelLeftClose className="size-4" />
						</Button>
					</div>
				</div>
				{children}
			</div>
		</>
	);
}
