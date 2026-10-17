import { htmlToPlainText } from "../shared/html-text.ts";
import {
  runProductTransaction,
  type TransactionContextStatement
} from "./database.ts";
import { emitRuntimeLog } from "./logging.ts";

const BATCH_SIZE = 100;
const MAX_BATCHES = 10;

type ReviewHtml = {
  titleHtml: string;
  subtitleHtml: string;
  summaryHtml: string;
};
type Candidate = {
  input_item_id: string;
  title_html: string;
  subtitle_html: string;
  summary_html: string;
};

// Keep identical to the migration trigger. PostgreSQL owns JSON serialization
// and hashing; a JavaScript serialization would not produce the same digest.
export function reviewTextSourceDigestSql(
  title: string,
  subtitle: string,
  summary: string
) {
  return `encode(pg_catalog.sha256(convert_to(jsonb_build_array(${title}, ${subtitle}, ${summary})::text, 'UTF8')), 'hex')`;
}

export function reviewTextValues(input: ReviewHtml) {
  return [input.titleHtml, input.subtitleHtml, input.summaryHtml].map(
    htmlToPlainText
  );
}

export function reviewTextCandidatesStatement(
  accountId: string
): TransactionContextStatement {
  return {
    sql: `select input_item_id, title_html, subtitle_html, summary_html
      from public.agent_outbox_input_items
      where account_id = $1 and review_text_source_sha256 is null
      order by input_item_id limit ${BATCH_SIZE} for update skip locked`,
    values: [accountId]
  };
}

function deriveStatement(
  accountId: string,
  rows: Candidate[]
): TransactionContextStatement {
  const values: string[] = [accountId];
  const decoded = rows.map((row) => [
    row.input_item_id,
    ...reviewTextValues({
      titleHtml: row.title_html,
      subtitleHtml: row.subtitle_html,
      summaryHtml: row.summary_html
    })
  ]);
  const columns = ["uuid", "text", "text", "text"].map((type, column) => {
    const parameters = decoded.map((row) => {
      values.push(row[column]);
      return `$${values.length}::${type}`;
    });
    return `array[${parameters.join(",")}]`;
  });
  return {
    sql: `update public.agent_outbox_input_items i
      set title_text = d.title, subtitle_text = d.subtitle, summary_text = d.summary,
          review_text_source_sha256 = ${reviewTextSourceDigestSql("i.title_html", "i.subtitle_html", "i.summary_html")}
      from unnest(${columns.join(",")}) as d(id, title, subtitle, summary)
      where i.account_id = $1 and i.input_item_id = d.id returning i.input_item_id`,
    values
  };
}

// Each successful batch commits before progress is counted or another starts.
// SKIP LOCKED avoids acquiring account locks in the reverse foreground order.
export async function deriveReviewSearchTextForAccount(input: {
  connectionString: string;
  accountId: string;
  requestId: string;
  runTransaction?: typeof runProductTransaction;
  onCommitted?: (count: number) => void;
}) {
  let total = 0;
  const runTransaction = input.runTransaction ?? runProductTransaction;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const count = await runTransaction(
      input.connectionString,
      {
        authSurface: "cleanup",
        accountId: input.accountId,
        requestId: input.requestId
      },
      async (query) => {
        const { rows } = await query<Candidate>(
          reviewTextCandidatesStatement(input.accountId)
        );
        if (rows.length === 0) return 0;
        const result = await query(deriveStatement(input.accountId, rows));
        if (result.rows.length !== rows.length)
          throw new Error(
            "Review text derivation did not update every locked candidate."
          );
        return rows.length;
      }
    );
    total += count;
    input.onCommitted?.(count);
    if (count > 0)
      emitRuntimeLog({
        level: "info",
        environment: process.env.APP_ENV ?? null,
        surface: "scheduled",
        operation: "maintenance.review_search_text",
        request_id: input.requestId,
        account_id: input.accountId,
        rows_derived: total,
        message: "review search text committed progress"
      });
    if (count < BATCH_SIZE) break;
  }
  return total;
}
