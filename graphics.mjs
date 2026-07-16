// graphics.mjs
//
// Serves the event images: your goal-net photo for goals, your odds-chart
// photo for market moves. Cards (red/yellow) get no image — plain text only.

import fs from "fs";

const GOAL_IMAGE = fs.readFileSync(new URL("assets/goal.jpg", import.meta.url));
const ODDS_IMAGE = fs.readFileSync(new URL("assets/shift.jpg", import.meta.url));

export function renderEventCard(event) {
  if (event.type === "goal") return GOAL_IMAGE;
  if (event.type === "odds_swing") return ODDS_IMAGE;
  return null; // red_card, yellow_card — text only
}
