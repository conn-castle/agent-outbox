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

export type AppMutationStatus = "queued" | "syncing";

// A mutation the server has not settled yet. It leaves the list when it does.
export type AppMutationRecord = {
  id: string;
  scope: string;
  status: AppMutationStatus;
  optimistic: unknown;
};

type EnqueueMutation<TResult> = {
  scope: string;
  optimistic: unknown;
  // Resolves or rejects with a definite outcome; retrying is its concern.
  execute: () => Promise<TResult>;
  refreshOnSettle?: boolean;
  // Each runs in the same update as the record's removal, so what it stores
  // replaces the optimistic state without an intermediate render.
  onSuccess?: (result: TResult) => void;
  onError?: (error: unknown) => void;
};

type AppActionContextValue = {
  mutations: AppMutationRecord[];
  // Includes records enqueued since the last render commit.
  currentMutations: () => AppMutationRecord[];
  enqueue: <TResult>(mutation: EnqueueMutation<TResult>) => string;
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

  const currentMutations = useCallback(() => mutationsRef.current, []);

  const dismiss = useCallback((mutationId: string) => {
    const next = mutationsRef.current.filter(
      (mutation) => mutation.id !== mutationId
    );
    mutationsRef.current = next;
    setMutations(next);
  }, []);

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
        let settle: () => void;
        try {
          const result = await mutation.execute();
          settle = () => mutation.onSuccess?.(result);
        } catch (error) {
          settle = () => mutation.onError?.(error);
        }
        dismiss(mutationId);
        try {
          // Outside the request's try: a handler that throws must not turn a
          // committed mutation into a reported failure.
          settle();
        } finally {
          if (mutation.refreshOnSettle) {
            startTransition(() => router.refresh());
          }
        }
      };

      syncTail.current = syncTail.current.then(synchronize, synchronize);
      return mutationId;
    },
    [dismiss, router]
  );

  const value = useMemo(
    () => ({ mutations, currentMutations, enqueue }),
    [currentMutations, enqueue, mutations]
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
