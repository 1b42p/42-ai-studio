const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e",
  ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ы: "y", э: "e", ю: "yu", я: "ya", ъ: "", ь: "",
};

export function mcpSlug(name: string): string {
  const base = Array.from(name.toLowerCase(), (character) =>
    CYRILLIC[character] ?? (/[a-z0-9]/.test(character) ? character : "-"),
  )
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `mcp-${base || "server"}`;
}
