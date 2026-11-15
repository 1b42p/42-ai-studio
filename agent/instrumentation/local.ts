import { localTraces } from "eve/instrumentation/otel";

export default localTraces({
  exportPolicy: {
    attribute: ({ key }) => ({
      emit: key !== "gen_ai.system_instructions" && key !== "ai.prompt",
    }),
  },
});
