// HTTP-тесты не должны ходить во внешние сервисы. Каталог моделей AI Gateway
// отвечает мгновенным отказом: иначе первая сессия ждёт сетевого таймаута,
// пока eve ищет в каталоге модель встроенного субагента самомодификации.
const originalFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://ai-gateway.vercel.sh/")) {
    return Promise.reject(new Error("AI Gateway недоступен в HTTP-тестах"));
  }
  return originalFetch(input, init);
};
