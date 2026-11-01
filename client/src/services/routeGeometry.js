import { INCOMING_LANES, INTERSECTION_GEOMETRY } from './intersectionGeometry.js';
import { SIMULATION_CONFIG, VEHICLE_DIMENSIONS } from './simulationConfig.js';

export const ROUTE_DESTINATIONS = Object.freeze({
  NORTH: Object.freeze({ LEFT: 'EAST', STRAIGHT: 'SOUTH', RIGHT: 'WEST' }),
  SOUTH: Object.freeze({ LEFT: 'WEST', STRAIGHT: 'NORTH', RIGHT: 'EAST' }),
  EAST: Object.freeze({ LEFT: 'SOUTH', STRAIGHT: 'WEST', RIGHT: 'NORTH' }),
  WEST: Object.freeze({ LEFT: 'NORTH', STRAIGHT: 'EAST', RIGHT: 'SOUTH' }),
});

const TRAVEL_VECTORS = Object.freeze({
  NORTH: { x: 0, y: -1 },
  SOUTH: { x: 0, y: 1 },
  EAST: { x: 1, y: 0 },
  WEST: { x: -1, y: 0 },
});

const INITIAL_TRAVEL_DIRECTIONS = Object.freeze({
  NORTH: 'SOUTH',
  SOUTH: 'NORTH',
  EAST: 'WEST',
  WEST: 'EAST',
});

const routeCache = new Map();
const { viewBoxSize, stopLineOffset } = INTERSECTION_GEOMETRY;
const stopOffset = VEHICLE_DIMENSIONS.length / 2 + SIMULATION_CONFIG.stopLineClearance;

export function getInitialHeading(incomingDirection) {
  return headingFromVector(TRAVEL_VECTORS[INITIAL_TRAVEL_DIRECTIONS[incomingDirection]]);
}

export function getStopPoint(incomingDirection) {
  const farStopLine = viewBoxSize - stopLineOffset;

  switch (incomingDirection) {
    case 'NORTH':
      return { x: INCOMING_LANES.NORTH.coordinate, y: stopLineOffset - stopOffset };
    case 'SOUTH':
      return { x: INCOMING_LANES.SOUTH.coordinate, y: farStopLine + stopOffset };
    case 'WEST':
      return { x: stopLineOffset - stopOffset, y: INCOMING_LANES.WEST.coordinate };
    case 'EAST':
      return { x: farStopLine + stopOffset, y: INCOMING_LANES.EAST.coordinate };
    default:
      throw new Error(`Unknown incoming direction: ${incomingDirection}`);
  }
}

function getExitPoint(outgoingDirection) {
  const clearance = VEHICLE_DIMENSIONS.length + SIMULATION_CONFIG.stopLineClearance;

  switch (outgoingDirection) {
    case 'NORTH':
      return { x: INCOMING_LANES.SOUTH.coordinate, y: -clearance };
    case 'SOUTH':
      return { x: INCOMING_LANES.NORTH.coordinate, y: viewBoxSize + clearance };
    case 'EAST':
      return { x: viewBoxSize + clearance, y: INCOMING_LANES.WEST.coordinate };
    case 'WEST':
      return { x: -clearance, y: INCOMING_LANES.EAST.coordinate };
    default:
      throw new Error(`Unknown outgoing direction: ${outgoingDirection}`);
  }
}

function headingFromVector(vector) {
  return (Math.atan2(vector.y, vector.x) * 180) / Math.PI + 90;
}

function cubicPoint(start, controlOne, controlTwo, end, progress) {
  const inverse = 1 - progress;
  const inverseSquared = inverse * inverse;
  const progressSquared = progress * progress;

  return {
    x: inverseSquared * inverse * start.x + 3 * inverseSquared * progress * controlOne.x + 3 * inverse * progressSquared * controlTwo.x + progressSquared * progress * end.x,
    y: inverseSquared * inverse * start.y + 3 * inverseSquared * progress * controlOne.y + 3 * inverse * progressSquared * controlTwo.y + progressSquared * progress * end.y,
  };
}

function createLinePath(start, end) {
  return [{ ...start }, { ...end }];
}

function createTurnPath(start, end, startVector, endVector) {
  const controlDistance = 190;
  const points = [];

  const controlOne = {
    x: start.x + startVector.x * controlDistance,
    y: start.y + startVector.y * controlDistance,
  };
  const controlTwo = {
    x: end.x - endVector.x * controlDistance,
    y: end.y - endVector.y * controlDistance,
  };

  for (let index = 0; index <= 96; index += 1) {
    points.push(cubicPoint(start, controlOne, controlTwo, end, index / 96));
  }

  return points;
}

function addDistances(points) {
  let totalLength = 0;
  const pointsWithDistances = points.map((point, index) => {
    if (index > 0) {
      totalLength += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    }

    return { ...point, distance: totalLength };
  });

  return { points: pointsWithDistances, totalLength };
}

export function getRoutePath(incomingDirection, route) {
  const cacheKey = `${incomingDirection}-${route}`;
  const cachedRoute = routeCache.get(cacheKey);

  if (cachedRoute) {
    return cachedRoute;
  }

  const outgoingDirection = ROUTE_DESTINATIONS[incomingDirection]?.[route];
  if (!outgoingDirection) {
    throw new Error(`Invalid route combination: ${cacheKey}`);
  }

  const start = getStopPoint(incomingDirection);
  const end = getExitPoint(outgoingDirection);
  const initialDirection = INITIAL_TRAVEL_DIRECTIONS[incomingDirection];
  const points = route === 'STRAIGHT'
    ? createLinePath(start, end)
    : createTurnPath(start, end, TRAVEL_VECTORS[initialDirection], TRAVEL_VECTORS[outgoingDirection]);
  const path = {
    incomingDirection,
    route,
    outgoingDirection,
    start,
    end,
    ...addDistances(points),
  };

  routeCache.set(cacheKey, path);
  return path;
}

export function getPointOnPath(path, distance) {
  const clampedDistance = Math.max(0, Math.min(distance, path.totalLength));
  const finalPoint = path.points[path.points.length - 1];

  if (clampedDistance === path.totalLength) {
    const previousPoint = path.points[path.points.length - 2];
    return {
      x: finalPoint.x,
      y: finalPoint.y,
      heading: headingFromVector({ x: finalPoint.x - previousPoint.x, y: finalPoint.y - previousPoint.y }),
    };
  }

  const segmentIndex = path.points.findIndex((point) => point.distance >= clampedDistance);
  const nextPoint = path.points[Math.max(1, segmentIndex)];
  const previousPoint = path.points[Math.max(0, segmentIndex - 1)];
  const segmentLength = nextPoint.distance - previousPoint.distance;
  const segmentProgress = segmentLength === 0 ? 0 : (clampedDistance - previousPoint.distance) / segmentLength;

  return {
    x: previousPoint.x + (nextPoint.x - previousPoint.x) * segmentProgress,
    y: previousPoint.y + (nextPoint.y - previousPoint.y) * segmentProgress,
    heading: headingFromVector({ x: nextPoint.x - previousPoint.x, y: nextPoint.y - previousPoint.y }),
  };
}
