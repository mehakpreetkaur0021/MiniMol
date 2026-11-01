const VEHICLE_COLORS = {
  NORTH: '#38bdf8',
  SOUTH: '#a78bfa',
  EAST: '#f59e0b',
  WEST: '#34d399',
};

const VEHICLE_ROTATIONS = {
  NORTH: 180,
  SOUTH: 0,
  EAST: 270,
  WEST: 90,
};

function Vehicle({ vehicle }) {
  const { id, incomingDirection, route, status, x, y } = vehicle;
  const rotation = Number.isFinite(vehicle.heading)
    ? vehicle.heading
    : VEHICLE_ROTATIONS[incomingDirection];

  return (
    <g
      transform={`translate(${x} ${y}) rotate(${rotation})`}
      className="vehicle"
      aria-label={`${id}: ${incomingDirection}, ${route}, ${status}`}
    >
      <rect x="-18" y="-24" width="36" height="48" rx="9" className="vehicle-body" fill={VEHICLE_COLORS[incomingDirection]} />
      <rect x="-12" y="-18" width="24" height="14" rx="4" className="vehicle-windshield" />
      <rect x="-12" y="7" width="24" height="10" rx="3" className="vehicle-rear-window" />
      <circle cx="-14" cy="-16" r="2.5" className="vehicle-light" />
      <circle cx="14" cy="-16" r="2.5" className="vehicle-light" />
      <text y="4" className="vehicle-id">{id.slice(1)}</text>
    </g>
  );
}

export default Vehicle;
