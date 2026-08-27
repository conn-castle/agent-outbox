"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyCommandButton({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
    }
  }

  const label =
    state === "copied" ? "Copied" : state === "failed" ? "Try again" : "Copy";

  return (
    <button
      className="landing-copy-button"
      type="button"
      onClick={copyCommand}
      aria-label={`${label} install commands`}
    >
      {state === "copied" ? (
        <Check aria-hidden="true" />
      ) : (
        <Copy aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
}
