import type { ReactNode } from "react";

export default function SignUpLayout({ children }: { children: ReactNode }) {
  return <div className="ph-no-capture">{children}</div>;
}
