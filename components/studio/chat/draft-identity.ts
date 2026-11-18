"use client";

import { createContext } from "react";

/** Authenticated server identity supplied by AppFrame, never guessed in the composer. */
export const ChatDraftIdentityContext = createContext<string | null>(null);
