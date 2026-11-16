import type { ReactNode } from "react";

import AuthPageProvider from "../../src/components/auth/AuthPageProvider";

export default function SignUpLayout({ children }: { children: ReactNode }) {
  return (
    <AuthPageProvider>
      <div className="ph-no-capture">{children}</div>
    </AuthPageProvider>
  );
}
