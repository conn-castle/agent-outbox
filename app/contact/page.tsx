import { redirect } from "next/navigation";

const issuesUrl = "https://github.com/conn-castle/agent-outbox/issues";

export default function ContactPage() {
  redirect(issuesUrl);
}
