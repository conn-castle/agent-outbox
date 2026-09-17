"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { installImmediateActionFeedback } from "./immediate-action-feedback";

installImmediateActionFeedback();

export type AppMutationStatus =
  "queued" | "syncing" | "succeeded" | "indeterminate";

export type AppMutationRecord = {
  id: string;
  scope: string;
  status: AppMutationStatus;
  optimistic: unknown;
  result?: unknown;
};

type EnqueueMutation<TResult> = {
  scope: string;
  optimistic: unknown;
  execute: () => Promise<TResult>;
  refreshOnSuccess?: boolean;
  reconcileEarlier?: (
    earlier: AppMutationRecord,
    result: TResult
  ) => unknown | null;
  onSuccess?: (result: TResult, mutationId: string) => void;
  onIndeterminate?: (error: unknown, mutationId: string) => void;
  onError?: (error: unknown, mutationId: string) => void;
};

type AppActionContextValue = {
  mutations: AppMutationRecord[];
  enqueue: <TResult>(mutation: EnqueueMutation<TResult>) => string;
  dismiss: (mutationId: string) => void;
};

const AppActionContext = createContext<AppActionContextValue | null>(null);

export function AppActionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [mutations, setMutations] = useState<AppMutationRecord[]>([]);
  const mutationsRef = useRef<AppMutationRecord[]>([]);
  const syncTail = useRef(Promise.resolve());
  const nextId = useRef(0);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (
        mutationsRef.current.some(
          (mutation) =>
            mutation.status === "queued" || mutation.status === "syncing"
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const dismiss = useCallback((mutationId: string) => {
    const next = mutationsRef.current.filter(
      (mutation) => mutation.id !== mutationId
    );
    mutationsRef.current = next;
    setMutations(next);
  }, []);

  const markSettled = useCallback(
    (
      mutationId: string,
      status: "succeeded" | "indeterminate",
      result?: unknown,
      reconcileEarlier?: (earlier: AppMutationRecord) => unknown | null
    ) => {
      const targetIndex = mutationsRef.current.findIndex(
        (record) => record.id === mutationId
      );
      const succeeded = mutationsRef.current.flatMap(
        (record, index): AppMutationRecord[] => {
          if (record.id === mutationId) return [{ ...record, status, result }];
          if (index < targetIndex && reconcileEarlier) {
            const optimistic = reconcileEarlier(record);
            return optimistic === null ? [] : [{ ...record, optimistic }];
          }
          return [record];
        }
      );
      mutationsRef.current = succeeded;
      setMutations(succeeded);
    },
    []
  );

  const enqueue = useCallback(
    <TResult,>(mutation: EnqueueMutation<TResult>) => {
      const mutationId = `mutation-${Date.now()}-${++nextId.current}`;
      const queued: AppMutationRecord[] = [
        ...mutationsRef.current,
        {
          id: mutationId,
          scope: mutation.scope,
          status: "queued",
          optimistic: mutation.optimistic
        }
      ];
      mutationsRef.current = queued;
      window.setTimeout(() => setMutations(mutationsRef.current), 0);

      const synchronize = async () => {
        const syncing: AppMutationRecord[] = mutationsRef.current.map(
          (record) =>
            record.id === mutationId ? { ...record, status: "syncing" } : record
        );
        mutationsRef.current = syncing;
        setMutations(syncing);
        try {
          const result = await mutation.execute();
          markSettled(
            mutationId,
            "succeeded",
            result,
            mutation.reconcileEarlier
              ? (earlier) =>
                  earlier.scope === mutation.scope
                    ? mutation.reconcileEarlier!(earlier, result)
                    : earlier.optimistic
              : undefined
          );
          mutation.onSuccess?.(result, mutationId);
          if (mutation.refreshOnSuccess) {
            startTransition(() => router.refresh());
          }
        } catch (error) {
          if (isIndeterminateClientTimeout(error)) {
            markSettled(mutationId, "indeterminate");
            mutation.onIndeterminate?.(error, mutationId);
            startTransition(() => router.refresh());
            return;
          }
          dismiss(mutationId);
          mutation.onError?.(error, mutationId);
        }
      };

      syncTail.current = syncTail.current.then(synchronize, synchronize);
      return mutationId;
    },
    [dismiss, markSettled, router]
  );

  const value = useMemo(
    () => ({ mutations, enqueue, dismiss }),
    [dismiss, enqueue, mutations]
  );

  return (
    <AppActionContext.Provider value={value}>
      {children}
    </AppActionContext.Provider>
  );
}

export function useAppActions() {
  const context = useContext(AppActionContext);
  if (!context) {
    throw new Error("useAppActions must be used within AppActionProvider.");
  }
  return context;
}

function isIndeterminateClientTimeout(error: unknown) {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "TimeoutError" || error.name === "AbortError";
  }
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}
