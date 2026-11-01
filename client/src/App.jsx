import { useEffect, useRef, useState } from 'react';
import Intersection from './components/Intersection.jsx';
import { generateVehicles, summarizeVehicles, VEHICLE_STATUSES } from './services/vehicleGenerator.js';
import {
  approveVehicleMovement,
  createSimulationState,
  getEligibleVehicles,
  pauseSimulation,
  SIMULATION_STATUSES,
  startSimulation,
  advanceSimulation,
} from './services/simulationEngine.js';
import './App.css';

const INITIAL_SCENARIO_SEED = 'traffic-scenario-2026';

function App() {
  const [backendStatus, setBackendStatus] = useState('checking');
  const scenarioVersionRef = useRef(0);
  const initialScenarioRef = useRef(null);

  if (initialScenarioRef.current === null) {
    initialScenarioRef.current = generateVehicles(INITIAL_SCENARIO_SEED);
  }

  const [scenarioVehicles, setScenarioVehicles] = useState(() => initialScenarioRef.current);
  const [simulation, setSimulation] = useState(() => createSimulationState(initialScenarioRef.current));

  useEffect(() => {
    const controller = new AbortController();

    async function checkBackendHealth() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });

        if (!response.ok) {
          throw new Error(`Health check failed with status ${response.status}`);
        }

        setBackendStatus('connected');
      } catch (error) {
        if (error.name !== 'AbortError') {
          setBackendStatus('disconnected');
        }
      }
    }

    checkBackendHealth();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (simulation.status !== SIMULATION_STATUSES.RUNNING) {
      return undefined;
    }

    let animationFrameId;
    let previousTimestamp;

    function animate(timestamp) {
      if (previousTimestamp !== undefined) {
        const elapsedSeconds = (timestamp - previousTimestamp) / 1000;
        setSimulation((currentSimulation) => advanceSimulation(currentSimulation, elapsedSeconds));
      }

      previousTimestamp = timestamp;
      animationFrameId = requestAnimationFrame(animate);
    }

    animationFrameId = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(animationFrameId);
  }, [simulation.status]);

  const backendStatusLabel = {
    checking: 'Checking...',
    connected: 'Connected',
    disconnected: 'Disconnected',
  }[backendStatus];

  const trafficSummary = summarizeVehicles(scenarioVehicles);
  const eligibleVehicles = getEligibleVehicles(simulation);
  const vehicleCounts = simulation.vehicles.reduce((counts, vehicle) => {
    counts.active += vehicle.status === VEHICLE_STATUSES.EXITED ? 0 : 1;
    counts.waiting += vehicle.status === VEHICLE_STATUSES.WAITING ? 1 : 0;
    counts.crossing += vehicle.status === VEHICLE_STATUSES.CROSSING ? 1 : 0;
    counts.exited += vehicle.status === VEHICLE_STATUSES.EXITED ? 1 : 0;
    return counts;
  }, { active: 0, waiting: 0, crossing: 0, exited: 0 });

  function regenerateTraffic() {
    scenarioVersionRef.current += 1;
    const regeneratedVehicles = generateVehicles(`${INITIAL_SCENARIO_SEED}-${scenarioVersionRef.current}`);
    setScenarioVehicles(regeneratedVehicles);
    setSimulation(createSimulationState(regeneratedVehicles));
  }

  function resetSimulation() {
    setSimulation(createSimulationState(scenarioVehicles));
  }

  function approveVehicle(vehicleId) {
    setSimulation((currentSimulation) => approveVehicleMovement(currentSimulation, vehicleId).state);
  }

  return (
    <main className="app-shell">
      <section className="hero" aria-labelledby="app-title">
        <p className="eyebrow">Traffic coordination dashboard</p>
        <h1 id="app-title">AI-Based Intelligent Traffic Management System</h1>
        <p className="subtitle">Intelligent Multi-Vehicle Intersection Coordination</p>
      </section>

      <section className="intersection-panel" aria-label="Intersection visualization">
        <Intersection vehicles={simulation.vehicles} />
      </section>

      <section className="traffic-summary" aria-label="Traffic scenario summary">
        <div className="traffic-summary-heading">
          <div>
            <p className="section-kicker">Current traffic scenario</p>
            <h2>{scenarioVehicles.length} vehicles · {simulation.status.toLowerCase()}</h2>
          </div>
          <button type="button" className="regenerate-button" onClick={regenerateTraffic}>
            Regenerate Traffic
          </button>
        </div>
        <div className="summary-grid">
          <div className="summary-group">
            <h3>Incoming approaches</h3>
            <div className="summary-values">
              {Object.entries(trafficSummary.directions).map(([direction, count]) => (
                <span key={direction}><b>{direction[0]}</b> {count}</span>
              ))}
            </div>
          </div>
          <div className="summary-group">
            <h3>Routes</h3>
            <div className="summary-values">
              {Object.entries(trafficSummary.routes).map(([route, count]) => (
                <span key={route}><b>{route}</b> {count}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="simulation-panel" aria-label="Simulation controls and state">
        <div className="simulation-panel-heading">
          <div>
            <p className="section-kicker">Simulation engine</p>
            <h2>{simulation.status}</h2>
          </div>
          <div className="simulation-controls">
            <button
              type="button"
              className="control-button control-button-primary"
              onClick={() => setSimulation((currentSimulation) => startSimulation(currentSimulation))}
              disabled={simulation.status === SIMULATION_STATUSES.RUNNING}
            >
              Start
            </button>
            <button
              type="button"
              className="control-button"
              onClick={() => setSimulation((currentSimulation) => pauseSimulation(currentSimulation))}
              disabled={simulation.status !== SIMULATION_STATUSES.RUNNING}
            >
              Pause
            </button>
            <button type="button" className="control-button" onClick={resetSimulation}>
              Reset
            </button>
          </div>
        </div>

        <div className="simulation-metrics">
          <span><b>Total</b> {scenarioVehicles.length}</span>
          <span><b>Active</b> {vehicleCounts.active}</span>
          <span><b>Waiting</b> {vehicleCounts.waiting}</span>
          <span><b>Crossing</b> {vehicleCounts.crossing}</span>
          <span><b>Exited</b> {vehicleCounts.exited}</span>
          <span><b>Time</b> {simulation.elapsedTime.toFixed(1)}s</span>
        </div>

        <div className="approval-panel">
          <div>
            <h3>Manual movement approval</h3>
            <p>Only a lead vehicle stopped at its line is eligible. One vehicle may cross at a time.</p>
          </div>
          <div className="eligible-vehicles">
            {eligibleVehicles.length === 0 ? (
              <span className="approval-empty">No vehicle ready for approval</span>
            ) : eligibleVehicles.map((vehicle) => (
              <div key={vehicle.id} className="eligible-vehicle">
                <span><b>{vehicle.id}</b> · {vehicle.incomingDirection} · {vehicle.route}</span>
                <button type="button" className="approve-button" onClick={() => approveVehicle(vehicle.id)}>
                  Approve
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="status-card" aria-label="Application status">
        <div className="status-heading">
          <h2>System status</h2>
          <span>Module 3 · Traffic state</span>
        </div>
        <div className="status-list">
          <div className="status-row">
            <span>Frontend</span>
            <span className="status-value status-running">Running</span>
          </div>
          <div className="status-row">
            <span>Backend</span>
            <span className={`status-value status-${backendStatus}`}>
              {backendStatusLabel}
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}

export default App;
