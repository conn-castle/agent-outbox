"use client";

import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function ActionSubmitButton({
  children,
  pendingChildren,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingChildren: ReactNode;
}) {
  const status = useFormStatus();
  return (
    <button {...props} type="submit" disabled={disabled || status.pending}>
      {status.pending ? pendingChildren : children}
    </button>
  );
}
