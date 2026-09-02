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
import { Toaster } from "sonner";

export type AppMutationStatus = "queued" | "syncing" | "succeeded";

export type AppMutationRecord = {
  id: string;
  scope: string;
  status: AppMutationStatus;
  optimistic: unknown;
};

type EnqueueMutation<TResult> = {
  scope: string;
  optimistic: unknown;
  execute: () => Promise<TResult>;
  refreshOnSuccess?: boolean;
  onSuccess?: (result: TResult, mutationId: string) => void;
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
          const succeeded: AppMutationRecord[] = mutationsRef.current.map(
            (record) =>
              record.id === mutationId
                ? { ...record, status: "succeeded" }
                : record
          );
          mutationsRef.current = succeeded;
          setMutations(succeeded);
          mutation.onSuccess?.(result, mutationId);
          if (mutation.refreshOnSuccess) {
            startTransition(() => router.refresh());
          }
        } catch (error) {
          dismiss(mutationId);
          mutation.onError?.(error, mutationId);
        }
      };

      syncTail.current = syncTail.current.then(synchronize, synchronize);
      return mutationId;
    },
    [dismiss, router]
  );

  const value = useMemo(
    () => ({ mutations, enqueue, dismiss }),
    [dismiss, enqueue, mutations]
  );

  return (
    <AppActionContext.Provider value={value}>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
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
