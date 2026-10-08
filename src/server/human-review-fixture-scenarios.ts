import { createHash } from "node:crypto";

import type { HumanReviewDetail } from "./human-review.ts";
import { detailFromNormalizedSubmission } from "./human-review-design-fixture.ts";
import { parseInputSubmission } from "./input-schema.ts";

const fixtureCallerId = "00000000-0000-4000-8000-000000000503";

/**
 * Derive a stable fixture UUID from a seed using SHA-256.
 */
export function fixtureUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Core fixtures are authored as caller input plus the stored-record fields that
// input cannot express; parseInputSubmission derives everything else.
type CoreFixture = Record<string, unknown> &
  Pick<
    HumanReviewDetail,
    | "inputItemId"
    | "status"
    | "currentRevision"
    | "createdAt"
    | "updatedAt"
    | "answeredAt"
    | "caller"
    | "output"
  > & { unanswerableActions?: readonly string[] };

/**
 * Build the ten core browser review scenarios from caller input and stored metadata.
 */
export function browserFixtureCoreReviewDetails(): HumanReviewDetail[] {
  const fixtures: CoreFixture[] = [
    {
      inputItemId: "00000000-0000-4000-8000-000000000511",
      caller_item_id: "steward-brief-101",
      status: "pending",
      priority: "urgent",
      currentRevision: 3,
      row_type: { display: "Steward Brief", icon: "message-square" },
      row_accent_color: "teal",
      title: "<strong>Review neighborhood permit brief</strong>",
      subtitle: "A resident-facing summary needs a final human check.",
      corner: "Rev 3",
      card_time: "2026-07-01T12:34:56.123Z",
      summary:
        "<p><strong>Send:</strong> “Your permit is ready for final review. The remaining neighborhood notice period ends July 8.”</p>",
      details:
        "<p>The system drafted a short permit explanation from structured notes. Verify the recommendation, edit only if the popup asks for it, and keep the response generic.</p><ul><li>No source-system action is performed here.</li><li>The caller receives only the selected answer value.</li></ul>",
      card_visual: {
        kind: "numeric_bar",
        label: "Confidence",
        value: 82,
        display: "82%",
        unit: "%",
        min_value: 0,
        max_value: 100
      },
      skip_disabled: false,
      createdAt: "2026-07-01T13:00:00.000Z",
      updatedAt: "2026-07-01T13:20:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      link_buttons: [
        {
          display: "Open context",
          icon: "external-link",
          url: "https://example.com/context/steward-brief-101"
        }
      ],
      actions: [
        {
          display: "Approve permit brief",
          icon: "check",
          value: "approve",
          overflow: false,
          tone: "success",
          style: "solid",
          popup: { kind: "none" }
        },
        {
          display: "Request edit",
          icon: "send",
          value: "request_edit",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popup: {
            kind: "free_text",
            label: "Requested change",
            placeholder: "Name the one change needed before handoff.",
            default_value: "Change: ",
            multiline: true,
            min_length: 10,
            max_length: 240
          }
        },
        {
          display: "Attach evidence",
          icon: "upload",
          value: "attach_evidence",
          overflow: true,
          tone: "brand",
          style: "outline",
          popup: {
            kind: "file_upload",
            label: "Evidence file",
            accept_mime_types: ["application/pdf", "text/plain"]
          }
        },
        {
          display: "Set review lane",
          icon: "chevron-down",
          value: "set_lane",
          overflow: true,
          popup: {
            kind: "single_select",
            label: "Review lane",
            options: [
              {
                display: "Policy",
                value: "policy",
                icon: "file"
              },
              {
                display: "Operations",
                value: "operations",
                icon: "inbox"
              }
            ]
          }
        },
        {
          display: "Add handoff note",
          icon: "message-square",
          value: "add_handoff_note",
          overflow: true,
          popup: {
            kind: "free_text",
            label: "Handoff note",
            placeholder: "One line for the next steward.",
            default_value:
              "Confirm the July 8 notice end date with the resident before handoff.",
            multiline: false,
            min_length: null,
            max_length: 40
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000512",
      caller_item_id: "steward-check-202",
      status: "pending",
      priority: "high",
      currentRevision: 1,
      row_type: { display: "Decision Check", icon: "calendar" },
      row_accent_color: "orange",
      title: "Choose follow-up window",
      subtitle: "The caller needs a review date before continuing.",
      corner: "Scheduling task",
      card_time: "2026-07-01T12:00:00.000Z",
      summary:
        "<p><strong>Proposed follow-up:</strong> Wednesday, July 8 · 2:00–4:00 PM UTC.</p>",
      details:
        "<p>The date picker metadata is displayed here for human review.</p>",
      card_visual: {
        kind: "progress_ring",
        label: "Readiness",
        value: 6,
        display: "6 of 10",
        unit: "checks",
        min_value: 0,
        max_value: 10,
        color: null
      },
      skip_disabled: true,
      createdAt: "2026-07-01T12:10:00.000Z",
      updatedAt: "2026-07-01T12:55:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      link_buttons: [],
      actions: [
        {
          display: "Approve follow-up",
          icon: "check",
          value: "approve",
          overflow: false,
          tone: "success",
          style: "solid",
          popup: { kind: "none" }
        },
        {
          display: "Pick date",
          icon: "calendar",
          value: "pick_date",
          overflow: false,
          tone: "brand",
          style: "outline",
          popup: {
            kind: "date_picker",
            label: "Follow-up date",
            mode: "date",
            placeholder: "YYYY-MM-DD",
            display_timezone: null,
            min_value: "2026-07-01",
            max_value: "2026-07-31"
          }
        },
        {
          display: "Pick zoned date",
          icon: "calendar",
          value: "pick_zoned_date",
          overflow: false,
          tone: "brand",
          style: "outline",
          popup: {
            kind: "date_picker",
            label: "Zoned follow-up date",
            mode: "date",
            placeholder: "YYYY-MM-DD",
            display_timezone: "America/New_York",
            min_value: "2026-07-01",
            max_value: "2026-07-31"
          }
        },
        {
          display: "Pick date and time",
          icon: "clock",
          value: "pick_datetime",
          overflow: false,
          tone: "brand",
          style: "outline",
          popup: {
            kind: "date_picker",
            label: "Follow-up instant",
            mode: "datetime",
            placeholder: "UTC datetime",
            display_timezone: "UTC",
            min_value: "2026-07-01T00:00:00.000Z",
            max_value: "2026-07-31T23:59:59.000Z"
          }
        },
        {
          display: "Select checks",
          icon: "check",
          value: "select_checks",
          overflow: true,
          popup: {
            kind: "multi_select",
            label: "Completed checks",
            min_selected: 1,
            max_selected: 2,
            options: [
              {
                display: "Facts reviewed",
                value: "facts_reviewed",
                icon: "check"
              },
              {
                display: "Tone reviewed",
                value: "tone_reviewed",
                icon: "check"
              },
              {
                display: "Sources reviewed",
                value: "sources_reviewed",
                icon: "check"
              }
            ]
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000516",
      caller_item_id: "email:draft:meridian-renewal",
      status: "pending",
      priority: "urgent",
      currentRevision: 4,
      row_type: { display: "Email Draft", icon: "mail" },
      row_accent_color: "orange",
      title: "<strong>Reply to Meridian about the renewal delay</strong>",
      subtitle:
        "Exact outbound copy prepared from the contract thread and latest delivery note.",
      corner: "Rev 4",
      card_time: null,
      summary:
        "<p><strong>Send:</strong> “Hi Ana — we can hold your current pricing through September 30. The revised implementation plan is attached, and the only date that moved is the data-import rehearsal.”</p>",
      details:
        "<p>The agent reconciled the requested extension against the signed renewal terms. This message makes a commercial commitment and will be sent to three external recipients.</p><table><tbody><tr><th>To</th><td>Ana Ruiz, Marcus Bell</td></tr><tr><th>Cc</th><td>accounting@northstar.example</td></tr><tr><th>Subject</th><td>Meridian renewal timeline</td></tr></tbody></table>",
      card_visual: {
        kind: "pill",
        text: "External · 3",
        icon: "send",
        color: "orange"
      },
      skip_disabled: false,
      createdAt: "2026-08-14T13:49:00.000Z",
      updatedAt: "2026-08-14T14:07:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Steward Email", "steward-email"),
      output: null,
      link_buttons: [
        {
          display: "Open source thread",
          icon: "external-link",
          url: "https://mail.example.com/thread/meridian-renewal"
        },
        {
          display: "Download revised plan",
          icon: "download",
          url: "https://files.example.com/meridian-plan.pdf"
        }
      ],
      actions: [
        {
          display: "Approve to send",
          icon: "send",
          value: "approve_draft",
          overflow: false,
          tone: "success",
          style: "solid",
          popup: { kind: "none" }
        },
        {
          display: "Request revision",
          icon: "file",
          value: "request_revision",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popup: {
            kind: "free_text",
            label: "What should change?",
            placeholder: "Be specific; the agent will return a revised draft.",
            default_value: "Keep the message concise, but ",
            multiline: true,
            min_length: 4,
            max_length: 500
          }
        },
        {
          display: "Block send",
          icon: "x",
          value: "reject_send",
          overflow: false,
          tone: "danger",
          style: "outline",
          popup: { kind: "none" }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000517",
      caller_item_id: "email:triage:github-security-digest",
      status: "answered",
      priority: "normal",
      currentRevision: 1,
      row_type: { display: "Email Triage", icon: "archive" },
      row_accent_color: "green",
      title:
        '<a href="https://example.com/digest">GitHub security digest for archived repositories</a>',
      subtitle: "GitHub &lt;noreply@github.com&gt; · received 18 minutes ago",
      corner: "Inbox label",
      card_time: null,
      summary:
        "<p><strong>Recommendation: Archive.</strong> Automated digest; all 14 alerts concern repositories already marked read-only. Nine similar messages were archived.</p>",
      details:
        "<p>The agent found no direct mention, billing change, or active production repository. Related labeled examples: 9 Archive, 0 Agent.</p>",
      card_visual: {
        kind: "numeric_bar",
        label: "Archive confidence",
        value: 96,
        display: "96",
        unit: "%",
        min_value: 0,
        max_value: 100
      },
      skip_disabled: false,
      createdAt: "2026-08-14T13:47:00.000Z",
      updatedAt: "2026-08-14T13:55:00.000Z",
      answeredAt: "2026-08-14T13:57:00.000Z",
      caller: fixtureCaller("Steward Email", "steward-email"),
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000597",
        actionValue: "archive",
        actionDisplay: "Archive",
        answeredAt: "2026-08-14T13:57:00.000Z",
        firstReadAt: null,
        readCount: 0,
        undoEligible: true
      },
      link_buttons: [
        {
          display: "Open in mail",
          icon: "external-link",
          url: "https://mail.example.com/thread/github-security-digest"
        }
      ],
      actions: [
        {
          display: "Archive",
          icon: "archive",
          value: "archive",
          overflow: false,
          popup: { kind: "none" }
        },
        {
          display: "Agent",
          icon: "inbox",
          value: "agent",
          overflow: false,
          popup: { kind: "none" }
        },
        {
          display: "Agent, resolved",
          icon: "check",
          value: "agent_resolved",
          overflow: true,
          popup: { kind: "none" }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000518",
      caller_item_id: "linkedin:connection:maya-chen",
      status: "pending",
      priority: "normal",
      currentRevision: 1,
      row_type: { display: "LinkedIn Request", icon: "user-plus" },
      row_accent_color: "blue",
      title: "Maya Chen wants to connect",
      subtitle: "Staff engineer · Retrieval systems",
      corner: "Profile context",
      card_time: null,
      summary:
        "<p><strong>Recommendation: Accept.</strong> Maya referenced your agent-harness benchmark and works on evaluation infrastructure at Fieldstone AI.</p>",
      details:
        "<blockquote>Enjoyed your breakdown of harness overhead. We are seeing the same context-replay problem in internal evals and would love to compare notes.</blockquote><p>No prior messages. Profile created in 2016 with consistent engineering history.</p>",
      card_visual: {
        kind: "pill",
        text: "6 mutual",
        icon: null,
        color: "blue"
      },
      skip_disabled: false,
      createdAt: "2026-08-14T11:20:00.000Z",
      updatedAt: "2026-08-14T12:02:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("LinkedIn Steward", "linkedin-steward"),
      output: null,
      link_buttons: [
        {
          display: "View profile",
          icon: "external-link",
          url: "https://linkedin.example.com/in/maya-chen"
        }
      ],
      actions: [
        {
          display: "Accept",
          icon: "check",
          value: "accept",
          overflow: false,
          popup: { kind: "none" }
        },
        {
          display: "Ignore",
          icon: "x",
          value: "ignore",
          overflow: false,
          popup: { kind: "none" }
        },
        {
          display: "Accept with note",
          icon: "send",
          value: "accept_with_note",
          overflow: true,
          popup: {
            kind: "free_text",
            label: "Connection note",
            placeholder: "Write a short note",
            default_value: "Thanks, Maya — ",
            multiline: false,
            min_length: 2,
            max_length: 280
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000519",
      caller_item_id: "x:post:agent-instruction-ablation",
      status: "pending",
      priority: "high",
      currentRevision: 3,
      row_type: { display: "X Post Draft", icon: "at-sign" },
      row_accent_color: "purple",
      title: "Publish the instruction-ablation result",
      subtitle: "Exact public copy · 252 of 280 characters",
      corner: "Rev 3",
      card_time: null,
      summary:
        "<p><strong>Post:</strong> “Removing one instruction cut cost 36.5% without reducing score. Agent instructions are production code: measure them, diff them, and keep humans in the loop.”</p>",
      details:
        "<p>All figures match the locked benchmark note. No customer names or unreleased repository details are included.</p>",
      card_visual: {
        kind: "progress_ring",
        label: "Character use",
        value: 252,
        display: "252 / 280",
        unit: null,
        min_value: 0,
        max_value: 280,
        color: "orange"
      },
      skip_disabled: true,
      createdAt: "2026-08-14T12:24:00.000Z",
      updatedAt: "2026-08-14T13:58:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("X Publishing", "x-publishing"),
      output: null,
      link_buttons: [
        {
          display: "Open source note",
          icon: "file",
          url: "https://docs.example.com/ablation-note"
        }
      ],
      actions: [
        {
          display: "Approve post",
          icon: "send",
          value: "approve_post",
          overflow: false,
          tone: "success",
          style: "solid",
          popup: { kind: "none" }
        },
        {
          display: "Revise copy",
          icon: "file",
          value: "revise_copy",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popup: {
            kind: "free_text",
            label: "Revision direction",
            placeholder: "Call out the exact sentence or claim to change.",
            default_value: null,
            multiline: true,
            min_length: 3,
            max_length: 400
          }
        },
        {
          display: "Decline post",
          icon: "x",
          value: "decline_post",
          overflow: false,
          tone: "danger",
          style: "outline",
          popup: { kind: "none" }
        },
        {
          display: "Delete draft",
          icon: "trash",
          value: "delete_draft",
          overflow: true,
          popup: {
            kind: "single_select",
            label: "Confirm draft deletion",
            options: [
              {
                display: "Delete this draft",
                value: "confirm_delete",
                icon: "trash"
              }
            ]
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000521",
      caller_item_id: "monarch:transaction:cloudflare-2026-08",
      status: "pending",
      priority: "high",
      currentRevision: 2,
      row_type: { display: "Transaction Review", icon: "credit-card" },
      row_accent_color: "orange",
      title: "Categorize Cloudflare · $240.00",
      subtitle: "Business card •• 1842 · posted August 13",
      corner: "Anomaly signal",
      card_time: null,
      summary:
        "<p><strong>Suggested category:</strong> Software &amp; cloud services. The amount is 3× higher than the trailing monthly median.</p>",
      details:
        "<p>The increase matches the annual domain-renewal month, but the merchant descriptor does not separate domains from compute usage.</p>",
      card_visual: {
        kind: "numeric_bar",
        label: "Category confidence",
        value: 34,
        display: "34",
        unit: "%",
        min_value: 0,
        max_value: 100
      },
      skip_disabled: false,
      createdAt: "2026-08-14T10:55:00.000Z",
      updatedAt: "2026-08-14T11:42:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Monarch Review", "monarch-review"),
      output: null,
      link_buttons: [
        {
          display: "Open transaction",
          icon: "external-link",
          url: "https://finance.example.com/transactions/cloudflare-2026-08"
        },
        {
          display: "View receipt",
          icon: "paperclip",
          url: "https://files.example.com/cloudflare-receipt.pdf"
        }
      ],
      actions: [
        {
          display: "Choose category",
          icon: "chevron-down",
          value: "choose_category",
          overflow: false,
          tone: "neutral",
          style: "outline",
          popup: {
            kind: "single_select",
            label: "Transaction category",
            options: [
              {
                display: "Software & cloud services",
                value: "software_cloud",
                icon: "check"
              },
              {
                display: "Domain names",
                value: "domains",
                icon: "file"
              },
              {
                display: "Needs investigation",
                value: "investigate",
                icon: "inbox"
              }
            ]
          }
        },
        {
          display: "Add note",
          icon: "file",
          value: "add_note",
          overflow: false,
          tone: "neutral",
          style: "outline",
          popup: {
            kind: "free_text",
            label: "Transaction note",
            placeholder: "Why is this category correct?",
            default_value: null,
            multiline: false,
            min_length: 1,
            max_length: 240
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000522",
      caller_item_id: "research:benchmark:cost-denominator",
      status: "pending",
      priority: "normal",
      currentRevision: 1,
      row_type: { display: "Research Question", icon: "flask-conical" },
      row_accent_color: null,
      title: "Which cost denominator should the benchmark use?",
      subtitle: "Overnight analysis paused before recomputing 38 runs.",
      corner: "Blocked status",
      card_time: null,
      summary:
        "<p>The source reports both provider invoice cost and token-list-price cost. Choosing one changes the cross-harness comparison by 11–18%.</p>",
      details:
        "<ul><li><strong>Invoice cost:</strong> reflects real spend but includes negotiated discounts.</li><li><strong>List-price cost:</strong> reproducible across readers but not the amount paid.</li><li><strong>Report both:</strong> adds a second table and widens the analysis.</li></ul>",
      card_visual: {
        kind: "pill",
        text: "Agent blocked",
        icon: null,
        color: "red"
      },
      skip_disabled: true,
      createdAt: "2026-08-14T06:10:00.000Z",
      updatedAt: "2026-08-14T06:11:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Benchmark Analyst", "benchmark-analyst"),
      output: null,
      link_buttons: [
        {
          display: "Read methodology note",
          icon: "file",
          url: "https://docs.example.com/benchmark-methodology"
        }
      ],
      actions: [
        {
          display: "Choose basis",
          icon: "chevron-down",
          value: "choose_basis",
          overflow: false,
          popup: {
            kind: "single_select",
            label: "Cost basis",
            options: [
              {
                display: "Report both",
                value: "both",
                icon: "check"
              },
              {
                display: "Invoice cost",
                value: "invoice",
                icon: null
              },
              {
                display: "List-price cost",
                value: "list_price",
                icon: null
              }
            ]
          }
        },
        {
          display: "Explain another approach",
          icon: "file",
          value: "other_approach",
          overflow: false,
          popup: {
            kind: "free_text",
            label: "Direction for the analysis",
            placeholder: "Describe the denominator and why.",
            default_value: null,
            multiline: true,
            min_length: 4,
            max_length: 800
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000523",
      caller_item_id: "deploy:production:payments-smoke",
      status: "pending",
      priority: "urgent",
      currentRevision: 2,
      row_type: { display: "Deployment Exception", icon: "rocket" },
      row_accent_color: "red",
      title: "Payments smoke check failed after deploy",
      subtitle: "Production · checkout session test",
      corner: "Release gate",
      card_time: null,
      summary:
        "<p><strong>Failure:</strong> Stripe test checkout returned in 2.8s, above the 2.0s policy threshold. Error rate and payment completion remain normal.</p>",
      details:
        "<h3>Incident evidence</h3><pre><code>p95 checkout session: 2.8s\nbaseline p95: 1.7s\nHTTP errors: 0.00%\npayment completion: 99.8%</code></pre><p>The agent will not change production until you choose an explicit response.</p><h4>Sanitized caller attachment</h4><blockquote>&lt;script&gt;fixtureUnsafeScript()&lt;/script&gt;<br>&lt;svg&gt;&lt;foreignObject&gt;bad&lt;/foreignObject&gt;&lt;/svg&gt;<br>&lt;form action='https://example.com'&gt;&lt;input name='x'&gt;&lt;/form&gt;&lt;video src='https://example.com/movie.mp4'&gt;&lt;/video&gt;&lt;CallerInjectedWidget /&gt;</blockquote>",
      card_visual: {
        kind: "pill",
        text: "1 failed",
        icon: "x",
        color: "red"
      },
      skip_disabled: true,
      createdAt: "2026-08-14T14:09:00.000Z",
      updatedAt: "2026-08-14T14:12:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Release Operator", "release-operator"),
      output: null,
      unanswerableActions: ["unavailable_upload"],
      link_buttons: [
        {
          display: "Open deployment",
          icon: "external-link",
          url: "https://deploy.example.com/releases/2026-08-14"
        },
        {
          display: "Download smoke log",
          icon: "download",
          url: "https://deploy.example.com/logs/payments-smoke.txt"
        },
        {
          display: "Open safety note",
          icon: "external-link",
          url: "https://example.com/safety-note"
        },
        {
          display: "Inspect release metrics",
          icon: "external-link",
          url: "https://metrics.example.com/releases/2026-08-14"
        },
        {
          display: "Read the full production rollback safety procedure",
          icon: "file",
          url: "https://docs.example.com/production-rollback-safety"
        }
      ],
      actions: [
        {
          display: "Keep release",
          icon: "check",
          value: "keep_release",
          overflow: false,
          tone: "success",
          style: "solid",
          popup: {
            kind: "single_select",
            label: "Confirm release exception",
            options: [
              {
                display: "Keep this release active",
                value: "confirm_keep_release",
                icon: "check"
              }
            ]
          }
        },
        {
          display: "Roll back",
          icon: "x",
          value: "roll_back",
          overflow: false,
          tone: "danger",
          style: "outline",
          popup: {
            kind: "single_select",
            label: "Confirm production rollback",
            options: [
              {
                display: "Roll back release now",
                value: "confirm_rollback",
                icon: "x"
              }
            ]
          }
        },
        {
          display: "Confirm checks",
          icon: "check",
          value: "confirm_checks",
          overflow: true,
          popup: {
            kind: "multi_select",
            label: "Checks you verified",
            min_selected: 2,
            max_selected: 3,
            options: [
              {
                display: "Checkout completes",
                value: "checkout",
                icon: "check"
              },
              {
                display: "No elevated errors",
                value: "errors",
                icon: "check"
              },
              {
                display: "Rollback is ready",
                value: "rollback_ready",
                icon: "check"
              }
            ]
          }
        },
        {
          display: "Attach incident evidence",
          icon: "paperclip",
          value: "attach_incident_evidence",
          overflow: true,
          popup: {
            kind: "file_upload",
            label: "Screenshot or log",
            accept_mime_types: ["image/*", "text/plain", "application/pdf"]
          }
        },
        {
          display: "Unavailable upload",
          icon: "upload",
          value: "unavailable_upload",
          overflow: true,
          popup: {
            kind: "file_upload",
            label: "Any supported file",
            accept_mime_types: null
          }
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000525",
      caller_item_id: "sms:reply:contractor-arrival",
      status: "answered",
      priority: "low",
      currentRevision: 1,
      row_type: { display: "SMS Reply", icon: "send" },
      row_accent_color: "teal",
      title: "Confirm the electrician’s arrival window",
      subtitle: "+1 (518) 555-0148 · known contact",
      corner: null,
      card_time: null,
      summary:
        "<p><strong>Reply:</strong> “Tomorrow between 8:30 and 9 works. Please text when you’re on the way.”</p>",
      details: null,
      card_visual: null,
      skip_disabled: false,
      createdAt: "2026-08-14T09:00:00.000Z",
      updatedAt: "2026-08-14T09:04:00.000Z",
      answeredAt: "2026-08-14T09:06:00.000Z",
      caller: fixtureCaller("SignalWire Bridge", "signalwire-bridge"),
      output: {
        outputResultId: "00000000-0000-4000-8000-000000000599",
        actionValue: "approve_reply",
        actionDisplay: "Approve reply",
        answeredAt: "2026-08-14T09:06:00.000Z",
        firstReadAt: "2026-08-14T09:07:00.000Z",
        readCount: 1,
        undoEligible: false
      },
      link_buttons: [],
      actions: [
        {
          display: "Approve reply",
          icon: "send",
          value: "approve_reply",
          overflow: false,
          popup: { kind: "none" }
        },
        {
          display: "Choose arrival date",
          icon: "calendar",
          value: "choose_arrival_date",
          overflow: false,
          popup: {
            kind: "date_picker",
            label: "Arrival date",
            mode: "date",
            placeholder: null,
            display_timezone: null,
            min_value: null,
            max_value: null
          }
        },
        {
          display: "Pick exact time",
          icon: "clock",
          value: "pick_exact_time",
          overflow: true,
          popup: {
            kind: "date_picker",
            label: "Arrival time",
            mode: "datetime",
            placeholder: "Local date and time",
            display_timezone: "America/New_York",
            min_value: "2026-08-15T12:00:00.000Z",
            max_value: "2026-08-22T22:00:00.000Z"
          }
        }
      ]
    }
  ];
  return fixtures.map(normalizeCoreFixture);
}

/**
 * Validate caller input and combine normalized review fields with stored metadata.
 * Only pending actions absent from unanswerableActions remain answerable.
 * @throws When the fixture's caller input fails submission validation.
 */
function normalizeCoreFixture({
  inputItemId,
  status,
  currentRevision,
  createdAt,
  updatedAt,
  answeredAt,
  caller,
  output,
  unanswerableActions = [],
  ...input
}: CoreFixture): HumanReviewDetail {
  const parsed = parseInputSubmission(input);
  if (!parsed.ok) {
    throw new Error(
      `Invalid canonical core fixture ${String(input.caller_item_id)}: ${JSON.stringify(parsed.error)}`
    );
  }
  const normalized = detailFromNormalizedSubmission(parsed.submission, {
    inputItemId,
    updatedAt
  });
  return {
    ...normalized,
    status,
    currentRevision,
    createdAt,
    answeredAt,
    caller,
    output,
    actions: normalized.actions.map((action) => ({
      ...action,
      answerable:
        status === "pending" && !unanswerableActions.includes(action.value)
    }))
  };
}

/**
 * Build caller metadata with the fixed default ID or a stable ID derived from its slug.
 */
function fixtureCaller(
  displayName = "Steward Operations",
  slug = "steward-operations"
) {
  return {
    callerId:
      slug === "steward-operations"
        ? fixtureCallerId
        : fixtureUuid(`browser-fixture-caller:${slug}`),
    displayName,
    slug,
    revoked: false
  };
}

export const STORYBOARD_USE_CASES: Record<string, string> = {
  "steward-brief-101": "High-impact public-facing decision",
  "steward-check-202": "Schedule a follow-up before work continues",
  "email:draft:meridian-renewal": "Email draft approval",
  "email:triage:github-security-digest": "Email archive labeling",
  "linkedin:connection:maya-chen": "LinkedIn connection request approval",
  "x:post:agent-instruction-ablation": "X post draft approval",
  "monarch:transaction:cloudflare-2026-08": "Financial categorization judgment",
  "research:benchmark:cost-denominator":
    "Answer ambiguity without watching the run",
  "deploy:production:payments-smoke": "Resolve a failed automated check",
  "sms:reply:contractor-arrival": "SMS reply and scheduling"
};
