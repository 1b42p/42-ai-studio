import type { Metadata } from "next";

import { LandingPage } from "@/components/studio/landing/landing-page";
import { examples } from "@/lib/examples";

export const metadata: Metadata = {
  title: "42 AI Studio — видео из одной просьбы",
  description:
    "Опишите ролик словами — агент сам напишет анимацию, озвучит, добавит субтитры и пришлёт готовое видео.",
};

export default function HomePage() {
  return <LandingPage examples={examples} />;
}
