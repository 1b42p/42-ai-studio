import { conversationReducer, type ConversationState } from "eve/react";
import { event } from "./events";

export function authorizationConversation(outcome?: "authorized" | "declined" | "failed" | "timed-out", reason?: string) {
  const attempt = {
    attemptId: "oauth_attempt", name: "user_mcp", description: "Авторизация",
    authorization: { displayName: "Личный сервер", url: "https://login.example.com/authorize" },
    principal: { type: "user", id: "owner", issuer: "studio" },
    sequence: 0, stepIndex: 0, turnId: "turn_0",
  };
  const events = [
    event("session.started", {}),
    event("turn.started", { turnId: "turn_0", sequence: 0 }),
    event("authorization.required", { ...attempt, awaitsCallback: true }),
  ];
  if (outcome) events.push(event("authorization.completed", { ...attempt, outcome, reason }));
  return {
    data: events.reduce<ConversationState>(
      (state, item) => conversationReducer.reduce(state, item),
      conversationReducer.initial(),
    ),
    events,
    status: "streaming" as const,
  };
}
