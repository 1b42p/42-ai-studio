/** Общий выход для меню пользователя и страницы настроек. Ошибку показывает вызывающий UI. */
export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("Не удалось выйти. Попробуйте ещё раз.");
  window.location.assign("/login");
}
