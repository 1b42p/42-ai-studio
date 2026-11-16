import { defineInstrumentation } from "eve/instrumentation";

import { recordModelUsage } from "@/lib/usage/model";

export default defineInstrumentation({
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
  events: {
    "model.call.completed": recordModelUsage,
  },
});
