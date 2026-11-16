import { AppFrame } from "@/components/studio/app-frame";
import { navItemsFor } from "@/components/studio/nav";
import { getCurrentUser } from "@/lib/auth/guard";
import { toPublicUser } from "@/lib/auth/user";

/**
 * Оболочка группы: показывает пользователя, если он есть, и передаёт в
 * оболочку уже отфильтрованные пункты навигации. Саму проверку входа делает
 * страница своим путём: layout не знает pathname, а Next.js не перерисовывает
 * его при навигации, поэтому проверка живёт у данных.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const publicUser = user === null ? null : toPublicUser(user);
  const navItems = navItemsFor(user?.isOperator === true);

  return (
    <AppFrame navItems={navItems} user={publicUser}>
      {children}
    </AppFrame>
  );
}
