import Vehicle from './Vehicle.jsx';
import { INTERSECTION_GEOMETRY } from '../services/intersectionGeometry.js';

const { viewBoxSize: VIEWBOX_SIZE, roadStart: ROAD_START, roadEnd: ROAD_END } = INTERSECTION_GEOMETRY;
const ROAD_WIDTH = ROAD_END - ROAD_START;

function BoundaryLine({ x1, y1, x2, y2 }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} className="road-boundary" />;
}

function StopLine({ x1, y1, x2, y2 }) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} className="stop-line" />;
}

function DirectionArrow({ type, x, y, rotation = 0 }) {
  return (
    <use
      href={`#${type}-arrow`}
      transform={`translate(${x} ${y}) rotate(${rotation})`}
      className="direction-arrow"
    />
  );
}

function Intersection({ vehicles = [] }) {
  return (
    <div className="intersection-frame">
      <svg
        className="intersection-svg"
        viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
        role="img"
        aria-label="Top-down four-way traffic intersection with lanes, stop lines, and directional arrows"
      >
        <defs>
          <pattern id="ground-grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" className="ground-grid" />
          </pattern>

          <g id="straight-arrow">
            <path d="M 0 38 V -38 M -15 -22 L 0 -38 L 15 -22" />
          </g>
          <g id="left-arrow">
            <path d="M 0 38 V -6 C 0 -27 -15 -40 -38 -40 M -22 -55 L -38 -40 L -22 -25" />
          </g>
          <g id="right-arrow">
            <path d="M 0 38 V -6 C 0 -27 15 -40 38 -40 M 22 -55 L 38 -40 L 22 -25" />
          </g>
        </defs>

        <rect width={VIEWBOX_SIZE} height={VIEWBOX_SIZE} className="intersection-ground" />
        <rect width={VIEWBOX_SIZE} height={VIEWBOX_SIZE} fill="url(#ground-grid)" />

        {/* Road layer: a 300-unit-wide horizontal and vertical carriageway. */}
        <rect x={ROAD_START} width={ROAD_WIDTH} height={VIEWBOX_SIZE} className="road-surface" />
        <rect y={ROAD_START} width={VIEWBOX_SIZE} height={ROAD_WIDTH} className="road-surface" />

        {/* Outer road boundaries, intentionally interrupted at the central conflict area. */}
        <g>
          <BoundaryLine x1={ROAD_START} y1="0" x2={ROAD_START} y2={ROAD_START} />
          <BoundaryLine x1={ROAD_START} y1={ROAD_END} x2={ROAD_START} y2={VIEWBOX_SIZE} />
          <BoundaryLine x1={ROAD_END} y1="0" x2={ROAD_END} y2={ROAD_START} />
          <BoundaryLine x1={ROAD_END} y1={ROAD_END} x2={ROAD_END} y2={VIEWBOX_SIZE} />
          <BoundaryLine x1="0" y1={ROAD_START} x2={ROAD_START} y2={ROAD_START} />
          <BoundaryLine x1={ROAD_END} y1={ROAD_START} x2={VIEWBOX_SIZE} y2={ROAD_START} />
          <BoundaryLine x1="0" y1={ROAD_END} x2={ROAD_START} y2={ROAD_END} />
          <BoundaryLine x1={ROAD_END} y1={ROAD_END} x2={VIEWBOX_SIZE} y2={ROAD_END} />
        </g>

        {/* Dashed dividers end before vehicles reach the conflict area. */}
        <g className="lane-divider">
          <line x1="500" y1="0" x2="500" y2="320" />
          <line x1="500" y1="680" x2="500" y2={VIEWBOX_SIZE} />
          <line x1="0" y1="500" x2="320" y2="500" />
          <line x1="680" y1="500" x2={VIEWBOX_SIZE} y2="500" />
        </g>

        {/* Stop lines for north, south, west, and east approaches. */}
        <g>
          <StopLine x1={ROAD_START} y1="320" x2="500" y2="320" />
          <StopLine x1="500" y1="680" x2={ROAD_END} y2="680" />
          <StopLine x1="320" y1="500" x2="320" y2={ROAD_END} />
          <StopLine x1="680" y1={ROAD_START} x2="680" y2="500" />
        </g>

        <rect
          x={ROAD_START}
          y={ROAD_START}
          width={ROAD_WIDTH}
          height={ROAD_WIDTH}
          className="conflict-area"
        />

        {/* Arrows are road markings only; vehicle elements will be rendered above this group later. */}
        <g aria-hidden="true">
          <DirectionArrow type="straight" x="425" y="185" rotation="180" />
          <DirectionArrow type="left" x="575" y="815" />
          <DirectionArrow type="straight" x="185" y="575" rotation="90" />
          <DirectionArrow type="right" x="815" y="425" rotation="270" />
        </g>

        <g className="compass-labels" aria-hidden="true">
          <text x="500" y="82">N</text>
          <text x="500" y="948">S</text>
          <text x="82" y="514">W</text>
          <text x="918" y="514">E</text>
        </g>

        {/* Vehicles are deliberately rendered above every road-marking layer. */}
        <g id="vehicle-layer">
          {vehicles.map((vehicle) => <Vehicle key={vehicle.id} vehicle={vehicle} />)}
        </g>
      </svg>
    </div>
  );
}

export default Intersection;
