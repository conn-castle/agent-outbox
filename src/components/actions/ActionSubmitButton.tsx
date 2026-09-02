"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { installImmediateActionFeedback } from "./immediate-action-feedback";

installImmediateActionFeedback();

export function ActionSubmitButton({
  children,
  pendingChildren,
  disabled,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingChildren: ReactNode;
}) {
  const status = useFormStatus();
  const pending = status.pending;
  const pendingLabel =
    typeof pendingChildren === "string" ? pendingChildren : undefined;
  return (
    <button
      {...props}
      type="submit"
      disabled={disabled || pending}
      data-immediate-action-label={pendingLabel}
      // Labeled submit clicks are stopped in capture so React form actions
      // start on the following macrotask; onClick does not run for those clicks.
      onClick={onClick}
    >
      <span data-immediate-action-feedback suppressHydrationWarning>
        {pending ? pendingChildren : children}
      </span>
    </button>
  );
}
