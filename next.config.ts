import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { withEve } from "eve/next";

import { loadConfig, readNextDistDir } from "./lib/config";

/**
 * Проверка конфигурации вызывается при каждом `next dev` и `next start`:
 * при отсутствующей или некорректной переменной сервер не стартует.
 * При `next build` проверка пропускается — сборка секретов не требует.
 */
const distDir = readNextDistDir();

const nextConfig: NextConfig = {
  distDir,
  // Встроенный блок правил Next.js для агентов англоязычный, и `next dev`
  // перезаписывает им AGENTS.md. Правила переведены на русский, поэтому
  // автогенерация блока отключена.
  agentRules: false,
  // Next.js дописывает пути типов своего distDir в include tsconfig. Экземпляры
  // тестов со своим distDir работают с отдельным tsconfig, который создаёт
  // `startApp` (`<distDir>.tsconfig.json`, расширяет корневой), иначе каждый
  // прогон тестов менял бы tsconfig.json в репозитории.
  typescript: distDir === ".next" ? undefined : { tsconfigPath: `${distDir}.tsconfig.json` },
  // Библиотека telegram-login.js общается с Telegram через popup; при
  // `same-origin` этот обмен блокируется.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" }],
      },
    ];
  },
  logging: {
    incomingRequests: {
      // Тела и токены входа не должны попадать в журнал разработки.
      ignore: [/\/api\/auth\//, /\/api\/mcp-proxy\//, /\/api\/admin\/keys/],
    },
  },
};

export default withEve((phase) => {
  if (phase !== PHASE_PRODUCTION_BUILD) {
    loadConfig();
  }
  return nextConfig;
});
