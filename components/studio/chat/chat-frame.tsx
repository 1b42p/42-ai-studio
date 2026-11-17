import type { ReactNode } from "react";

/**
 * Оболочка экрана чата: растягивает беседу на область контента под шапкой
 * приложения и компенсирует отступы компоновки.
 */
export function ChatFrame({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-3 -my-3 h-[calc(100dvh-4rem)] min-w-0 md:-mx-6 md:-my-6 md:h-dvh lg:-mx-8 lg:-my-8">
      {children}
    </div>
  );
}
