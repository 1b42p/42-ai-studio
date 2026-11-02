/** Значок вложения по типу содержимого. */
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileVideoIcon,
  type LucideIcon,
} from "lucide-react";

export function isImageType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith("image/");
}

export function attachmentIcon(contentType: string | null): LucideIcon {
  if (contentType === null) return FileIcon;
  const type = contentType.toLowerCase();
  if (type.startsWith("image/")) return FileImageIcon;
  if (type.startsWith("video/")) return FileVideoIcon;
  if (type.startsWith("audio/")) return FileAudioIcon;
  if (type.startsWith("text/")) return FileTextIcon;
  if (type.includes("zip") || type.includes("tar") || type.includes("compress")) {
    return FileArchiveIcon;
  }
  return FileIcon;
}
