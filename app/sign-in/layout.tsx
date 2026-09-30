import type { ReactNode } from "react";

export default function SignInLayout({ children }: { children: ReactNode }) {
  return <div className="ph-no-capture">{children}</div>;
}
