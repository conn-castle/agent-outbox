import type { ReactNode } from "react";

import { HumanIcon } from "./TypedContent";

export type ReviewRowHeadingLink = {
  key: string | number;
  display: string;
  icon: string;
  href: string;
  external?: boolean;
};

export function ReviewRowHeading({
  rowTypeDisplay,
  rowTypeIcon,
  corner,
  contextLinks = [],
  contextAfter,
  utilities,
  slotClassNames
}: {
  rowTypeDisplay: ReactNode;
  rowTypeIcon: string;
  corner?: ReactNode;
  contextLinks?: ReviewRowHeadingLink[];
  contextAfter?: ReactNode;
  utilities?: ReactNode;
  slotClassNames?: Partial<Record<"rowType" | "contextLinks", string>>;
}) {
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
            className={classes("context-links", slotClassNames?.contextLinks)}
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
