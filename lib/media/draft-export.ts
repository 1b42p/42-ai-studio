export const draftExportProjectPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const draftExportFilePattern = /^out\/[a-z0-9-]+-draft-v[1-9][0-9]*\.mp4$/;

export function draftExportFinalPath(draft: string): string {
  return draft.replace(/-draft-(v[1-9][0-9]*\.mp4)$/, "-$1");
}

export function draftExportFileGroup(callId: string): string {
  return `export:${callId}`;
}
