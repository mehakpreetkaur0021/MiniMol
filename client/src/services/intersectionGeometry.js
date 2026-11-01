export const INTERSECTION_GEOMETRY = Object.freeze({
  viewBoxSize: 1000,
  roadStart: 350,
  roadEnd: 650,
  stopLineOffset: 320,
  queueGap: 60,
});

// Incoming lane centres in the shared 1000 × 1000 SVG coordinate system.
export const INCOMING_LANES = Object.freeze({
  NORTH: Object.freeze({ axis: 'vertical', coordinate: 425, queueLead: 280, queueDirection: -1 }),
  SOUTH: Object.freeze({ axis: 'vertical', coordinate: 575, queueLead: 720, queueDirection: 1 }),
  WEST: Object.freeze({ axis: 'horizontal', coordinate: 575, queueLead: 280, queueDirection: -1 }),
  EAST: Object.freeze({ axis: 'horizontal', coordinate: 425, queueLead: 720, queueDirection: 1 }),
});
