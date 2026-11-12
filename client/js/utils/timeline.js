// Times of day as minutes, for laying bookings out on a timeline. Times are "HH:MM",
// Korea time, as the API sends them.

/** '09:30' -> 570 */
export function minutesOf(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** 570 -> '09:30' */
export function timeOf(minutes) {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * The stretches of [from, to) (minutes) that no busy item covers, at least `minLength`
 * long. busy: [{ start, end }] in minutes, in any order.
 */
export function freeGaps(from, to, busy, minLength) {
  const gaps = [];
  let cursor = from;
  for (const item of [...busy].sort((a, b) => a.start - b.start)) {
    if (item.start > cursor) gaps.push({ start: cursor, end: Math.min(item.start, to) });
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < to) gaps.push({ start: cursor, end: to });
  return gaps.filter((gap) => gap.end - gap.start >= minLength);
}

/**
 * Puts items side by side where they overlap. Each item ({ start, end } in minutes) goes
 * in the first lane where it overlaps nothing, in the order given, so items given first
 * get the first lane. Returns { lanes: the number of lanes, laneOf: Map item -> lane }.
 */
export function assignLanes(items) {
  const lanes = [];
  const laneOf = new Map();
  for (const item of items) {
    let lane = lanes.findIndex((placed) => placed.every((other) => other.end <= item.start || other.start >= item.end));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push(item);
    laneOf.set(item, lane);
  }
  return { lanes: Math.max(lanes.length, 1), laneOf };
}

/** Sets CSS custom properties on an element: setVars(el, { '--start': 60 }). */
export function setVars(element, vars) {
  for (const [name, value] of Object.entries(vars)) element.style.setProperty(name, String(value));
  return element;
}
