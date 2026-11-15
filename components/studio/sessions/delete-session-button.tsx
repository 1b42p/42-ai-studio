"use client";

import { Trash2Icon } from "lucide-react";
import type { RefObject } from "react";

import { Button } from "@/components/ui/button";

export function DeleteSessionButton({
  title,
  onClick,
  buttonRef,
}: {
  title: string;
  onClick: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Button
      aria-label={`Удалить сессию «${title}»`}
      className="shrink-0"
      onClick={onClick}
      ref={buttonRef}
      size="icon"
      type="button"
      variant="ghost"
    >
      <Trash2Icon />
    </Button>
  );
}
