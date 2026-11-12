import type { LotInput } from "../engine";

/** Fictional charity and lots only (DEMO.md): no real brands, people or places. */
export const DEMO_EVENT_NAME = "Riverside Reading Rooms — Autumn Auction";

export const DEMO_LOTS: LotInput[] = [
  {
    id: "tea-estate",
    title: "A weekend at Hollowmere tea estate",
    story: "Two nights for two in the planter's cottage, with a dawn walk through the tea rows and breakfast on the veranda.",
    startCents: 200_00,
    incrementCents: 20_00,
  },
  {
    id: "pottery",
    title: "Hand-thrown pottery set",
    story: "Four bowls and a serving jug in ash glaze, made for the auction by a potter who learned to read at our Saturday club.",
    startCents: 60_00,
    incrementCents: 10_00,
  },
  {
    id: "cooking-class",
    title: "A cooking class for six",
    story: "An evening of riverside curries with the chef from the corner café, ingredients and recipes to take home.",
    startCents: 120_00,
    incrementCents: 10_00,
  },
  {
    id: "print",
    title: "Signed print: The Lantern Bridge",
    story: "A limited linocut of the old footbridge at dusk, number 3 of 40, signed by the artist.",
    startCents: 80_00,
    incrementCents: 10_00,
  },
  {
    id: "reading-corner",
    title: "Name the new reading corner",
    story: "Your chosen name on the plaque in the children's corner, for as long as the shelves stand.",
    startCents: 150_00,
    incrementCents: 25_00,
  },
  {
    id: "mystery-box",
    title: "The mystery box",
    story: "Wrapped in brown paper and string. The volunteers promise it is worth opening.",
    startCents: 40_00,
    incrementCents: 5_00,
  },
];
