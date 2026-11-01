function createVehicles() {
  const approaches = [
    { direction: 'NORTH', ids: ['V001', 'V002', 'V003', 'V004', 'V005'], axis: 'y', fixed: 425, lead: 286, step: -60 },
    { direction: 'SOUTH', ids: ['V006', 'V007', 'V008', 'V009', 'V010'], axis: 'y', fixed: 575, lead: 714, step: 60 },
    { direction: 'EAST', ids: ['V011', 'V012', 'V013', 'V014', 'V015'], axis: 'x', fixed: 425, lead: 714, step: 60 },
    { direction: 'WEST', ids: ['V016', 'V017', 'V018', 'V019', 'V020'], axis: 'x', fixed: 575, lead: 286, step: -60 },
  ];
  const routes = ['LEFT', 'STRAIGHT', 'RIGHT'];

  return approaches.flatMap((approach, approachIndex) => approach.ids.map((id, queuePosition) => ({
    id,
    incomingDirection: approach.direction,
    route: routes[(approachIndex + queuePosition) % routes.length],
    status: 'APPROACHING',
    x: approach.axis === 'x' ? approach.lead + approach.step * queuePosition : approach.fixed,
    y: approach.axis === 'y' ? approach.lead + approach.step * queuePosition : approach.fixed,
    queuePosition,
    waitingTime: 0,
    speed: 0,
    atStopLine: false,
  })));
}

function updateVehicle(vehicles, vehicleId, changes) {
  return vehicles.map((vehicle) => (vehicle.id === vehicleId ? { ...vehicle, ...changes } : vehicle));
}

function createSnapshot({ tickId, vehicles, eligibleVehicleIds = [], crossingIds = [], occupancy, conflictInformation }) {
  return {
    tickId,
    scenarioId: 'prompt-examples-scenario',
    simulationTimeSeconds: 45.5,
    intersection: {
      id: 'four-way-intersection',
      currentlyCrossingVehicleIds: crossingIds,
      occupancy,
      ...(conflictInformation ? { conflictInformation } : {}),
    },
    vehicles,
    eligibleVehicleIds,
  };
}

const clearOccupancy = {
  known: true,
  occupiedZones: [],
  dataSource: 'simulation',
};

let fourApproachVehicles = createVehicles();
for (const vehicleId of ['V001', 'V006', 'V011', 'V016']) {
  fourApproachVehicles = updateVehicle(fourApproachVehicles, vehicleId, {
    status: 'WAITING',
    waitingTime: 12,
    atStopLine: true,
  });
}

let crossingVehicles = createVehicles();
crossingVehicles = updateVehicle(crossingVehicles, 'V001', {
  status: 'CROSSING',
  y: 450,
  speed: 165,
});
crossingVehicles = updateVehicle(crossingVehicles, 'V006', {
  status: 'WAITING',
  waitingTime: 18,
  atStopLine: true,
});

let longWaitVehicles = createVehicles();
longWaitVehicles = updateVehicle(longWaitVehicles, 'V001', {
  status: 'WAITING',
  waitingTime: 75,
  atStopLine: true,
});
longWaitVehicles = updateVehicle(longWaitVehicles, 'V006', {
  status: 'WAITING',
  waitingTime: 10,
  atStopLine: true,
});

let queuedVehicles = createVehicles();
queuedVehicles = updateVehicle(queuedVehicles, 'V001', {
  status: 'WAITING',
  waitingTime: 22,
  atStopLine: true,
});

let compatibleProposalVehicles = createVehicles();
for (const vehicleId of ['V001', 'V011']) {
  compatibleProposalVehicles = updateVehicle(compatibleProposalVehicles, vehicleId, {
    status: 'WAITING',
    waitingTime: 30,
    atStopLine: true,
  });
}

let conflictingProposalVehicles = createVehicles();
for (const vehicleId of ['V001', 'V011']) {
  conflictingProposalVehicles = updateVehicle(conflictingProposalVehicles, vehicleId, {
    route: 'STRAIGHT',
    status: 'WAITING',
    waitingTime: 30,
    atStopLine: true,
  });
}

