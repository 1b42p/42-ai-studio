"use client";

import { motion } from "motion/react";

import { useReducedMotionPreference } from "@/hooks/use-reduced-motion";

// Trigonometric results may differ in the last bits between JS engines.
// Quantize every derived SVG attribute, not just the waveform amplitude.
function svgNumber(value: number) {
  return Number(value.toFixed(3));
}

/** Original, resolution-independent frames for the miniature motion essay. */
export function CreationFrame({ scene = 0 }: { scene?: number }) {
  return (
    <svg viewBox="0 0 600 400" fill="none" className="size-full" aria-hidden="true">
      <rect width="600" height="400" className={scene === 1 ? "fill-primary" : "fill-background"} />
      {scene === 0 ? (
        <>
          <circle cx="466" cy="177" r="157" className="fill-primary" />
          <circle cx="466" cy="177" r="114" className="stroke-primary-foreground/50" />
          <circle cx="466" cy="177" r="68" className="fill-background" />
          <path d="M0 298H600M80 0V400" className="stroke-foreground/15" />
          <text x="35" y="166" className="fill-foreground font-heading text-[76px] font-semibold tracking-[-5px]">Всё начинается</text>
          <text x="35" y="244" className="fill-foreground font-heading text-[76px] font-semibold tracking-[-5px]">с импульса.</text>
          <path d="M38 348H212M194 332L212 348L194 364" className="stroke-primary" strokeWidth="4" />
          <text x="556" y="363" textAnchor="end" className="fill-muted-foreground text-[16px]">ДВИЖЕНИЕ / 01</text>
        </>
      ) : scene === 1 ? (
        <>
          {Array.from({ length: 9 }, (_, i) => (
            <path key={i} d={`M${330 + i * 27} -60L${150 + i * 27} 460`} className="stroke-primary-foreground/30" strokeWidth="12" />
          ))}
          <text x="34" y="99" className="fill-primary-foreground font-heading text-[83px] font-semibold tracking-[-5px]">Ловит ритм.</text>
          <path d="M35 203H153L218 137L278 270L347 179L411 203H565" className="stroke-primary-foreground" strokeWidth="12" />
          <circle cx="278" cy="270" r="22" className="fill-primary-foreground" />
          <text x="35" y="364" className="fill-primary-foreground text-[16px]">НЕ ПРОСТО КАДРЫ. ИСТОРИЯ.</text>
        </>
      ) : (
        <>
          <rect x="366" y="-65" width="240" height="540" rx="120" transform="rotate(28 486 200)" className="fill-primary" />
          <path d="M390 0L190 400M460 0L260 400" className="stroke-foreground/20" />
          <circle cx="449" cy="292" r="62" className="fill-foreground" />
          <path d="M416 292H481M462 273L481 292L462 311" className="stroke-background" strokeWidth="5" />
          <text x="34" y="107" className="fill-foreground font-heading text-[86px] font-semibold tracking-[-5px]">И становится</text>
          <text x="34" y="192" className="fill-foreground font-heading text-[86px] font-semibold tracking-[-5px]">историей.</text>
          <text x="35" y="362" className="fill-muted-foreground text-[16px]">ВАША ИДЕЯ. В ДВИЖЕНИИ.</text>
        </>
      )}
    </svg>
  );
}

const positions = [
  [{ x: 660, y: 49, scale: 0.65, rotate: -8 }, { x: 751, y: 159, scale: 0.56, rotate: 7 }, { x: 677, y: 293, scale: 0.48, rotate: -4 }],
  [{ x: 34, y: 164, scale: 0.64, rotate: -6 }, { x: 410, y: 138, scale: 0.65, rotate: 0 }, { x: 801, y: 164, scale: 0.64, rotate: 6 }],
  [{ x: 93, y: 60, scale: 1.05, rotate: 0 }, { x: 790, y: 61, scale: 0.48, rotate: 5 }, { x: 843, y: 217, scale: 0.44, rotate: -5 }],
  [{ x: 199, y: 29, scale: 1.34, rotate: 0 }, { x: 1120, y: 75, scale: 0.44, rotate: 10 }, { x: -305, y: 230, scale: 0.44, rotate: -10 }],
];

