"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { HumanIcon } from "./TypedContent";

export type ReviewRowHeadingLink = {
  key: string | number;
  display: string;
  icon: string;
  href: string;
  external?: boolean;
};

export type ReviewRowHeadingProps = {
  rowTypeDisplay: ReactNode;
  rowTypeIcon: string;
  corner?: ReactNode;
  contextLinks?: ReviewRowHeadingLink[];
  contextAfter?: ReactNode;
  utilities?: ReactNode;
  slotClassNames?: Partial<Record<"rowType" | "contextLinks", string>>;
};

const EMPTY_CONTEXT_LINKS: ReviewRowHeadingLink[] = [];

export function ReviewRowHeading({
  rowTypeDisplay,
  rowTypeIcon,
  corner,
  contextLinks = EMPTY_CONTEXT_LINKS,
  contextAfter,
  utilities,
  slotClassNames
}: ReviewRowHeadingProps) {
  const linksRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState({
    overflow: false,
    left: false,
    right: false
  });
  useEffect(() => {
    const links = linksRef.current;
    if (!links) return;
    function update() {
      if (!links) return;
      const overflow = links.scrollWidth > links.clientWidth + 1;
      const left = links.scrollLeft > 1;
      const right =
        links.scrollLeft + links.clientWidth < links.scrollWidth - 1;
      setScroll((current) =>
        current.overflow === overflow &&
        current.left === left &&
        current.right === right
          ? current
          : { overflow, left, right }
      );
    }
    const observer = new ResizeObserver(update);
    observer.observe(links);
    for (const child of links.children) observer.observe(child);
    links.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      links.removeEventListener("scroll", update);
    };
  }, [contextLinks]);

  return (
    <>
      <span className={classes("row-type", slotClassNames?.rowType)}>
        <span className="row-type-icon">
          <HumanIcon name={rowTypeIcon} />
        </span>
        {rowTypeDisplay}
      </span>
      <span className="row-heading-context">
        {corner}
        {contextLinks.length > 0 ? (
          <span
            className="context-links-scroller"
            data-scroll-left={scroll.left || undefined}
            data-scroll-right={scroll.right || undefined}
          >
            <span
              ref={linksRef}
              className={classes("context-links", slotClassNames?.contextLinks)}
              tabIndex={scroll.overflow ? 0 : undefined}
              role="group"
              aria-label="Context links"
            >
              {contextLinks.map((link) => (
                <a
                  key={link.key}
                  href={link.href}
                  target={link.external ? "_blank" : undefined}
                  rel={link.external ? "noreferrer" : undefined}
                >
                  <HumanIcon name={link.icon} />
                  <span>{link.display}</span>
                </a>
              ))}
            </span>
          </span>
        ) : null}
        {contextAfter}
      </span>
      {utilities ? <div className="row-utilities">{utilities}</div> : null}
    </>
  );
}

function classes(base: string, extra: string | undefined) {
  return extra ? `${base} ${extra}` : base;
}
