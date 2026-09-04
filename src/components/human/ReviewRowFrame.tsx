import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

export function ReviewRowFrame({
  className,
  style,
  selection,
  heading,
  href,
  ariaLabel,
  title,
  subtitle,
  visual,
  summary,
  details,
  footer,
  actions,
  slotClassNames,
  onNavigate
}: {
  className: string;
  style?: CSSProperties;
  selection?: ReactNode;
  heading: ReactNode;
  href: string;
  ariaLabel: string;
  title: ReactNode;
  subtitle: ReactNode;
  visual?: ReactNode;
  summary: ReactNode;
  details?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  onNavigate?: () => void;
  slotClassNames?: Partial<
    Record<"title" | "visual" | "summary" | "details" | "actions", string>
  >;
}) {
  return (
    <article className={className} style={style}>
      {selection}
      <div className="row-body">
        <div className="row-heading">{heading}</div>
        <div className="row-copy">
          <div className="row-primary">
            <Link
              className={classes("row-link", slotClassNames?.title)}
              href={href}
              aria-label={ariaLabel}
              onNavigate={onNavigate}
            >
              <span className="row-link-heading">{title}</span>
              {subtitle}
            </Link>
            <div className="row-side">
              {visual ? (
                <aside
                  className={classes("row-context", slotClassNames?.visual)}
                  aria-label="Card visual"
                >
                  {visual}
                </aside>
              ) : null}
              <Link
                className={classes("row-details-link", slotClassNames?.details)}
                href={href}
                aria-label={ariaLabel}
                onNavigate={onNavigate}
              >
                <span>{details ?? "Details"}</span>
                <ChevronRight />
              </Link>
            </div>
          </div>
          <div className="row-summary-link">
            <div
              className={classes(
                "row-summary-content",
                slotClassNames?.summary
              )}
            >
              {summary}
            </div>
          </div>
          {footer ? <div className="row-footer">{footer}</div> : null}
        </div>
      </div>
      <div
        className={classes("row-actions action-rail", slotClassNames?.actions)}
      >
        {actions}
      </div>
    </article>
  );
}

function classes(base: string, extra: string | undefined) {
  return extra ? `${base} ${extra}` : base;
}