export function CreationArtwork({ stage, scene }: { stage: number; scene: number }) {
  const reduced = useReducedMotionPreference();
  const transition = { duration: reduced ? 0 : 0.75, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <>
      <svg viewBox="0 0 1200 590" className="hidden h-full w-full md:block" role="img" aria-label={["Идея и первые эскизы ролика", "Три разных кадра одной истории", "Графика, звуковая дорожка и субтитры", "Готовая анимационная композиция"][stage]}>
        <path d="M35 35H1165V555H35ZM0 295H1200M600 0V590" fill="none" className="stroke-foreground/10" strokeDasharray="4 7" />
        <motion.g initial={false} animate={{ opacity: stage === 0 ? 1 : 0, x: stage === 0 ? 0 : -70 }} transition={transition}>
          <text x="67" y="137" className="fill-primary text-[70px]">«</text>
          <text x="67" y="214" className="fill-foreground font-heading text-[60px] font-medium tracking-[-3px]">
            <tspan x="67">Сделай ролик</tspan>
            <tspan x="67" dy="68">о том, как идея</tspan>
            <tspan x="67" dy="68">оживает.</tspan>
          </text>
          <text x="70" y="459" className="fill-muted-foreground text-[19px]">Крупный текст. Геометрия. Чувство ритма.</text>
        </motion.g>
        <motion.g initial={false} animate={{ opacity: stage === 1 ? 1 : 0 }} transition={transition}>
          <text x="42" y="81" className="fill-foreground font-heading text-[48px] font-medium tracking-[-2px]">Одна идея. Три ракурса.</text>
          <path d="M104 495H1094M1074 480L1094 495L1074 510" fill="none" className="stroke-primary" strokeWidth="2" />
        </motion.g>
        {[0, 1, 2].map((index) => (
          <motion.g key={index} style={{ originX: 0, originY: 0 }} initial={false} animate={positions[stage][index]} transition={{ ...transition, delay: reduced ? 0 : index * 0.07 }}>
            <svg width="600" height="400" className="overflow-visible">
              <rect width="600" height="400" className="fill-background stroke-border" strokeWidth="2" />
              <motion.g key={stage === 3 && index === 0 ? scene : "frame"} initial={false} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.45 }}>
                <CreationFrame scene={stage === 3 && index === 0 ? scene : index} />
              </motion.g>
            </svg>
          </motion.g>
        ))}
        <motion.g initial={false} animate={{ opacity: stage === 2 ? 1 : 0, y: stage === 2 ? 0 : 25 }} transition={transition}>
          <rect x="162" y="365" width="483" height="51" rx="3" className="fill-foreground" />
          <text x="403" y="399" textAnchor="middle" className="fill-background text-[24px] font-medium">Всё начинается с импульса.</text>
          <text x="95" y="530" className="fill-muted-foreground text-[17px]">ГОЛОС + РИТМ</text>
          {Array.from({ length: 78 }, (_, i) => {
            const height = 8 + Math.abs(Math.sin(i * 1.71) * Math.cos(i * 0.3)) * 53;
            return <rect key={i} x={290 + i * 10} y={svgNumber(514 - height / 2)} width="4" height={svgNumber(height)} rx="2" className="fill-primary" />;
          })}
        </motion.g>
      </svg>
      <svg viewBox="0 0 390 440" className="h-full w-full md:hidden" role="img" aria-label={["Идея превращается в эскизы", "Три разных кадра одной истории", "Графика со звуком и субтитрами", "Готовая композиция"][stage]}>
        <path d="M18 18H372V422H18ZM195 0V440" fill="none" className="stroke-foreground/10" strokeDasharray="4 6" />
        {stage === 0 ? (
          <>
            <text x="27" y="69" className="fill-primary text-[45px]">«</text>
            <text x="27" y="107" className="fill-foreground font-heading text-[35px] font-medium tracking-[-1.5px]">
              <tspan x="27">Сделай ролик</tspan>
              <tspan x="27" dy="41">о том, как идея</tspan>
              <tspan x="27" dy="41">оживает.</tspan>
            </text>
            <svg x="69" y="235" width="290" height="194" className="-rotate-6"><CreationFrame /></svg>
          </>
        ) : stage === 1 ? (
          <>
            <svg x="15" y="22" width="244" height="163" className="-rotate-6"><CreationFrame /></svg>
            <svg x="123" y="145" width="244" height="163" className="rotate-6"><CreationFrame scene={1} /></svg>
            <svg x="24" y="264" width="244" height="163" className="-rotate-3"><CreationFrame scene={2} /></svg>
          </>
        ) : (
          <>
            <svg x="18" y={stage === 2 ? 45 : 78} width="354" height="236"><CreationFrame scene={stage === 3 ? scene : 0} /></svg>
            {stage === 2 ? (
              <>
                <rect x="42" y="235" width="306" height="31" className="fill-foreground" />
                <text x="195" y="256" textAnchor="middle" className="fill-background text-[15px]">Всё начинается с импульса.</text>
                {Array.from({ length: 35 }, (_, i) => {
                  const amplitude = Math.abs(Math.sin(i * 1.7));
                  return <rect key={i} x={26 + i * 10} y={svgNumber(345 - amplitude * 25)} width="4" height={svgNumber(10 + amplitude * 50)} rx="2" className="fill-primary" />;
                })}
              </>
            ) : <text x="195" y="369" textAnchor="middle" className="fill-muted-foreground text-[16px]">Ваша идея. В движении.</text>}
          </>
        )}
      </svg>
    </>
  );
}