let incompleteOccupancyVehicles = createVehicles();
for (const vehicleId of ['V001', 'V011']) {
  incompleteOccupancyVehicles = updateVehicle(incompleteOccupancyVehicles, vehicleId, {
    status: 'WAITING',
    waitingTime: 30,
    atStopLine: true,
  });
}

export const PROMPT_EXAMPLES = Object.freeze([
  {
    name: 'four-eligible-approaches',
    description: 'Four lead vehicles are eligible; compare waiting time, fairness, and the complete clear intersection snapshot.',
    snapshot: createSnapshot({
      tickId: 'example-four-eligible',
      vehicles: fourApproachVehicles,
      eligibleVehicleIds: ['V001', 'V006', 'V011', 'V016'],
      occupancy: clearOccupancy,
      conflictInformation: {
        available: true,
        source: 'deterministic simulation movement geometry; advisory only',
        compatibilityNotes: [
          'V001 conflicts with V006; do not recommend GO for both in this tick.',
          'V001 and V011 are geometry-compatible and may be considered together.',
          'V001 conflicts with V016; do not recommend GO for both in this tick.',
          'V006 conflicts with V011; do not recommend GO for both in this tick.',
          'V006 and V016 are geometry-compatible and may be considered together.',
          'V011 and V016 are geometry-compatible and may be considered together.',
        ],
      },
    }),
    response: {
      tickId: 'example-four-eligible',
      decisions: [
        { vehicleId: 'V001', action: 'GO', reasonCode: 'PRIORITY' },
        { vehicleId: 'V006', action: 'WAIT', reasonCode: 'CONFLICT_CONCERN' },
        { vehicleId: 'V011', action: 'GO', reasonCode: 'FAIRNESS' },
        { vehicleId: 'V016', action: 'WAIT', reasonCode: 'CONFLICT_CONCERN' },
      ],
    },
  },
  {
    name: 'crossing-vehicle',
    description: 'A vehicle is already crossing, so the waiting eligible vehicle receives a conservative proposal.',
    snapshot: createSnapshot({
      tickId: 'example-crossing',
      vehicles: crossingVehicles,
      eligibleVehicleIds: ['V006'],
      crossingIds: ['V001'],
      occupancy: {
        known: true,
        occupiedZones: ['central-conflict-area'],
        dataSource: 'simulation',
      },
      conflictInformation: {
        available: true,
        source: 'deterministic simulation movement geometry; advisory only',
        compatibilityNotes: ['V006 conflicts with currently crossing V001.'],
      },
    }),
    response: {
      tickId: 'example-crossing',
      decisions: [{ vehicleId: 'V006', action: 'WAIT', reasonCode: 'OCCUPIED_INTERSECTION' }],
    },
  },
  {
    name: 'long-waiting-vehicle',
    description: 'A substantially longer wait can justify priority, while the other eligible vehicle is deferred fairly.',
    snapshot: createSnapshot({
      tickId: 'example-long-wait',
      vehicles: longWaitVehicles,
      eligibleVehicleIds: ['V001', 'V006'],
      occupancy: clearOccupancy,
      conflictInformation: {
        available: true,
        source: 'deterministic simulation movement geometry; advisory only',
        compatibilityNotes: ['V001 conflicts with V006; do not recommend GO for both in this tick.'],
      },
    }),
    response: {
      tickId: 'example-long-wait',
      decisions: [
        { vehicleId: 'V001', action: 'GO', reasonCode: 'WAITING_TIME' },
        { vehicleId: 'V006', action: 'WAIT', reasonCode: 'FAIRNESS' },
      ],
    },
  },
  {
    name: 'multiple-queued-vehicles',
    description: 'Only the north approach lead vehicle is eligible; following vehicles remain application-managed queue members.',
    snapshot: createSnapshot({
      tickId: 'example-queue',
      vehicles: queuedVehicles,
      eligibleVehicleIds: ['V001'],
      occupancy: clearOccupancy,
    }),
    response: {
      tickId: 'example-queue',
      decisions: [{ vehicleId: 'V001', action: 'WAIT', reasonCode: 'DEFERRED' }],
    },
  },
  {
    name: 'no-eligible-vehicles',
    description: 'No vehicle is at a stop line, so the only valid proposal list is empty.',
    snapshot: createSnapshot({
      tickId: 'example-no-eligible',
      vehicles: createVehicles(),
      occupancy: {
        known: false,
        occupiedZones: [],
        dataSource: 'unavailable',
      },
    }),
    response: {
      tickId: 'example-no-eligible',
      decisions: [],
    },
  },
  {
    name: 'application-supplied-compatibility-note',
    description: 'An application-supplied preliminary compatibility note permits multiple GO proposals to be considered; it is not a conflict matrix or final safety authorization.',
    snapshot: createSnapshot({
      tickId: 'example-supplied-compatibility',
      vehicles: compatibleProposalVehicles,
      eligibleVehicleIds: ['V001', 'V011'],
      occupancy: clearOccupancy,
      conflictInformation: {
        available: true,
        source: 'illustrative application input',
        compatibilityNotes: ['V001 and V011 are geometry-compatible and may be considered together.'],
      },
    }),
    response: {
      tickId: 'example-supplied-compatibility',
      decisions: [
        { vehicleId: 'V001', action: 'GO', reasonCode: 'PRIORITY' },
        { vehicleId: 'V011', action: 'GO', reasonCode: 'WAITING_TIME' },
      ],
    },
  },
  {
    name: 'conflicting-eligible-movements',
    description: 'Two eligible routes conflict, so the response may select one but must not select both.',
    snapshot: createSnapshot({
      tickId: 'example-conflicting-eligible',
      vehicles: conflictingProposalVehicles,
      eligibleVehicleIds: ['V001', 'V011'],
      occupancy: clearOccupancy,
      conflictInformation: {
        available: true,
        source: 'deterministic simulation movement geometry; advisory only',
        compatibilityNotes: ['V001 conflicts with V011; do not recommend GO for both in this tick.'],
      },
    }),
    response: {
      tickId: 'example-conflicting-eligible',
      decisions: [
        { vehicleId: 'V001', action: 'GO', reasonCode: 'PRIORITY' },
        { vehicleId: 'V011', action: 'WAIT', reasonCode: 'CONFLICT_CONCERN' },
      ],
    },
  },
  {
    name: 'incomplete-occupancy',
    description: 'Incomplete occupancy data does not establish a safe movement, so conservative WAIT proposals are appropriate.',
    snapshot: createSnapshot({
      tickId: 'example-incomplete-occupancy',
      vehicles: incompleteOccupancyVehicles,
      eligibleVehicleIds: ['V001', 'V011'],
      occupancy: {
        known: false,
        occupiedZones: [],
        dataSource: 'simulation occupancy state incomplete',
      },
      conflictInformation: {
        available: false,
        source: 'deterministic simulation movement geometry; advisory only',
        compatibilityNotes: ['Simulation occupancy state is incomplete, so movement compatibility is unavailable.'],
      },
    }),
    response: {
      tickId: 'example-incomplete-occupancy',
      decisions: [
        { vehicleId: 'V001', action: 'WAIT', reasonCode: 'OCCUPIED_INTERSECTION' },
        { vehicleId: 'V011', action: 'WAIT', reasonCode: 'CONFLICT_CONCERN' },
      ],
    },
  },
  {
    name: 'missing-compatibility-information',
    description: 'Known-clear occupancy alone does not establish route compatibility, so no GO is proposed when compatibility information is missing.',
    snapshot: createSnapshot({
      tickId: 'example-missing-compatibility',
      vehicles: compatibleProposalVehicles,
      eligibleVehicleIds: ['V001', 'V011'],
      occupancy: clearOccupancy,
    }),
    response: {
      tickId: 'example-missing-compatibility',
      decisions: [
        { vehicleId: 'V001', action: 'WAIT', reasonCode: 'DEFERRED' },
        { vehicleId: 'V011', action: 'WAIT', reasonCode: 'DEFERRED' },
      ],
    },
  },
]);
