export type SculptureComposition = "hero" | "finale";

export const sculptureCompositions = {
  hero: {
    asset: "kinetic",
    root: "Light-Cut",
    width: 1920,
    height: 1080,
    label: "Кинетическая скульптура из оранжевых кинолент",
    defer: false,
  },
  finale: {
    asset: "finale",
    root: "Final-Cut",
    width: 1440,
    height: 1200,
    label: "Объёмная композиция завершённого кинокадра",
    defer: true,
  },
} as const;
