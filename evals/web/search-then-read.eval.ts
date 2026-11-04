import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";
import { SOURCE_URLS, assertWebOnly, blockedRead, readStub, webSession } from "./fixtures";

// Выдержки из страниц SOURCE_URLS, прочитанных 2026-11-04; сеть при оценке не используется.
const subjects = [
  {
    title: "Walking for health - NHS",
    snippet: "Walking briskly can help you build stamina, burn excess calories and make your heart healthier. A brisk 10-minute daily walk has lots of health benefits and counts towards your 150 minutes of weekly exercise.",
    content: `# Walking for health

Walking is simple, free and one of the easiest ways to get more active, lose weight and become healthier.

Sometimes overlooked as a form of exercise, walking briskly can help you build stamina, burn excess calories and make your heart healthier.

You do not have to walk for hours. A brisk 10-minute daily walk has lots of health benefits and counts towards your 150 minutes of weekly exercise, as recommended in the physical activity guidelines for adults aged 19 to 64.

## Before you start

Any shoes or trainers that are comfortable, provide adequate support and do not cause blisters will do.

## How do I know if I'm walking fast enough?

A brisk walk is about 3 miles an hour, which is faster than a stroll.

You can tell you're walking briskly if you can still talk but cannot sing the words to a song.

## What if I'm not very active?

If you're not very active but are able to walk, increase your walking distance gradually.

## Staying motivated

### Make it a habit

The easiest way to walk more is to make walking a habit.

Think of ways to include walking in your daily routine.

Examples include:
- walking part of your journey to work
- walking to the shops
- using the stairs instead of the lift
- leaving the car behind for short journeys
- walking the kids to school
- doing a regular walk with a friend
- going for a stroll with family or friends after dinner`,
  },
  {
    title: "Physical activity - World Health Organization (WHO)",
    snippet: "Regular physical activity provides significant physical and mental health benefits. Popular ways to be active include walking, cycling, wheeling, sports, active recreation and play. Any amount of physical activity is better than none; all physical activity counts.",
    content: `# Physical activity

26 June 2024

## Key facts

Regular physical activity provides significant physical and mental health benefits.

In adults, physical activity contributes to prevention and management of noncommunicable diseases such as cardiovascular diseases, cancer and diabetes and reduces symptoms of depression and anxiety, enhances brain health, and can improve overall well-being.

## Overview

WHO defines physical activity as any bodily movement produced by skeletal muscles that requires energy expenditure. Physical activity refers to all movement including during leisure time, for transport to get to and from places, or as part of a person's work or domestic activities. Both moderate- and vigorous-intensity physical activity improve health. Popular ways to be active include walking, cycling, wheeling, sports, active recreation and play, and can be done at any level of skill and for enjoyment by everybody.

## Benefits of physical activity and risks of sedentary behaviour and inactivity

Physical inactivity is one of the leading risk factors for noncommunicable diseases mortality. People who are insufficiently active have a 20% to 30% increased risk of death compared to people who are sufficiently active.

Regular physical activity is associated with, in adults and older adults, reduced risk of all-cause mortality, risk of cardiovascular disease mortality, incident hypertension, incident site-specific cancers, incident type-2 diabetes, and falls and improved mental health, cognitive health, sleep and measures of body fat.

## How much physical activity is recommended?

The guidelines highlight that any amount of physical activity is better than none; all physical activity counts; all age groups should limit the amount of time being sedentary; and muscle strengthening benefits everyone.`,
  },
  {
    title: "Benefits of Physical Activity | Physical Activity Basics | CDC",
    snippet: "Regular physical activity can reduce your risk of depression and anxiety and help you sleep better. Getting at least 150 minutes a week of moderate physical activity can put you at a lower risk for heart disease and stroke.",
    content: `# Benefits of Physical Activity

Dec. 4, 2025

## Key points

- Physical activity has many immediate and long-term benefits.
- Physical activity helps you immediately feel better, function better, and sleep better.
- Adults who sit less and do any amount of moderate- to vigorous-intensity physical activity gain some health benefits.

## Immediate benefits

Some benefits of physical activity for brain health happen right after a session of moderate-to-vigorous physical activity. Benefits include improved thinking or cognition for children 6 to 13 and reduced short-term feelings of anxiety for adults. Regular physical activity can help keep your thinking, learning, and judgment skills sharp as you age. It can also reduce your risk of depression and anxiety and help you sleep better.

## Manage your weight

Both eating patterns and physical activity routines play critical roles in weight management. You can gain weight when you consume more calories than the amount of calories you burn.

If you are not physically active, work your way up to 150 minutes a week of moderate-intensity physical activity. This could be dancing or doing yard work. You could meet the goal of 150 minutes a week with 30 minutes a day for 5 days a week, 22 minutes daily, or what works for you.

## Reduce your health risks

### Cardiovascular disease

Heart disease and stroke are two leading causes of death in the United States. Getting at least 150 minutes a week of moderate physical activity can put you at a lower risk for these diseases. You can reduce your risk even further with more physical activity. Regular physical activity can also lower blood pressure and improve your cholesterol levels.

### Type 2 diabetes and metabolic syndrome

Regular physical activity can reduce your risk of developing type 2 diabetes and metabolic syndrome.

### Afraid of getting hurt?

The good news is that moderate physical activity, such as brisk walking, is generally safe for most people.`,
  },
] as const;

export default Array.from({ length: 3 }, () => defineEval({
  description: "Поиск предшествует чтению 1–3 источников, ответ ссылается на прочитанный источник.",
  tags: ["web", "search-then-read"],
  async test(t) {
    const session = await webSession(t, [
      { id: "search", tool: "web_search", outcome: { response: {
        query: "польза прогулок", requestId: "eval-walking",
        results: SOURCE_URLS.map((url, index) => ({ url, host: new URL(url).hostname,
          title: subjects[index].title, snippet: subjects[index].snippet, publishedDate: null, score: 0.9 })),
      } } },
      ...SOURCE_URLS.map((url, index) => readStub(`source-${index}`, url, subjects[index].title, subjects[index].content, "en")),
      blockedRead,
    ]);
    const turn = await session.send("Найди в интернете, чем полезны ежедневные прогулки, и кратко объясни по-русски со ссылками на источники. Видео не нужно.");
    assertWebOnly(t);
    t.calledTool("web_search");
    t.toolOrder(["web_search", "read_page"]);
    const firstSearch = turn.toolCalls.findIndex((call) => call.name === "web_search");
    const firstRead = turn.toolCalls.findIndex((call) => call.name === "read_page");
    t.check(firstSearch >= 0 && firstRead > firstSearch, equals(true)).label("search-before-first-read");
    t.calledTool("read_page", { count: (count) => count >= 1 && count <= 3 });
    const readUrls = turn.toolCalls.filter((call) => call.name === "read_page" && call.status === "completed")
      .map((call) => call.input.url).filter((url): url is string => typeof url === "string");
    t.check(readUrls.some((url) => turn.message?.includes(url)), equals(true)).label("cites-read-source");
  },
}));
