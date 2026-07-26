import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scrollArea";
import { Skeleton } from "@/components/ui/skeleton";
import { TruncatedLabel } from "@/components/ui/truncatedLabel";
import { FilterSidebarChrome, useFilterSidebarCollapsed } from "@/components/filters/filterSidebarChrome";
import { Statuses } from "@/lib/constants/logs";
import { useGetMCPLogsFilterDataQuery } from "@/lib/store";
import type { MCPToolLogFilters } from "@/lib/types/logs";
import { cn } from "@/lib/utils";
import { ChevronDown, LoaderCircle, Plus, RotateCcw, Search } from "lucide-react";
import { Ref, useCallback, useEffect, useMemo, useRef, useState } from "react";

const COLLAPSE_STORAGE_KEY = "mcp-filter-sidebar-collapsed";

// ---------------------------------------------------------------------------
// MCPFilterSidebar – orchestrator
// ---------------------------------------------------------------------------

interface MCPFilterSidebarProps {
	filters: MCPToolLogFilters;
	onFiltersChange: (filters: MCPToolLogFilters) => void;
}

export function MCPFilterSidebar({ filters, onFiltersChange }: MCPFilterSidebarProps) {
	const { collapsed, toggleCollapsed, isMobile } = useFilterSidebarCollapsed(COLLAPSE_STORAGE_KEY);

	const activeFilterCount = useMemo(() => {
		const excludedKeys = ["start_time", "end_time", "content_search", "period", "polling"];
		let count = Object.entries(filters).reduce((c, [key, value]) => {
			if (excludedKeys.includes(key)) return c;
			if (Array.isArray(value)) return c + value.length;
			return c + (value ? 1 : 0);
		}, 0);
		return count;
	}, [filters]);

	const handleReset = useCallback(() => {
		onFiltersChange({
			start_time: filters.start_time,
			end_time: filters.end_time,
		});
	}, [filters.start_time, filters.end_time, onFiltersChange]);

	return (
		<FilterSidebarChrome
			collapsed={collapsed}
			toggleCollapsed={toggleCollapsed}
			isMobile={isMobile}
			activeFilterCount={activeFilterCount}
			onReset={handleReset}
			testIdPrefix="mcpFilterSidebar"
		>
			{/* Scrollable filter sections */}
			<ScrollArea className="flex flex-1 overflow-y-auto p-2 pb-0" viewportClassName="no-table">
				<div className="flex grow flex-col gap-1">
					{/* First 2 open by default */}
					<StatusFilter filters={filters} onFiltersChange={onFiltersChange} defaultOpen />
					<ToolNamesFilter filters={filters} onFiltersChange={onFiltersChange} defaultOpen />
					{/* Rest closed unless they have active filters */}
					<ServersFilter filters={filters} onFiltersChange={onFiltersChange} />
					<VirtualKeysFilter filters={filters} onFiltersChange={onFiltersChange} />
				</div>
			</ScrollArea>
		</FilterSidebarChrome>
	);
}

// ---------------------------------------------------------------------------
// Shared helpers & primitives
// ---------------------------------------------------------------------------

interface FilterComponentProps {
	filters: MCPToolLogFilters;
	onFiltersChange: (filters: MCPToolLogFilters) => void;
	defaultOpen?: boolean;
}

// ---------------------------------------------------------------------------
// FilterSection – collapsible wrapper
// ---------------------------------------------------------------------------

function FilterSectionSkeleton({ rows = 3 }: { rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }).map((_, i) => (
				<div key={i} className="flex items-center gap-2.5 px-3 py-2">
					<Skeleton className="size-4 shrink-0 rounded-[4px]" />
					<Skeleton className="h-3.5 w-full rounded" />
				</div>
			))}
		</>
	);
}

function FilterSection({
	title,
	children,
	defaultOpen = false,
	loading = false,
	onOpenChange,
}: {
	title: string;
	children: React.ReactNode;
	defaultOpen?: boolean;
	loading?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(defaultOpen);

	useEffect(() => {
		if (defaultOpen) setOpen(true);
	}, [defaultOpen]);

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		onOpenChange?.(next);
	};

	return (
		<Collapsible open={open} onOpenChange={handleOpenChange} className="last:pb-2">
			<CollapsibleTrigger className="flex h-8 w-full cursor-pointer items-center gap-1.5 px-2 py-2 text-sm font-medium hover:opacity-80">
				<ChevronDown className={cn("size-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")} />
				<span>{title}</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-1">
				<div className="divide-border divide-y overflow-hidden rounded-sm border">{loading ? <FilterSectionSkeleton /> : children}</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

// ---------------------------------------------------------------------------
// CheckboxFilterItem
// ---------------------------------------------------------------------------

function CheckboxFilterItem({
	label,
	checked,
	onCheckedChange,
	labelClassName,
}: {
	label: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	labelClassName?: string;
}) {
	return (
		<label className="hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm">
			<Checkbox checked={checked} onCheckedChange={onCheckedChange} />
			<TruncatedLabel className={labelClassName}>{label}</TruncatedLabel>
		</label>
	);
}

// ---------------------------------------------------------------------------
// SearchableCheckboxList – list of checkbox rows with a search input.
// Caller passes `inputRef` to control focus (see `useAutoFocusOnOpen`).
// ---------------------------------------------------------------------------

function useAutoFocusOnOpen(isOpen: boolean) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (isOpen) ref.current?.focus({ preventScroll: true });
	}, [isOpen]);
	return ref;
}

