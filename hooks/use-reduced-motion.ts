"use client";

import { useEffect, useState } from "react";

/** A static first render keeps server HTML and hydration identical. */
export function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(true);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  return reduced;
}
