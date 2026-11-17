import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export function PublicErrorLoading() {
  return (
    <Empty role="status" className="min-h-svh rounded-none">
      <EmptyHeader>
        <EmptyTitle className="text-2xl">
          <h1>Не удалось открыть страницу</h1>
        </EmptyTitle>
        <EmptyDescription>
          Загружаем экран восстановления. Если соединение прервалось,
          проверьте сеть или вернитесь на главную.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <EmptyDescription>
          <a href="/">На главную</a>
        </EmptyDescription>
      </EmptyContent>
    </Empty>
  );
}
