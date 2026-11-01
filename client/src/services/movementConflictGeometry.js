import { INTERSECTION_GEOMETRY } from './intersectionGeometry.js';
import { getPointOnPath, getRoutePath } from './routeGeometry.js';
import { VEHICLE_DIMENSIONS } from './simulationConfig.js';

const PATH_SAMPLE_COUNT = 128;
const vehicleEnvelopeRadius = Math.hypot(VEHICLE_DIMENSIONS.length / 2, VEHICLE_DIMENSIONS.width / 2);
const minimumCentrelineClearance = vehicleEnvelopeRadius * 2;
const conflictBounds = Object.freeze({
  minX: INTERSECTION_GEOMETRY.roadStart - vehicleEnvelopeRadius,
  maxX: INTERSECTION_GEOMETRY.roadEnd + vehicleEnvelopeRadius,
  minY: INTERSECTION_GEOMETRY.roadStart - vehicleEnvelopeRadius,
  maxY: INTERSECTION_GEOMETRY.roadEnd + vehicleEnvelopeRadius,
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function clipSegmentToBounds(start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const boundaries = [
    [-deltaX, start.x - conflictBounds.minX],
    [deltaX, conflictBounds.maxX - start.x],
    [-deltaY, start.y - conflictBounds.minY],
    [deltaY, conflictBounds.maxY - start.y],
  ];
  let entry = 0;
  let exit = 1;

  for (const [direction, distance] of boundaries) {
    if (direction === 0) {
      if (distance < 0) {
        return null;
      }
      continue;
    }

    const ratio = distance / direction;
    if (direction < 0) {
      if (ratio > exit) {
        return null;
      }
      entry = Math.max(entry, ratio);
    } else {
      if (ratio < entry) {
        return null;
      }
      exit = Math.min(exit, ratio);
    }
  }

  return {
    start: { x: start.x + entry * deltaX, y: start.y + entry * deltaY },
    end: { x: start.x + exit * deltaX, y: start.y + exit * deltaY },
  };
}

function pointToSegmentDistance(point, start, end) {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  if (squaredLength === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const progress = clamp(((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / squaredLength, 0, 1);
  return Math.hypot(point.x - (start.x + progress * deltaX), point.y - (start.y + progress * deltaY));
}

function orientation(first, second, third) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function segmentsIntersect(first, second) {
  const firstStartOrientation = orientation(first.start, first.end, second.start);
  const firstEndOrientation = orientation(first.start, first.end, second.end);
  const secondStartOrientation = orientation(second.start, second.end, first.start);
  const secondEndOrientation = orientation(second.start, second.end, first.end);
  return (firstStartOrientation === 0 || firstEndOrientation === 0 || Math.sign(firstStartOrientation) !== Math.sign(firstEndOrientation))
    && (secondStartOrientation === 0 || secondEndOrientation === 0 || Math.sign(secondStartOrientation) !== Math.sign(secondEndOrientation));
}

function segmentDistance(first, second) {
  if (segmentsIntersect(first, second)) {
    return 0;
  }

  return Math.min(
    pointToSegmentDistance(first.start, second.start, second.end),
    pointToSegmentDistance(first.end, second.start, second.end),
    pointToSegmentDistance(second.start, first.start, first.end),
    pointToSegmentDistance(second.end, first.start, first.end),
  );
}

function getConflictSegments(incomingDirection, route, routeDistance = 0) {
  let path;
  try {
    path = getRoutePath(incomingDirection, route);
  } catch {
    return null;
  }

  const startDistance = clamp(Number.isFinite(routeDistance) ? routeDistance : 0, 0, path.totalLength);
  const points = Array.from({ length: PATH_SAMPLE_COUNT + 1 }, (_, index) => (
    getPointOnPath(path, startDistance + (path.totalLength - startDistance) * (index / PATH_SAMPLE_COUNT))
  ));
  return points.slice(1).flatMap((end, index) => {
    const segment = clipSegmentToBounds(points[index], end);
    return segment ? [segment] : [];
  });
}

/**
 * Compares swept vehicle centre paths through the intersection's conflict area.
 * The clearance is derived from the rendered vehicle rectangle's circumscribed
 * circle, so paths closer than two vehicle envelopes are never independent.
 */
export function getMovementConflict(firstMovement, secondMovement) {
  const firstSegments = getConflictSegments(
    firstMovement?.incomingDirection,
    firstMovement?.route,
    firstMovement?.routeDistance,
  );
  const secondSegments = getConflictSegments(
    secondMovement?.incomingDirection,
    secondMovement?.route,
    secondMovement?.routeDistance,
  );

  if (!firstSegments || !secondSegments) {
    return { known: false, conflicts: true };
  }

  return {
    known: true,
    conflicts: firstSegments.some((firstSegment) => secondSegments.some((secondSegment) => (
      segmentDistance(firstSegment, secondSegment) < minimumCentrelineClearance
    ))),
  };
}

export const MOVEMENT_CONFLICT_GEOMETRY = Object.freeze({
  conflictBounds,
  minimumCentrelineClearance,
});
