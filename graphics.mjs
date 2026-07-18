// graphics.mjs
//
// Serves the event images: goals and odds swings

import fs from "fs";

const GOAL_IMAGE = fs.readFileSync(new URL("assets/goal.jpg", import.meta.url));
const ODDS_IMAGE = fs.readFileSync(new URL("assets/shift.jpg", import.meta.url));

export function renderEventCard(event) {
  if (event.type === "goal") return GOAL_IMAGE;
  if (event.type === "odds_swing") return ODDS_IMAGE;
  return null; // red_card, yellow_card — text only
}