function SearchableCheckboxList({
	items,
	isSelected,
	onToggle,
	placeholder = "Search...",
	inputRef,
	allowCustom = false,
	onSearch,
	fetching,
}: {
	items: { key: string; label: string }[];
	isSelected: (key: string) => boolean;
	onToggle: (key: string) => void;
	placeholder?: string;
	inputRef?: Ref<HTMLInputElement>;
	allowCustom?: boolean;
	onSearch?: (query: string) => void;
	fetching?: boolean;
}) {
	const [query, setQuery] = useState("");
	const normalized = query.trim().toLowerCase();
	const filtered = normalized ? items.filter((item) => item.label.toLowerCase().includes(normalized)) : items;
	const trimmed = query.trim();
	const hasExactMatch = trimmed !== "" && items.some((item) => item.label.toLowerCase() === trimmed.toLowerCase());
	const showAddCustom = allowCustom && trimmed !== "" && !hasExactMatch;

	useEffect(() => {
		if (!onSearch) return;
		const timer = setTimeout(() => {
			onSearch(query.trim());
		}, 300);
		return () => clearTimeout(timer);
	}, [query, onSearch]);

	const commitCustom = () => {
		if (!showAddCustom) return;
		onToggle(trimmed);
		setQuery("");
	};

	return (
		<>
			<div className="relative border-b">
				{fetching ? (
					<LoaderCircle className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 animate-spin" />
				) : (
					<Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
				)}
				<Input
					ref={inputRef}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitCustom();
						}
					}}
					placeholder={placeholder}
					className="h-8 border-0 pl-8 text-xs"
				/>
			</div>
			{filtered.map((item) => (
				<CheckboxFilterItem key={item.key} label={item.label} checked={isSelected(item.key)} onCheckedChange={() => onToggle(item.key)} />
			))}
			{filtered.length === 0 && !showAddCustom && (
				<div className="text-muted-foreground flex h-9 items-center px-3 text-xs">No results</div>
			)}
			{showAddCustom && (
				<button
					type="button"
					onClick={commitCustom}
					className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm"
				>
					<Plus className="text-muted-foreground size-3.5 shrink-0" />
					<span className="truncate">
						Use <span className="font-medium">&quot;{trimmed}&quot;</span>
					</span>
				</button>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// StatusFilter
// ---------------------------------------------------------------------------

function StatusFilter({ filters, onFiltersChange, defaultOpen }: FilterComponentProps) {
	const hasActive = (filters.status || []).length > 0;

	return (
		<FilterSection title="Status" defaultOpen={defaultOpen || hasActive}>
			{Statuses.map((status) => (
				<CheckboxFilterItem
					key={status}
					labelClassName="capitalize"
					label={status}
					checked={(filters.status || []).includes(status)}
					onCheckedChange={() => {
						const current = filters.status || [];
						const next = current.includes(status) ? current.filter((s) => s !== status) : [...current, status];
						onFiltersChange({ ...filters, status: next });
					}}
				/>
			))}
		</FilterSection>
	);
}

// ---------------------------------------------------------------------------
// ToolNamesFilter – fetches tool names; skips while closed & inactive
// ---------------------------------------------------------------------------

function ToolNamesFilter({ filters, onFiltersChange, defaultOpen }: FilterComponentProps) {
	const hasActive = (filters.tool_names || []).length > 0;
	const [opened, setOpened] = useState(defaultOpen || hasActive);
	const searchInputRef = useAutoFocusOnOpen(opened);
	const [searchQuery, setSearchQuery] = useState("");
	const {
		data: filterData,
		isUninitialized,
		isLoading,
		isFetching,
	} = useGetMCPLogsFilterDataQuery({ dimensions: ["tool_names"], q: searchQuery || undefined }, { skip: !opened && !hasActive });
	const availableToolNames = filterData?.tool_names || [];
	const items = useMemo(() => {
		const seen = new Set(availableToolNames);
		const extras = (filters.tool_names || []).filter((n) => !seen.has(n));
		return [...availableToolNames, ...extras].map((n) => ({ key: n, label: n }));
	}, [availableToolNames, filters.tool_names]);

	if (!isUninitialized && !isLoading && availableToolNames.length === 0 && !hasActive && !opened) return null;

	return (
		<FilterSection title="Tool Names" defaultOpen={defaultOpen || hasActive} loading={isLoading} onOpenChange={setOpened}>
			<SearchableCheckboxList
				inputRef={searchInputRef}
				placeholder="Search or add a tool"
				items={items}
				allowCustom
				isSelected={(name) => (filters.tool_names || []).includes(name)}
				onToggle={(name) => {
					const current = filters.tool_names || [];
					const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
					onFiltersChange({ ...filters, tool_names: next });
				}}
				onSearch={setSearchQuery}
				fetching={isFetching}
			/>
		</FilterSection>
	);
}

// ---------------------------------------------------------------------------
// ServersFilter – fetches server labels; skips while closed & inactive
// ---------------------------------------------------------------------------

function ServersFilter({ filters, onFiltersChange, defaultOpen }: FilterComponentProps) {
	const hasActive = (filters.server_labels || []).length > 0;
	const [opened, setOpened] = useState(defaultOpen || hasActive);
	const searchInputRef = useAutoFocusOnOpen(opened);
	const [searchQuery, setSearchQuery] = useState("");
	const {
		data: filterData,
		isUninitialized,
		isLoading,
		isFetching,
	} = useGetMCPLogsFilterDataQuery({ dimensions: ["server_labels"], q: searchQuery || undefined }, { skip: !opened && !hasActive });
	const availableServerLabels = filterData?.server_labels || [];
	const items = useMemo(() => {
		const seen = new Set(availableServerLabels);
		const extras = (filters.server_labels || []).filter((l) => !seen.has(l));
		return [...availableServerLabels, ...extras].map((l) => ({ key: l, label: l }));
	}, [availableServerLabels, filters.server_labels]);

	if (!isUninitialized && !isLoading && availableServerLabels.length === 0 && !hasActive && !opened) return null;

	return (
		<FilterSection title="Servers" defaultOpen={defaultOpen || hasActive} loading={isLoading} onOpenChange={setOpened}>
			<SearchableCheckboxList
				inputRef={searchInputRef}
				placeholder="Search or add a server"
				items={items}
				allowCustom
				isSelected={(label) => (filters.server_labels || []).includes(label)}
				onToggle={(label) => {
					const current = filters.server_labels || [];
					const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
					onFiltersChange({ ...filters, server_labels: next });
				}}
				onSearch={setSearchQuery}
				fetching={isFetching}
			/>
		</FilterSection>
	);
}

// ---------------------------------------------------------------------------
// VirtualKeysFilter – fetches virtual keys; maps name→ID
// ---------------------------------------------------------------------------

function VirtualKeysFilter({ filters, onFiltersChange, defaultOpen }: FilterComponentProps) {
	const hasActive = (filters.virtual_key_ids || []).length > 0;
	const [opened, setOpened] = useState(defaultOpen || hasActive);
	const searchInputRef = useAutoFocusOnOpen(opened);
	const [searchQuery, setSearchQuery] = useState("");
	const {
		data: filterData,
		isUninitialized,
		isLoading,
		isFetching,
	} = useGetMCPLogsFilterDataQuery({ dimensions: ["virtual_keys"], q: searchQuery || undefined }, { skip: !opened && !hasActive });
	const availableVirtualKeys = filterData?.virtual_keys || [];
	const nameToId = useMemo(() => new Map(availableVirtualKeys.map((key) => [key.name, key.id])), [availableVirtualKeys]);

	if (!isUninitialized && !isLoading && availableVirtualKeys.length === 0 && !hasActive && !opened) return null;

	const isSelected = (name: string) => {
		const id = nameToId.get(name) || name;
		return (filters.virtual_key_ids || []).includes(id);
	};

	const toggle = (name: string) => {
		const id = nameToId.get(name) || name;
		const current = filters.virtual_key_ids || [];
		const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
		onFiltersChange({ ...filters, virtual_key_ids: next });
	};

	return (
		<FilterSection title="Virtual Keys" defaultOpen={defaultOpen || hasActive} loading={isLoading} onOpenChange={setOpened}>
			<SearchableCheckboxList
				inputRef={searchInputRef}
				placeholder="Search virtual keys"
				items={availableVirtualKeys.map((key) => ({ key: key.name, label: key.name }))}
				isSelected={isSelected}
				onToggle={toggle}
				onSearch={setSearchQuery}
				fetching={isFetching}
			/>
		</FilterSection>
	);
}