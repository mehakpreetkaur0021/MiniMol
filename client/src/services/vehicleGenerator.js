import { INCOMING_LANES, INTERSECTION_GEOMETRY } from './intersectionGeometry.js';

export const VEHICLE_DIRECTIONS = Object.freeze(['NORTH', 'SOUTH', 'EAST', 'WEST']);
export const VEHICLE_ROUTES = Object.freeze(['LEFT', 'STRAIGHT', 'RIGHT']);
export const VEHICLE_STATUSES = Object.freeze({
  APPROACHING: 'APPROACHING',
  WAITING: 'WAITING',
  CROSSING: 'CROSSING',
  EXITED: 'EXITED',
});

const VEHICLES_PER_DIRECTION = 5;

function hashSeed(seed) {
  const seedText = String(seed);
  let hash = 2166136261;

  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

// Mulberry32: small deterministic PRNG suitable for repeatable UI scenarios.
function createSeededRandom(seed) {
  let state = hashSeed(seed);

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const shuffledItems = [...items];

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffledItems[index], shuffledItems[swapIndex]] = [
      shuffledItems[swapIndex],
      shuffledItems[index],
    ];
  }

  return shuffledItems;
}

function createBalancedRoutePool(random) {
  // Twenty vehicles produce a 7 / 7 / 6 split, shuffled deterministically.
  const routePool = [
    ...Array(7).fill('LEFT'),
    ...Array(7).fill('STRAIGHT'),
    ...Array(6).fill('RIGHT'),
  ];

  return shuffle(routePool, random);
}

function calculateVehiclePosition(incomingDirection, queuePosition) {
  const lane = INCOMING_LANES[incomingDirection];
  const queueCoordinate =
    lane.queueLead + lane.queueDirection * INTERSECTION_GEOMETRY.queueGap * queuePosition;

  return lane.axis === 'vertical'
    ? { x: lane.coordinate, y: queueCoordinate }
    : { x: queueCoordinate, y: lane.coordinate };
}

export function generateVehicles(seed = 'initial-traffic-scenario') {
  const random = createSeededRandom(seed);
  const routePool = createBalancedRoutePool(random);
  const vehicles = [];
  let routeIndex = 0;

  VEHICLE_DIRECTIONS.forEach((incomingDirection) => {
    for (let queuePosition = 0; queuePosition < VEHICLES_PER_DIRECTION; queuePosition += 1) {
      const vehicleNumber = vehicles.length + 1;
      const position = calculateVehiclePosition(incomingDirection, queuePosition);

      vehicles.push({
        id: `V${String(vehicleNumber).padStart(3, '0')}`,
        incomingDirection,
        route: routePool[routeIndex],
        status: VEHICLE_STATUSES.APPROACHING,
        ...position,
        queuePosition,
        waitingTime: 0,
        speed: 0,
      });
      routeIndex += 1;
    }
  });

  return vehicles;
}

export function summarizeVehicles(vehicles) {
  const directions = Object.fromEntries(VEHICLE_DIRECTIONS.map((direction) => [direction, 0]));
  const routes = Object.fromEntries(VEHICLE_ROUTES.map((route) => [route, 0]));

  vehicles.forEach((vehicle) => {
    directions[vehicle.incomingDirection] += 1;
    routes[vehicle.route] += 1;
  });

  return { directions, routes };
}
