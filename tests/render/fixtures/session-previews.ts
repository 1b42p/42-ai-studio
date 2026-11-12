import type { SessionListItem } from "@/components/studio/sessions/session-list";

export const previewMedia = {
  landscape: "00000018-0000-4000-8000-000000000001",
  portrait: "00000018-0000-4000-8000-000000000002",
  missing: "00000018-0000-4000-8000-000000000003",
  retry: "00000018-0000-4000-8000-000000000004",
} as const;

export const previewSessions: readonly SessionListItem[] = [
  { id: "landscape", title: "Горизонтальный ролик", preview: { mediaId: previewMedia.landscape } },
  { id: "portrait", title: "Вертикальный ролик", preview: { mediaId: previewMedia.portrait } },
  { id: "empty", title: "Без превью", preview: null },
  { id: "missing", title: "Недоступное превью", preview: { mediaId: previewMedia.missing } },
  { id: "long", title: "Д".repeat(200), preview: null },
].map((item) => ({
  ...item,
  createdAt: "2026-11-01T11:05:00.000Z",
  updatedAt: "2026-11-01T11:05:00.000Z",
}));
