import { useEffect, useRef, useState } from 'react';
import Intersection from './components/Intersection.jsx';
import { generateVehicles, summarizeVehicles, VEHICLE_STATUSES } from './services/vehicleGenerator.js';
import { requestAiDecisions } from './services/aiDecisionService.js';
import {
  executeApprovedVehicleMovements,
  getAuthorizationExecutionId,
} from './services/movementExecutionService.js';
import { validateMovementProposals } from './services/safetyValidator.js';
import { buildTrafficSnapshot } from './services/trafficSnapshotBuilder.js';
import {
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
  const decisionTickRef = useRef(0);
  const activeDecisionTickRef = useRef(null);
  const manualApprovalTickRef = useRef(0);
  const executedAuthorizationIdsRef = useRef(new Set());
  const initialScenarioRef = useRef(null);

  if (initialScenarioRef.current === null) {
    initialScenarioRef.current = generateVehicles(INITIAL_SCENARIO_SEED);
  }

  const [scenarioVehicles, setScenarioVehicles] = useState(() => initialScenarioRef.current);
  const [simulation, setSimulation] = useState(() => createSimulationState(initialScenarioRef.current));
  const [aiRequestState, setAiRequestState] = useState({ status: 'idle', error: '' });
  const [aiProposal, setAiProposal] = useState(null);
  const [manualSafetyResult, setManualSafetyResult] = useState(null);
  const [manualExecutionResult, setManualExecutionResult] = useState(null);
  const simulationRef = useRef(simulation);
  simulationRef.current = simulation;

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
    activeDecisionTickRef.current = null;
    executedAuthorizationIdsRef.current.clear();
    const regeneratedVehicles = generateVehicles(`${INITIAL_SCENARIO_SEED}-${scenarioVersionRef.current}`);
    setScenarioVehicles(regeneratedVehicles);
    setSimulation(createSimulationState(regeneratedVehicles));
    setAiProposal(null);
    setAiRequestState({ status: 'idle', error: '' });
    setManualSafetyResult(null);
    setManualExecutionResult(null);
  }

  function resetSimulation() {
    activeDecisionTickRef.current = null;
    executedAuthorizationIdsRef.current.clear();
    setSimulation(createSimulationState(scenarioVehicles));
    setAiProposal(null);
    setAiRequestState({ status: 'idle', error: '' });
    setManualSafetyResult(null);
    setManualExecutionResult(null);
  }

  function approveVehicle(vehicleId) {
    manualApprovalTickRef.current += 1;
    const currentSimulation = simulationRef.current;
    const scenarioId = `traffic-scenario-${scenarioVersionRef.current}`;
    const tickId = `manual-${scenarioVersionRef.current}-${manualApprovalTickRef.current}`;
    const snapshot = buildTrafficSnapshot({
      tickId,
      scenarioId,
      simulation: currentSimulation,
      eligibleVehicleIds: getEligibleVehicles(currentSimulation).map((vehicle) => vehicle.id),
    });
    const safetyValidation = validateMovementProposals({
      proposal: { tickId, decisions: [{ vehicleId, action: 'GO' }] },
      snapshot,
      simulation: currentSimulation,
      currentTickId: tickId,
      currentScenarioId: scenarioId,
    });
    const safetyResult = safetyValidation.results[0];
    setManualSafetyResult(safetyResult);
    const execution = executeApprovedVehicleMovements(currentSimulation, {
      safetyValidation,
      currentTickId: tickId,
      currentScenarioId: scenarioId,
      executedAuthorizationIds: executedAuthorizationIdsRef.current,
    });
    const executionResult = execution.results[0];
    setManualExecutionResult(executionResult);
    if (executionResult?.executionStatus === 'STARTED') {
      executedAuthorizationIdsRef.current.add(getAuthorizationExecutionId(scenarioId, tickId, vehicleId));
      simulationRef.current = execution.state;
      setSimulation(execution.state);
    }
  }

  async function requestAiDecisionProposals() {
    if (aiRequestState.status === 'loading') {
      return;
    }

    decisionTickRef.current += 1;
    const snapshot = buildTrafficSnapshot({
      tickId: `decision-${scenarioVersionRef.current}-${decisionTickRef.current}`,
      scenarioId: `traffic-scenario-${scenarioVersionRef.current}`,
      simulation,
      eligibleVehicleIds: eligibleVehicles.map((vehicle) => vehicle.id),
    });

    activeDecisionTickRef.current = snapshot.tickId;
    setAiProposal(null);
    setAiRequestState({ status: 'loading', error: '' });
    try {
      const result = await requestAiDecisions(snapshot);
      if (activeDecisionTickRef.current !== snapshot.tickId || snapshot.scenarioId !== `traffic-scenario-${scenarioVersionRef.current}`) {
        return;
      }

      const safetyValidation = validateMovementProposals({
        proposal: result,
        snapshot,
        simulation: simulationRef.current,
        currentTickId: activeDecisionTickRef.current,
        currentScenarioId: `traffic-scenario-${scenarioVersionRef.current}`,
      });
      const execution = executeApprovedVehicleMovements(simulationRef.current, {
        safetyValidation,
        currentTickId: activeDecisionTickRef.current,
        currentScenarioId: `traffic-scenario-${scenarioVersionRef.current}`,
        executedAuthorizationIds: executedAuthorizationIdsRef.current,
      });
      execution.results
        .filter((executionResult) => executionResult.executionStatus === 'STARTED')
        .forEach((executionResult) => executedAuthorizationIdsRef.current.add(getAuthorizationExecutionId(
          `traffic-scenario-${scenarioVersionRef.current}`,
          activeDecisionTickRef.current,
          executionResult.vehicleId,
        )));
      if (execution.results.some((executionResult) => executionResult.executionStatus === 'STARTED')) {
        simulationRef.current = execution.state;
        setSimulation(execution.state);
      }
      setAiProposal({ ...result, eligibleCount: snapshot.eligibleVehicleIds.length, safetyValidation, execution });
      setAiRequestState({ status: 'success', error: '' });
    } catch (error) {
      if (activeDecisionTickRef.current !== snapshot.tickId) {
        return;
      }
      setAiProposal(null);
      setAiRequestState({ status: 'error', error: error.message });
    }
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
            <p>Only a lead vehicle stopped at its line is eligible. Modules 7 and 8 validate and start mutually non-conflicting movements.</p>
          </div>
          <div className="eligible-vehicles">
            {eligibleVehicles.length === 0 ? (
              <span className="approval-empty">No vehicle ready for approval</span>
            ) : eligibleVehicles.map((vehicle) => (
              <div key={vehicle.id} className="eligible-vehicle">
                <span><b>{vehicle.id}</b> · {vehicle.incomingDirection} · {vehicle.route}</span>
                <button
                  type="button"
                  className="approve-button"
                  onClick={() => approveVehicle(vehicle.id)}
                  disabled={simulation.status !== SIMULATION_STATUSES.RUNNING}
                >
                  Approve
                </button>
              </div>
            ))}
          </div>
          {manualSafetyResult && (
            <p className={`manual-safety-result manual-safety-${manualSafetyResult.safetyStatus.toLowerCase()}`}>
              <b>Module 7:</b> {manualSafetyResult.safetyStatus} · {manualSafetyResult.reason}
              {manualExecutionResult && <> · <b>Module 8:</b> {manualExecutionResult.executionStatus} · {manualExecutionResult.reason}</>}
            </p>
          )}
        </div>
      </section>

      <section className="ai-panel" aria-label="OpenRouter decision proposals">
        <div className="ai-panel-heading">
          <div>
            <p className="section-kicker">Explicit AI decision tick</p>
            <h2>OpenRouter proposals</h2>
          </div>
          <button
            type="button"
            className="request-ai-button"
            onClick={requestAiDecisionProposals}
            disabled={aiRequestState.status === 'loading'}
          >
            {aiRequestState.status === 'loading' ? 'Requesting…' : 'Request OpenRouter Decisions'}
          </button>
        </div>

        <p className="ai-warning">AI PROPOSALS — REQUIRE MODULE 7 VALIDATION</p>
        {aiRequestState.status === 'error' && <p className="ai-error">{aiRequestState.error}</p>}

        {aiProposal && (
          <div className="proposal-results">
            <div className="proposal-metrics">
              <span><b>Provider</b> {aiProposal.provider ?? 'OpenRouter'}</span>
              <span><b>Tick</b> {aiProposal.tickId}</span>
              <span><b>Model</b> {aiProposal.model}</span>
              <span><b>Latency</b> {aiProposal.latencyMs}ms</span>
              <span><b>Eligible</b> {aiProposal.eligibleCount}</span>
              <span><b>GO</b> {aiProposal.decisions.filter((decision) => decision.action === 'GO').length}</span>
              <span><b>WAIT</b> {aiProposal.decisions.filter((decision) => decision.action === 'WAIT').length}</span>
            </div>
            <p className="safety-note">Module 7 independently validates each proposal. AI authorizes nothing and does not execute movement.</p>
            <div className="proposal-list">
              {aiProposal.decisions.map((decision, index) => {
                const safetyResult = aiProposal.safetyValidation?.results[index];
                const executionResult = aiProposal.execution?.results[index];
                const liveVehicle = simulation.vehicles.find((vehicle) => vehicle.id === decision.vehicleId);
                const executionStatus = executionResult?.executionStatus === 'STARTED'
                  ? (liveVehicle?.status === VEHICLE_STATUSES.CROSSING
                    ? 'EXECUTING'
                    : liveVehicle?.status === VEHICLE_STATUSES.EXITED ? 'COMPLETED' : 'STARTED')
                  : executionResult?.executionStatus ?? 'NOT_EXECUTED';
                return (
                <div key={`${decision.vehicleId}-${index}`} className="proposal-row">
                  <span><b>{decision.vehicleId}</b></span>
                  <span className={`proposal-action proposal-action-${decision.action.toLowerCase()}`}>{decision.action}</span>
                  <span>{decision.reasonCode}</span>
                  <span className={`safety-status safety-status-${(safetyResult?.safetyStatus ?? 'NOT_VALIDATED').toLowerCase()}`}>
                    {safetyResult?.safetyStatus ?? 'NOT_VALIDATED'}
                  </span>
                  <span>{safetyResult?.reason ?? 'NOT_VALIDATED'}</span>
                  <span><b>Module 8:</b> {executionStatus} · {executionResult?.reason ?? 'NOT_EXECUTED'}</span>
                </div>
                );
              })}
              {aiProposal.decisions.length === 0 && <span className="approval-empty">No vehicles were eligible for this tick.</span>}
            </div>
          </div>
        )}
      </section>

      <section className="status-card" aria-label="Application status">
        <div className="status-heading">
          <h2>System status</h2>
          <span>Module 7 · Safety validation</span>
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
