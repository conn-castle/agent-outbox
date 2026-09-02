export type HumanMutationOperation = "answer" | "bulk-answer" | "undo";

export type HumanMutationFailure = {
  ok: false;
  operation: HumanMutationOperation;
  code: string;
  message: string;
  inputItemIds: string[];
  failedActionKind?: "file_upload";
};

export type HumanAnswerMutationSuccess = {
  ok: true;
  operation: "answer";
  message: string;
  inputItemIds: [string];
  undo: {
    inputItemId: string;
    callerId: string;
    outputResultId: string;
  };
};

export type HumanBulkMutationSuccess = {
  ok: true;
  operation: "bulk-answer";
  message: string;
  inputItemIds: string[];
  answered: number;
  failed: number;
};

export type HumanUndoMutationSuccess = {
  ok: true;
  operation: "undo";
  message: string;
  inputItemIds: [string];
};

export type HumanMutationResult =
  | HumanMutationFailure
  | HumanAnswerMutationSuccess
  | HumanBulkMutationSuccess
  | HumanUndoMutationSuccess;
