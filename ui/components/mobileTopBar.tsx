import { ThemeToggle } from "@/components/themeToggle";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Link } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/**
 * Sticky top bar shown only on mobile (< md).
 * Provides hamburger to open the existing mobile sidebar Sheet.
 */
export default function MobileTopBar() {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const logoSrc = mounted && resolvedTheme === "dark" ? "/bifrost-logo-dark.webp" : "/bifrost-logo.webp";

	return (
		<header
			className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-30 flex items-center justify-between gap-2 border-b px-2 py-2 backdrop-blur md:hidden"
			data-testid="mobile-top-bar"
		>
			<div className="flex min-w-0 items-center gap-1">
				<SidebarTrigger className="size-9 shrink-0" aria-label="打开菜单" />
				<Link to="/workspace/dashboard" className="flex min-w-0 items-center gap-2 pl-1">
					<img className="h-5 w-auto" src={logoSrc} alt="Bifrost" />
				</Link>
			</div>
			<div className="pr-1">
				<ThemeToggle />
			</div>
		</header>
	);
}
