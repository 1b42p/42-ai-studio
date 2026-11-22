"use client";

import {
  EveAgentStore, conversationReducer,
  type ConversationState, type EveAgentStoreInit, type InputResponse, type SendTurnOptions,
} from "eve/client";
import type { UserContent } from "ai";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { sendAcknowledged } from "./send-acknowledged";

type Options = Pick<EveAgentStoreInit<ConversationState>,
  "headers" | "initialEvents" | "initialSession" | "followSubagents"> & { resume?: boolean };

/**
 * Thin React binding over the public native store. Unlike the SDK's send
 * helper, this UI command resolves on delivery ACK, not on turn completion.
 * The store continues all streaming, steering, projection and child following.
 */
export function useStudioAgent(options: Options = {}) {
  const [store] = useState(() => new EveAgentStore({
    ...options, reducer: conversationReducer,
  }));
  const [resuming, setResuming] = useState(options.resume ?? false);
  const initialResume = useRef(options.resume ?? false);
  const mounted = useRef(false);
  const snapshot = useSyncExternalStore(
    useMemo(() => (notify: () => void) => store.subscribe(notify), [store]),
    () => store.snapshot,
    () => store.snapshot,
  );
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const timer = initialResume.current ? setTimeout(() => {
      const finish = () => { if (active) setResuming(false); };
      void store.resume().then(finish, finish);
    }, 0) : undefined;
    return () => {
      active = false;
      mounted.current = false;
      clearTimeout(timer);
      // Like the native binding, tolerate Strict Mode's setup/cleanup replay.
      // Public reset only detaches local work; it does not cancel durable work.
      queueMicrotask(() => { if (!mounted.current) store.reset(); });
    };
  }, [store]);
  const commands = useMemo(() => ({
    send: (message: string | UserContent, settings?: SendTurnOptions) =>
      sendAcknowledged(store, { ...settings, message }),
    respond: (inputResponses: readonly InputResponse[], settings?: SendTurnOptions) =>
      sendAcknowledged(store, { ...settings, inputResponses }),
    cancel: () => store.cancel(),
    resume: () => store.resume(),
    prewarm: () => store.prewarm(),
    reset: () => store.reset(),
  }), [store]);
  return {
    ...snapshot,
    status: resuming && snapshot.status === "ready" ? "resuming" as const : snapshot.status,
    ...commands,
  };
}
