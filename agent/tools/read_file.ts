import { defineTool, type ToolDefinition } from "eve/tools";
import { readFile, READ_FILE_OUTPUT_SCHEMA, type ReadFileToolInput, type ReadFileToolOutput } from "eve/tools/read_file";

import { publishReadFileImage, type ReadFileMediaOutput } from "../lib/read-file-media";

const originalSchema = READ_FILE_OUTPUT_SCHEMA["~standard"].jsonSchema.output({ target: "draft-2020-12" });

export default defineTool<ReadFileToolInput, ReadFileMediaOutput>({
  ...readFile,
  // Расширяем схему eve, не дублируя её поля и ограничения.
  outputSchema: {
    ...originalSchema,
    properties: {
      ...originalSchema.properties as object,
      media: {
        type: "object",
        properties: { imageId: { type: "string", format: "uuid" } },
        required: ["imageId"],
        additionalProperties: false,
      },
    },
  } as ToolDefinition<ReadFileToolInput, ReadFileMediaOutput>["outputSchema"],
  async execute(input, ctx) {
    const output = await readFile.execute(input, ctx) as ReadFileToolOutput;
    return publishReadFileImage(output, ctx);
  },
});
