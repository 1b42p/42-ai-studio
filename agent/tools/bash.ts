import { defineTool } from "eve/tools";
import { bash } from "eve/tools/bash";
import { loadConfig } from "@/lib/config";
import { isEvalPrincipal } from "../lib/eval-auth";
import {
  beforeNativeVideoEvalCommand, afterNativeVideoEvalCommand,
  abortNativeVideoEvalCommand, nativeVideoEvalCommand,
} from "../lib/video-eval-native";

export default defineTool({
  ...bash,
  async *execute(input, ctx) {
    const config = loadConfig();
    if (!config.appVideoEvalSandbox) {
      const output = await bash.execute(input, ctx);
      if (Symbol.asyncIterator in output) yield* output;
      else yield output;
      return;
    }
    const initiator = ctx.session.auth.initiator;
    if (!isEvalPrincipal(initiator) || initiator?.attributes.videoEval !== "1" || !config.eveEvalAuthToken) {
      throw new Error("Native video eval requires an authenticated eval session");
    }
    const sandbox = await ctx.getSandbox();
    const observation = await beforeNativeVideoEvalCommand(sandbox);
    let settled = false;
    try {
      const execution = await bash.execute({ command: nativeVideoEvalCommand(observation, input.command) }, ctx);
      let last;
      if (Symbol.asyncIterator in execution) {
        for await (const output of execution) { last = output; yield output; }
        if (!last) throw new Error("Native bash returned no final result");
      } else last = execution;
      const output = await afterNativeVideoEvalCommand(sandbox, observation, last, config.eveEvalAuthToken);
      settled = true;
      yield output;
    } finally {
      if (!settled) {
        // Public handles always compose the turn's abort signal; they cannot be
        // detached. The guest guard handles cancellation, and /proc recovery
        // handles runtime crashes or a guard killed before its EXIT trap.
        try { await abortNativeVideoEvalCommand(sandbox, observation); }
        catch (error) { if (!ctx.abortSignal.aborted) throw error; }
      }
    }
  },
});
