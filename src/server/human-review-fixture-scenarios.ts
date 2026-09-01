import { createHash } from "node:crypto";

import type { HumanReviewDetail } from "./human-review.ts";
import { detailFromNormalizedSubmission } from "./human-review-design-fixture.ts";
import { parseInputSubmission } from "./input-schema.ts";

const fixtureCallerId = "00000000-0000-4000-8000-000000000503";

export function fixtureUuid(seed: string) {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16
  )}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function browserFixtureCoreReviewDetails(): HumanReviewDetail[] {
  const details: HumanReviewDetail[] = [
    {
      inputItemId: "00000000-0000-4000-8000-000000000511",
      callerItemId: "steward-brief-101",
      status: "pending",
      priority: "urgent",
      currentRevision: 3,
      rowType: { display: "Steward Brief", icon: "message-square" },
      rowAccentColor: "teal",
      titleHtml: "<strong>Review neighborhood permit brief</strong>",
      subtitleHtml: "A resident-facing summary needs a final human check.",
      cornerHtml: "Rev 3",
      summaryHtml:
        "<p><strong>Send:</strong> “Your permit is ready for final review. The remaining neighborhood notice period ends July 8.”</p>",
      detailsHtml:
        "<p>The system drafted a short permit explanation from structured notes. Verify the recommendation, edit only if the popup asks for it, and keep the response generic.</p><ul><li>No source-system action is performed here.</li><li>The caller receives only the selected answer value.</li></ul>",
      cardVisual: {
        kind: "numeric_bar",
        payload: {
          label: "Confidence",
          value: 82,
          display: "82%",
          unit: "%",
          min_value: 0,
          max_value: 100
        }
      },
      skipDisabled: false,
      createdAt: "2026-07-01T13:00:00.000Z",
      updatedAt: "2026-07-01T13:20:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open context",
          icon: "external-link",
          url: "https://example.com/context/steward-brief-101"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Approve permit brief",
          icon: "check",
          value: "approve",
          overflow: false,
          tone: "success",
          style: "solid",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Request edit",
          icon: "send",
          value: "request_edit",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popupKind: "free_text",
          popupPayload: {
            label: "Requested change",
            placeholder: "Name the one change needed before handoff.",
            default_value: null,
            multiline: true,
            min_length: 4,
            max_length: 240
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Attach evidence",
          icon: "upload",
          value: "attach_evidence",
          overflow: true,
          tone: "brand",
          style: "outline",
          popupKind: "file_upload",
          popupPayload: {
            label: "Evidence file",
            accept_mime_types: ["application/pdf", "text/plain"]
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 3,
          display: "Set review lane",
          icon: "chevron-down",
          value: "set_lane",
          overflow: true,
          popupKind: "single_select",
          popupPayload: { label: "Review lane" },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Policy",
              value: "policy",
              icon: "file"
            },
            {
              displayOrder: 1,
              display: "Operations",
              value: "operations",
              icon: "inbox"
            }
          ]
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000512",
      callerItemId: "steward-check-202",
      status: "pending",
      priority: "high",
      currentRevision: 1,
      rowType: { display: "Decision Check", icon: "calendar" },
      rowAccentColor: "orange",
      titleHtml: "Choose follow-up window",
      subtitleHtml: "The caller needs a review date before continuing.",
      cornerHtml: "Scheduling task",
      summaryHtml:
        "<p><strong>Proposed follow-up:</strong> Wednesday, July 8 · 2:00–4:00 PM UTC.</p>",
      detailsHtml:
        "<p>The date picker metadata is displayed here for human review.</p>",
      cardVisual: {
        kind: "progress_ring",
        payload: {
          label: "Readiness",
          value: 6,
          display: "6 of 10",
          unit: "checks",
          min_value: 0,
          max_value: 10,
          color: null
        }
      },
      skipDisabled: true,
      createdAt: "2026-07-01T12:10:00.000Z",
      updatedAt: "2026-07-01T12:55:00.000Z",
      answeredAt: null,
      caller: fixtureCaller(),
      output: null,
      bulkActions: [],
      linkButtons: [],
      actions: [
        {
          displayOrder: 0,
          display: "Approve follow-up",
          icon: "check",
          value: "approve",
          overflow: false,
          tone: "success",
          style: "solid",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Pick date",
          icon: "calendar",
          value: "pick_date",
          overflow: false,
          tone: "brand",
          style: "outline",
          popupKind: "date_picker",
          popupPayload: {
            label: "Follow-up date",
            mode: "date",
            placeholder: "YYYY-MM-DD",
            display_timezone: "UTC",
            min_value: "2026-07-01",
            max_value: "2026-07-31"
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Pick date and time",
          icon: "clock",
          value: "pick_datetime",
          overflow: false,
          tone: "brand",
          style: "outline",
          popupKind: "date_picker",
          popupPayload: {
            label: "Follow-up instant",
            mode: "datetime",
            placeholder: "UTC datetime",
            display_timezone: "UTC",
            min_value: "2026-07-01T00:00:00.000Z",
            max_value: "2026-07-31T23:59:59.000Z"
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 3,
          display: "Select checks",
          icon: "check",
          value: "select_checks",
          overflow: true,
          popupKind: "multi_select",
          popupPayload: {
            label: "Completed checks",
            min_selected: 1,
            max_selected: 2
          },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Facts reviewed",
              value: "facts_reviewed",
              icon: "check"
            },
            {
              displayOrder: 1,
              display: "Tone reviewed",
              value: "tone_reviewed",
              icon: "check"
            },
            {
              displayOrder: 2,
              display: "Sources reviewed",
              value: "sources_reviewed",
              icon: "check"
            }
          ]
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000516",
      callerItemId: "email:draft:meridian-renewal",
      status: "pending",
      priority: "urgent",
      currentRevision: 4,
      rowType: { display: "Email Draft", icon: "mail" },
      rowAccentColor: "orange",
      titleHtml: "<strong>Reply to Meridian about the renewal delay</strong>",
      subtitleHtml:
        "Exact outbound copy prepared from the contract thread and latest delivery note.",
      cornerHtml: "Rev 4",
      summaryHtml:
        "<p><strong>Send:</strong> “Hi Ana — we can hold your current pricing through September 30. The revised implementation plan is attached, and the only date that moved is the data-import rehearsal.”</p>",
      detailsHtml:
        "<p>The agent reconciled the requested extension against the signed renewal terms. This message makes a commercial commitment and will be sent to three external recipients.</p><table><tbody><tr><th>To</th><td>Ana Ruiz, Marcus Bell</td></tr><tr><th>Cc</th><td>accounting@northstar.example</td></tr><tr><th>Subject</th><td>Meridian renewal timeline</td></tr></tbody></table>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "External · 3",
          icon: "send",
          color: "orange"
        }
      },
      skipDisabled: false,
      createdAt: "2026-08-14T13:49:00.000Z",
      updatedAt: "2026-08-14T14:07:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Steward Email", "steward-email"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open source thread",
          icon: "external-link",
          url: "https://mail.example.com/thread/meridian-renewal"
        },
        {
          displayOrder: 1,
          display: "Download revised plan",
          icon: "download",
          url: "https://files.example.com/meridian-plan.pdf"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Approve to send",
          icon: "send",
          value: "approve_draft",
          overflow: false,
          tone: "success",
          style: "solid",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Request revision",
          icon: "file",
          value: "request_revision",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popupKind: "free_text",
          popupPayload: {
            label: "What should change?",
            placeholder: "Be specific; the agent will return a revised draft.",
            default_value: "Keep the message concise, but ",
            multiline: true,
            min_length: 4,
            max_length: 500
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Block send",
          icon: "x",
          value: "reject_send",
          overflow: false,
          tone: "danger",
          style: "outline",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000517",
      callerItemId: "email:triage:github-security-digest",
      status: "answered",
      priority: "normal",
      currentRevision: 1,
      rowType: { display: "Email Triage", icon: "archive" },
      rowAccentColor: "green",
      titleHtml:
        '<a href="https://example.com/digest">GitHub security digest for archived repositories</a>',
      subtitleHtml:
        "GitHub &lt;noreply@github.com&gt; · received 18 minutes ago",
      cornerHtml: "Inbox label",
      summaryHtml:
        "<p><strong>Recommendation: Archive.</strong> Automated digest; all 14 alerts concern repositories already marked read-only. Nine similar messages were archived.</p>",
      detailsHtml:
        "<p>The agent found no direct mention, billing change, or active production repository. Related labeled examples: 9 Archive, 0 Agent.</p>",
      cardVisual: {
        kind: "numeric_bar",
        payload: {
          label: "Archive confidence",
          value: 96,
          display: "96",
          unit: "%",
          min_value: 0,
          max_value: 100
        }
      },
      skipDisabled: false,
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
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open in mail",
          icon: "external-link",
          url: "https://mail.example.com/thread/github-security-digest"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Archive",
          icon: "archive",
          value: "archive",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: false,
          options: []
        },
        {
          displayOrder: 1,
          display: "Agent",
          icon: "inbox",
          value: "agent",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: false,
          options: []
        },
        {
          displayOrder: 2,
          display: "Agent, resolved",
          icon: "check",
          value: "agent_resolved",
          overflow: true,
          popupKind: "none",
          popupPayload: {},
          answerable: false,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000518",
      callerItemId: "linkedin:connection:maya-chen",
      status: "pending",
      priority: "normal",
      currentRevision: 1,
      rowType: { display: "LinkedIn Request", icon: "user-plus" },
      rowAccentColor: "blue",
      titleHtml: "Maya Chen wants to connect",
      subtitleHtml: "Staff engineer · Retrieval systems",
      cornerHtml: "Profile context",
      summaryHtml:
        "<p><strong>Recommendation: Accept.</strong> Maya referenced your agent-harness benchmark and works on evaluation infrastructure at Fieldstone AI.</p>",
      detailsHtml:
        "<blockquote>Enjoyed your breakdown of harness overhead. We are seeing the same context-replay problem in internal evals and would love to compare notes.</blockquote><p>No prior messages. Profile created in 2016 with consistent engineering history.</p>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "6 mutual",
          icon: null,
          color: "blue"
        }
      },
      skipDisabled: false,
      createdAt: "2026-08-14T11:20:00.000Z",
      updatedAt: "2026-08-14T12:02:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("LinkedIn Steward", "linkedin-steward"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "View profile",
          icon: "external-link",
          url: "https://linkedin.example.com/in/maya-chen"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Accept",
          icon: "check",
          value: "accept",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Ignore",
          icon: "x",
          value: "ignore",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Accept with note",
          icon: "send",
          value: "accept_with_note",
          overflow: true,
          popupKind: "free_text",
          popupPayload: {
            label: "Connection note",
            placeholder: "Write a short note",
            default_value: "Thanks, Maya — ",
            multiline: false,
            min_length: 2,
            max_length: 280
          },
          answerable: true,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000519",
      callerItemId: "x:post:agent-instruction-ablation",
      status: "pending",
      priority: "high",
      currentRevision: 3,
      rowType: { display: "X Post Draft", icon: "at-sign" },
      rowAccentColor: "purple",
      titleHtml: "Publish the instruction-ablation result",
      subtitleHtml: "Exact public copy · 252 of 280 characters",
      cornerHtml: "Rev 3",
      summaryHtml:
        "<p><strong>Post:</strong> “Removing one instruction cut cost 36.5% without reducing score. Agent instructions are production code: measure them, diff them, and keep humans in the loop.”</p>",
      detailsHtml:
        "<p>All figures match the locked benchmark note. No customer names or unreleased repository details are included.</p>",
      cardVisual: {
        kind: "progress_ring",
        payload: {
          label: "Character use",
          value: 252,
          display: "252 / 280",
          unit: null,
          min_value: 0,
          max_value: 280,
          color: "orange"
        }
      },
      skipDisabled: true,
      createdAt: "2026-08-14T12:24:00.000Z",
      updatedAt: "2026-08-14T13:58:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("X Publishing", "x-publishing"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open source note",
          icon: "file",
          url: "https://docs.example.com/ablation-note"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Approve post",
          icon: "send",
          value: "approve_post",
          overflow: false,
          tone: "success",
          style: "solid",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 1,
          display: "Revise copy",
          icon: "file",
          value: "revise_copy",
          overflow: true,
          tone: "neutral",
          style: "outline",
          popupKind: "free_text",
          popupPayload: {
            label: "Revision direction",
            placeholder: "Call out the exact sentence or claim to change.",
            default_value: null,
            multiline: true,
            min_length: 3,
            max_length: 400
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 2,
          display: "Decline post",
          icon: "x",
          value: "decline_post",
          overflow: false,
          tone: "danger",
          style: "outline",
          popupKind: "none",
          popupPayload: {},
          answerable: true,
          options: []
        },
        {
          displayOrder: 3,
          display: "Delete draft",
          icon: "trash",
          value: "delete_draft",
          overflow: true,
          popupKind: "single_select",
          popupPayload: { label: "Confirm draft deletion" },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Delete this draft",
              value: "confirm_delete",
              icon: "trash"
            }
          ]
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000521",
      callerItemId: "monarch:transaction:cloudflare-2026-08",
      status: "pending",
      priority: "high",
      currentRevision: 2,
      rowType: { display: "Transaction Review", icon: "credit-card" },
      rowAccentColor: "orange",
      titleHtml: "Categorize Cloudflare · $240.00",
      subtitleHtml: "Business card •• 1842 · posted August 13",
      cornerHtml: "Anomaly signal",
      summaryHtml:
        "<p><strong>Suggested category:</strong> Software &amp; cloud services. The amount is 3× higher than the trailing monthly median.</p>",
      detailsHtml:
        "<p>The increase matches the annual domain-renewal month, but the merchant descriptor does not separate domains from compute usage.</p>",
      cardVisual: {
        kind: "numeric_bar",
        payload: {
          label: "Category confidence",
          value: 34,
          display: "34",
          unit: "%",
          min_value: 0,
          max_value: 100
        }
      },
      skipDisabled: false,
      createdAt: "2026-08-14T10:55:00.000Z",
      updatedAt: "2026-08-14T11:42:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Monarch Review", "monarch-review"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open transaction",
          icon: "external-link",
          url: "https://finance.example.com/transactions/cloudflare-2026-08"
        },
        {
          displayOrder: 1,
          display: "View receipt",
          icon: "paperclip",
          url: "https://files.example.com/cloudflare-receipt.pdf"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Choose category",
          icon: "chevron-down",
          value: "choose_category",
          overflow: false,
          tone: "neutral",
          style: "outline",
          popupKind: "single_select",
          popupPayload: { label: "Transaction category" },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Software & cloud services",
              value: "software_cloud",
              icon: "check"
            },
            {
              displayOrder: 1,
              display: "Domain names",
              value: "domains",
              icon: "file"
            },
            {
              displayOrder: 2,
              display: "Needs investigation",
              value: "investigate",
              icon: "inbox"
            }
          ]
        },
        {
          displayOrder: 1,
          display: "Add note",
          icon: "file",
          value: "add_note",
          overflow: false,
          tone: "neutral",
          style: "outline",
          popupKind: "free_text",
          popupPayload: {
            label: "Transaction note",
            placeholder: "Why is this category correct?",
            default_value: null,
            multiline: false,
            min_length: 1,
            max_length: 240
          },
          answerable: true,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000522",
      callerItemId: "research:benchmark:cost-denominator",
      status: "pending",
      priority: "normal",
      currentRevision: 1,
      rowType: { display: "Research Question", icon: "flask-conical" },
      rowAccentColor: null,
      titleHtml: "Which cost denominator should the benchmark use?",
      subtitleHtml: "Overnight analysis paused before recomputing 38 runs.",
      cornerHtml: "Blocked status",
      summaryHtml:
        "<p>The source reports both provider invoice cost and token-list-price cost. Choosing one changes the cross-harness comparison by 11–18%.</p>",
      detailsHtml:
        "<ul><li><strong>Invoice cost:</strong> reflects real spend but includes negotiated discounts.</li><li><strong>List-price cost:</strong> reproducible across readers but not the amount paid.</li><li><strong>Report both:</strong> adds a second table and widens the analysis.</li></ul>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "Agent blocked",
          icon: null,
          color: "red"
        }
      },
      skipDisabled: true,
      createdAt: "2026-08-14T06:10:00.000Z",
      updatedAt: "2026-08-14T06:11:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Benchmark Analyst", "benchmark-analyst"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Read methodology note",
          icon: "file",
          url: "https://docs.example.com/benchmark-methodology"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Choose basis",
          icon: "chevron-down",
          value: "choose_basis",
          overflow: false,
          popupKind: "single_select",
          popupPayload: { label: "Cost basis" },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Report both",
              value: "both",
              icon: "check"
            },
            {
              displayOrder: 1,
              display: "Invoice cost",
              value: "invoice",
              icon: null
            },
            {
              displayOrder: 2,
              display: "List-price cost",
              value: "list_price",
              icon: null
            }
          ]
        },
        {
          displayOrder: 1,
          display: "Explain another approach",
          icon: "file",
          value: "other_approach",
          overflow: false,
          popupKind: "free_text",
          popupPayload: {
            label: "Direction for the analysis",
            placeholder: "Describe the denominator and why.",
            default_value: null,
            multiline: true,
            min_length: 4,
            max_length: 800
          },
          answerable: true,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000523",
      callerItemId: "deploy:production:payments-smoke",
      status: "pending",
      priority: "urgent",
      currentRevision: 2,
      rowType: { display: "Deployment Exception", icon: "rocket" },
      rowAccentColor: "red",
      titleHtml: "Payments smoke check failed after deploy",
      subtitleHtml: "Production · checkout session test",
      cornerHtml: "Release gate",
      summaryHtml:
        "<p><strong>Failure:</strong> Stripe test checkout returned in 2.8s, above the 2.0s policy threshold. Error rate and payment completion remain normal.</p>",
      detailsHtml:
        "<h3>Incident evidence</h3><pre><code>p95 checkout session: 2.8s\nbaseline p95: 1.7s\nHTTP errors: 0.00%\npayment completion: 99.8%</code></pre><p>The agent will not change production until you choose an explicit response.</p><h4>Sanitized caller attachment</h4><blockquote>&lt;script&gt;fixtureUnsafeScript()&lt;/script&gt;<br>&lt;svg&gt;&lt;foreignObject&gt;bad&lt;/foreignObject&gt;&lt;/svg&gt;<br>&lt;form action='https://example.com'&gt;&lt;input name='x'&gt;&lt;/form&gt;&lt;video src='https://example.com/movie.mp4'&gt;&lt;/video&gt;&lt;CallerInjectedWidget /&gt;</blockquote>",
      cardVisual: {
        kind: "pill",
        payload: {
          text: "1 failed",
          icon: "x",
          color: "red"
        }
      },
      skipDisabled: true,
      createdAt: "2026-08-14T14:09:00.000Z",
      updatedAt: "2026-08-14T14:12:00.000Z",
      answeredAt: null,
      caller: fixtureCaller("Release Operator", "release-operator"),
      output: null,
      bulkActions: [],
      linkButtons: [
        {
          displayOrder: 0,
          display: "Open deployment",
          icon: "external-link",
          url: "https://deploy.example.com/releases/2026-08-14"
        },
        {
          displayOrder: 1,
          display: "Download smoke log",
          icon: "download",
          url: "https://deploy.example.com/logs/payments-smoke.txt"
        },
        {
          displayOrder: 2,
          display: "Open safety note",
          icon: "external-link",
          url: "https://example.com/safety-note"
        }
      ],
      actions: [
        {
          displayOrder: 0,
          display: "Keep release",
          icon: "check",
          value: "keep_release",
          overflow: false,
          tone: "success",
          style: "solid",
          popupKind: "single_select",
          popupPayload: {
            label: "Confirm release exception"
          },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Keep this release active",
              value: "confirm_keep_release",
              icon: "check"
            }
          ]
        },
        {
          displayOrder: 1,
          display: "Roll back",
          icon: "x",
          value: "roll_back",
          overflow: false,
          tone: "danger",
          style: "outline",
          popupKind: "single_select",
          popupPayload: {
            label: "Confirm production rollback"
          },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Roll back release now",
              value: "confirm_rollback",
              icon: "x"
            }
          ]
        },
        {
          displayOrder: 2,
          display: "Confirm checks",
          icon: "check",
          value: "confirm_checks",
          overflow: true,
          popupKind: "multi_select",
          popupPayload: {
            label: "Checks you verified",
            min_selected: 2,
            max_selected: 3
          },
          answerable: true,
          options: [
            {
              displayOrder: 0,
              display: "Checkout completes",
              value: "checkout",
              icon: "check"
            },
            {
              displayOrder: 1,
              display: "No elevated errors",
              value: "errors",
              icon: "check"
            },
            {
              displayOrder: 2,
              display: "Rollback is ready",
              value: "rollback_ready",
              icon: "check"
            }
          ]
        },
        {
          displayOrder: 3,
          display: "Attach incident evidence",
          icon: "paperclip",
          value: "attach_incident_evidence",
          overflow: true,
          popupKind: "file_upload",
          popupPayload: {
            label: "Screenshot or log",
            accept_mime_types: ["image/*", "text/plain", "application/pdf"]
          },
          answerable: true,
          options: []
        },
        {
          displayOrder: 4,
          display: "Unavailable upload",
          icon: "upload",
          value: "unavailable_upload",
          overflow: true,
          popupKind: "file_upload",
          popupPayload: {
            label: "Any supported file",
            accept_mime_types: null
          },
          answerable: false,
          options: []
        }
      ]
    },
    {
      inputItemId: "00000000-0000-4000-8000-000000000525",
      callerItemId: "sms:reply:contractor-arrival",
      status: "answered",
      priority: "low",
      currentRevision: 1,
      rowType: { display: "SMS Reply", icon: "send" },
      rowAccentColor: "teal",
      titleHtml: "Confirm the electrician’s arrival window",
      subtitleHtml: "+1 (518) 555-0148 · known contact",
      cornerHtml: null,
      summaryHtml:
        "<p><strong>Reply:</strong> “Tomorrow between 8:30 and 9 works. Please text when you’re on the way.”</p>",
      detailsHtml: null,
      cardVisual: null,
      skipDisabled: false,
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
      bulkActions: [],
      linkButtons: [],
      actions: [
        {
          displayOrder: 0,
          display: "Approve reply",
          icon: "send",
          value: "approve_reply",
          overflow: false,
          popupKind: "none",
          popupPayload: {},
          answerable: false,
          options: []
        },
        {
          displayOrder: 1,
          display: "Choose arrival date",
          icon: "calendar",
          value: "choose_arrival_date",
          overflow: false,
          popupKind: "date_picker",
          popupPayload: {
            label: "Arrival date",
            mode: "date",
            placeholder: null,
            display_timezone: null,
            min_value: null,
            max_value: null
          },
          answerable: false,
          options: []
        },
        {
          displayOrder: 2,
          display: "Pick exact time",
          icon: "clock",
          value: "pick_exact_time",
          overflow: true,
          popupKind: "date_picker",
          popupPayload: {
            label: "Arrival time",
            mode: "datetime",
            placeholder: "Local date and time",
            display_timezone: "America/New_York",
            min_value: "2026-08-15T12:00:00.000Z",
            max_value: "2026-08-22T22:00:00.000Z"
          },
          answerable: false,
          options: []
        }
      ]
    }
  ];
  return details.map(normalizeCoreFixture);
}

