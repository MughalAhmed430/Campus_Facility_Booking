// Labels for values stored in lower case by the API ('meeting_room'), and short
// text helpers shared by the facility pages.

const FACILITY_TYPE_LABELS = {
  classroom: 'Classroom',
  laboratory: 'Laboratory',
  meeting_room: 'Meeting room',
};

/** The facility types in display order: ['classroom', 'laboratory', 'meeting_room']. */
export const FACILITY_TYPES = Object.keys(FACILITY_TYPE_LABELS);

export function facilityTypeLabel(type) {
  return FACILITY_TYPE_LABELS[type] ?? type;
}

/** 3 -> "Floor 3", 0 -> "Ground floor", -1 -> "Basement 1" */
export function floorLabel(floor) {
  if (floor > 0) return `Floor ${floor}`;
  return floor === 0 ? 'Ground floor' : `Basement ${-floor}`;
}

/** "ENG 310": the short label printed on room signs. */
export function roomLabel(facility) {
  return `${facility.building.code} ${facility.roomNumber}`;
}

/** "Engineering Hall · ENG 310 · Floor 3" */
export function locationLabel(facility) {
  return [facility.building.name, roomLabel(facility), floorLabel(facility.floor)].join(' · ');
}

/** { opensAt: '09:00', closesAt: '21:00' } -> "09:00–21:00" */
export function hoursLabel({ opensAt, closesAt }) {
  return `${opensAt}–${closesAt}`;
}

/** The days those hours apply: "Every day", or "Monday to Friday" when closed at weekends. */
export function openDaysLabel({ openWeekends }) {
  return openWeekends ? 'Every day' : 'Monday to Friday';
}

/** pluralize(1, 'facility', 'facilities') -> "1 facility" */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
