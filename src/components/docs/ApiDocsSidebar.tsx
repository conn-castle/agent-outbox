"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { ApiDocSlug } from "../../shared/api-docs-manifest";

export function ApiDocsSidebar({
  slug,
  children
}: {
  slug: ApiDocSlug;
  children: ReactNode;
}) {
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const revealCurrentPage = () => {
      const active = sidebar.querySelector('[aria-current="page"]');
      if (!active || sidebar.scrollWidth <= sidebar.clientWidth) return;
      const activeBounds = active.getBoundingClientRect();
      const sidebarBounds = sidebar.getBoundingClientRect();
      sidebar.scrollLeft +=
        activeBounds.left -
        sidebarBounds.left -
        (sidebar.clientWidth - activeBounds.width) / 2;
    };
    revealCurrentPage();
    const observer = new ResizeObserver(revealCurrentPage);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [slug]);

  return (
    <aside
      ref={sidebarRef}
      className="api-docs-sidebar"
      aria-label="API documentation"
    >
      {children}
    </aside>
  );
}
