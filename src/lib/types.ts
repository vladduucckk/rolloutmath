export type Kind = "Deployment" | "StatefulSet";
export type Strategy = "RollingUpdate" | "Recreate" | "OnDelete";

export interface IntOrPercent {
  kind: "absolute" | "percent";
  value: number;
}

export interface Workload {
  kind: Kind;
  namespace: string;
  name: string;
  replicas: number;
  strategy: Strategy;
  maxSurge: IntOrPercent;
  maxUnavailable: IntOrPercent;
  surgeDefaulted: boolean;
  unavailableDefaulted: boolean;
  minReadySeconds: number;
  /** Null for StatefulSet, which has no progress deadline. */
  progressDeadlineSeconds: number | null;
  deadlineDefaulted: boolean;
  /**
   * StatefulSet rolling update skips replica indexes below this value.
   * Index 0 is the lowest ordinal, which equals the ordinal only when
   * spec.ordinals.start is 0. The 1.37 controller compares this number to
   * the index, not to the ordinal.
   */
  partition: number;
  /** spec.ordinals.start. Pod ordinals are start, start+1, ... */
  ordinalStart: number;
  /** Deployment spec.paused. The controller will not roll until this is cleared. */
  paused: boolean;
  /**
   * Set when the object would be rejected by the API server for a strategy
   * reason other than the surge and unavailable numbers. Those numbers are
   * checked in the simulator so the calculator and the manifest share one path.
   */
  rejected: string | null;
  missingReadiness: boolean;
  livenessWithoutStartup: boolean;
  /** Seconds until a startup probe can exhaust its failure budget. Null if unset. */
  startupBudgetSeconds: number | null;
  /** Largest readiness initialDelay on a container that has no startup probe. */
  readinessInitialDelaySeconds: number | null;
  requestsMilliCpu: number;
  requestsBytes: number;
  timedOut: boolean;
  observedAvailable: number | null;
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export type StepAction = "scale-new" | "scale-old" | "steady";

export interface SimStep {
  sync: number;
  action: StepAction;
  title: string;
  detail: string;
  oldReplicas: number;
  newReplicas: number;
  ready: number;
  total: number;
}

export interface Simulation {
  invalid: string | null;
  maxSurge: number;
  maxUnavailable: number;
  minAvailable: number;
  readyFloor: number;
  newUnready: number;
  totalAtFloor: number;
  /** Deployment fencepost: both scaled values were 0, so unavailable became 1. */
  bumpedUnavailable: boolean;
  /**
   * StatefulSet only. A percentage rounded down to 0 and the controller
   * raised it to 1. Explicit 0 is rejected instead.
   */
  unavailableRaised: boolean;
  steps: SimStep[];
}

export interface WorkloadReport {
  workload: Workload;
  simulation: Simulation;
  findings: Finding[];
}

export interface Report {
  error: string | null;
  workloads: WorkloadReport[];
}

export function workloadRef(workload: Workload): string {
  return `${workload.namespace}/${workload.kind}/${workload.name}`;
}
