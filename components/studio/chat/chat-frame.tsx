import type { ReactNode } from "react";

/**
 * Оболочка экрана чата: растягивает беседу на область контента под шапкой
 * приложения и компенсирует отступы компоновки.
 */
export function ChatFrame({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 -my-4 h-[calc(100dvh-3.5rem)] md:-mx-6 md:-my-6 md:h-dvh">
      {children}
    </div>
  );
}
