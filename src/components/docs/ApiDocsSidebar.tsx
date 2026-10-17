"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ApiDocSlug } from "../../shared/api-docs-manifest";

export function ApiDocsSidebar({
  slug,
  children
}: {
  slug: ApiDocSlug;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const updateEdges = () => {
      const left = viewport.scrollLeft > 1;
      const right =
        viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1;
      setEdges((previous) =>
        previous.left === left && previous.right === right
          ? previous
          : { left, right }
      );
    };
    const revealCurrentPage = () => {
      const active = viewport.querySelector('[aria-current="page"]');
      if (active && viewport.scrollWidth > viewport.clientWidth) {
        const activeBounds = active.getBoundingClientRect();
        const viewportBounds = viewport.getBoundingClientRect();
        viewport.scrollLeft +=
          activeBounds.left -
          viewportBounds.left -
          (viewport.clientWidth - activeBounds.width) / 2;
      }
      updateEdges();
    };
    revealCurrentPage();
    const observer = new ResizeObserver(revealCurrentPage);
    observer.observe(viewport);
    viewport.addEventListener("scroll", updateEdges, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", updateEdges);
    };
  }, [slug]);

  function scrollSections(direction: number) {
    const viewport = scrollRef.current;
    if (viewport)
      viewport.scrollBy({
        left: direction * viewport.clientWidth
      });
  }

  return (
    <aside className="api-docs-sidebar" aria-label="API documentation">
      <button
        type="button"
        className="api-docs-scroll-button"
        aria-label="Previous documentation sections"
        disabled={!edges.left}
        onClick={() => scrollSections(-1)}
      >
        <ChevronLeft aria-hidden="true" size={18} />
      </button>
      <div className="api-docs-sidebar-scroll" ref={scrollRef}>
        {children}
      </div>
      <button
        type="button"
        className="api-docs-scroll-button"
        aria-label="Next documentation sections"
        disabled={!edges.right}
        onClick={() => scrollSections(1)}
      >
        <ChevronRight aria-hidden="true" size={18} />
      </button>
    </aside>
  );
}
