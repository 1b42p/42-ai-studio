export async function register(): Promise<void> {
  // Next.js статически исключает Node-модуль из сборки для Edge.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBashJobWatchdog } = await import("./lib/sandbox/job-watchdog");
    startBashJobWatchdog();
  }
}
