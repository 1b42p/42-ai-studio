import { dirname } from "node:path";

import recordings from "./recordings.json";

export type DocumentName = keyof typeof recordings;

export function documentPaths(name: DocumentName) {
  const input = `/workspace/.eve/attachments/ab12/${name}`;
  const output = `/workspace/source/${name.replace(".", "-")}`;
  return { input, output };
}

export function documentImages(name: DocumentName) {
  const { output } = documentPaths(name);
  return Object.entries(recordings[name].images).map(([relative, image]) => ({
    path: `${output}/${relative}`,
    ...image,
  }));
}

export async function seedDocumentImages(filesystem: {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, bytes: Buffer): Promise<unknown>;
}) {
  for (const name of Object.keys(recordings) as DocumentName[]) {
    for (const image of documentImages(name)) {
      await filesystem.mkdir(dirname(image.path), { recursive: true });
      await filesystem.writeFile(image.path, Buffer.from(image.base64, "base64"));
    }
  }
}