function normalizeCoreFixture(detail: HumanReviewDetail): HumanReviewDetail {
  const publicInput = {
    caller_item_id: detail.callerItemId,
    priority: detail.priority,
    row_type: detail.rowType,
    row_accent_color: detail.rowAccentColor,
    title: detail.titleHtml,
    subtitle: detail.subtitleHtml,
    corner: detail.cornerHtml,
    summary: detail.summaryHtml,
    details: detail.detailsHtml,
    link_buttons: detail.linkButtons.map(({ display, icon, url }) => ({
      display,
      icon,
      url
    })),
    card_visual: detail.cardVisual
      ? { kind: detail.cardVisual.kind, ...detail.cardVisual.payload }
      : null,
    skip_disabled: detail.skipDisabled,
    actions: detail.actions.map((action) => ({
      display: action.display,
      icon: action.icon,
      value: action.value,
      overflow: action.overflow,
      ...(action.tone && action.style
        ? { tone: action.tone, style: action.style }
        : {}),
      popup: {
        kind: action.popupKind,
        ...action.popupPayload,
        ...(action.options.length > 0
          ? {
              options: action.options.map(({ display, value, icon }) => ({
                display,
                value,
                icon
              }))
            }
          : {})
      }
    }))
  };
  const parsed = parseInputSubmission(publicInput);
  if (!parsed.ok) {
    throw new Error(
      `Invalid canonical core fixture ${detail.callerItemId}: ${JSON.stringify(parsed.error)}`
    );
  }
  const normalized = detailFromNormalizedSubmission(parsed.submission, {
    inputItemId: detail.inputItemId,
    updatedAt: detail.updatedAt
  });
  return {
    ...normalized,
    status: detail.status,
    currentRevision: detail.currentRevision,
    createdAt: detail.createdAt,
    answeredAt: detail.answeredAt,
    caller: detail.caller,
    output: detail.output,
    actions: normalized.actions.map((action) => ({
      ...action,
      answerable:
        detail.actions.find((candidate) => candidate.value === action.value)
          ?.answerable ?? false
    }))
  };
}

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
