"use client";

import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { flushSync, useFormStatus } from "react-dom";

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
  const [optimisticPending, setOptimisticPending] = useState(false);

  useEffect(() => {
    if (status.pending) {
      setOptimisticPending(false);
    }
  }, [status.pending]);

  const pending = status.pending || optimisticPending;
  return (
    <button
      {...props}
      type="submit"
      disabled={disabled || status.pending}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || disabled) return;
        const form = event.currentTarget.form;
        if (form && !form.checkValidity()) return;
        flushSync(() => setOptimisticPending(true));
      }}
    >
      {pending ? pendingChildren : children}
    </button>
  );
}
