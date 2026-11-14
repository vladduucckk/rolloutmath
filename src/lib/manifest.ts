import { parseAllDocuments } from "yaml";
import { MAX_INT32, parseCpu, parseIntOrPercent, parseMemory } from "./quantity";
import type { IntOrPercent, Kind, Strategy, Workload } from "./types";

export function parseManifests(
  text: string,
): { ok: true; workloads: Workload[] } | { ok: false; error: string } {
  if (!text.trim()) {
    return { ok: false, error: "Paste a Deployment or StatefulSet." };
  }

  let documents;
  try {
    documents = parseAllDocuments(text);
  } catch {
    return { ok: false, error: "That document is not valid YAML or JSON." };
  }

  for (const document of documents) {
    if (document.errors.length > 0) {
      const line = lineOf(document.errors[0]);
      return {
        ok: false,
        error: line
          ? `That document is not valid YAML or JSON at line ${line}.`
          : "That document is not valid YAML or JSON.",
      };
    }
  }

  const objects: unknown[] = [];
  for (const document of documents) collect(document.toJSON(), objects);

  const workloads: Workload[] = [];
  try {
    for (const object of objects) {
      const workload = workloadFromObject(object);
      if (workload) workloads.push(workload);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not read a workload.";
    return { ok: false, error: message };
  }

  return { ok: true, workloads };
}

function collect(value: unknown, out: unknown[]) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if (
    Array.isArray(value.items) &&
    value.kind !== "Deployment" &&
    value.kind !== "StatefulSet"
  ) {
    for (const item of value.items) collect(item, out);
    return;
  }
  out.push(value);
}

export function workloadFromObject(value: unknown): Workload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "Deployment" && value.kind !== "StatefulSet") return null;
  const kind = value.kind;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim()
      ? metadata.name.trim()
      : "(unnamed)";
  const namespace =
    typeof metadata.namespace === "string" && metadata.namespace.trim()
      ? metadata.namespace.trim()
      : "default";
  const ref = `${namespace}/${kind}/${name}`;
  const spec = isRecord(value.spec) ? value.spec : {};

  try {
    return workloadFromSpec(kind, namespace, name, spec, value.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid field";
    throw new Error(`${ref}: ${message}`);
  }
}

function workloadFromSpec(
  kind: Kind,
  namespace: string,
  name: string,
  spec: Record<string, unknown>,
  status: unknown,
): Workload {
  const replicas = optionalInt(spec.replicas, 1, "replicas");
  const minReadySeconds = optionalInt(spec.minReadySeconds, 0, "minReadySeconds");
  const strategy = readStrategy(kind, spec);
  const template = isRecord(spec.template) ? spec.template : {};
  const podSpec = isRecord(template.spec) ? template.spec : {};
  const probes = readProbes(podSpec);
  const requests = effectiveRequests(podSpec);
  const live = readStatus(status);
  const deadline = readDeadline(kind, spec.progressDeadlineSeconds);

  return {
    kind,
    namespace,
    name,
    replicas,
    strategy: strategy.type,
    maxSurge: strategy.maxSurge,
    maxUnavailable: strategy.maxUnavailable,
    surgeDefaulted: strategy.surgeDefaulted,
    unavailableDefaulted: strategy.unavailableDefaulted,
    minReadySeconds,
    progressDeadlineSeconds: deadline.seconds,
    deadlineDefaulted: deadline.defaulted,
    partition: strategy.partition,
    ordinalStart: kind === "StatefulSet" ? readOrdinalStart(spec) : 0,
    paused: kind === "Deployment" && spec.paused === true,
    rejected: strategy.rejected,
    missingReadiness: probes.missingReadiness,
    livenessWithoutStartup: probes.livenessWithoutStartup,
    startupBudgetSeconds: probes.startupBudgetSeconds,
    readinessInitialDelaySeconds: probes.readinessInitialDelaySeconds,
    requestsMilliCpu: requests.cpu,
    requestsBytes: requests.memory,
    timedOut: live.timedOut,
    observedAvailable: live.observedAvailable,
  };
}

function readStrategy(kind: Kind, spec: Record<string, unknown>): {
  type: Strategy;
  maxSurge: IntOrPercent;
  maxUnavailable: IntOrPercent;
  surgeDefaulted: boolean;
  unavailableDefaulted: boolean;
  partition: number;
  rejected: string | null;
} {
  const field = kind === "StatefulSet" ? "updateStrategy" : "strategy";
  const raw = spec[field];
  if (raw != null && !isRecord(raw)) {
    throw new Error(`${field} must be an object.`);
  }
  const strategy = isRecord(raw) ? raw : {};
  if (spec.paused != null && kind === "Deployment" && typeof spec.paused !== "boolean") {
    throw new Error("paused must be true or false.");
  }
  let type = strategy.type ?? "RollingUpdate";
  if (type === "") type = "RollingUpdate";
  if (typeof type !== "string") {
    throw new Error(`${field}.type must be a string.`);
  }
  if (strategy.rollingUpdate != null && !isRecord(strategy.rollingUpdate)) {
    throw new Error("rollingUpdate must be an object.");
  }
  const rollingPresent = strategy.rollingUpdate != null;
  const rolling = isRecord(strategy.rollingUpdate) ? strategy.rollingUpdate : {};
  const zero = { kind: "absolute" as const, value: 0 };
  const blank = {
    maxSurge: zero,
    maxUnavailable: zero,
    surgeDefaulted: false,
    unavailableDefaulted: false,
    partition: 0,
  };

  if (kind === "StatefulSet" && type === "OnDelete") {
    if (rollingPresent) {
      return {
        type: "OnDelete",
        ...blank,
        rejected: "rollingUpdate may not be specified when updateStrategy.type is OnDelete.",
      };
    }
    return { type: "OnDelete", ...blank, rejected: null };
  }
  if (kind === "Deployment" && type === "OnDelete") {
    return {
      type: "OnDelete",
      ...blank,
      rejected: 'Deployment strategy "OnDelete" is not valid. Use RollingUpdate or Recreate.',
    };
  }
  if (kind === "StatefulSet" && type === "Recreate") {
    return {
      type: "Recreate",
      ...blank,
      rejected: "StatefulSet has no Recreate strategy.",
    };
  }
  if (type !== "RollingUpdate" && type !== "Recreate") {
    return {
      type: "RollingUpdate",
      ...blank,
      rejected: `${field}.type "${type}" is not a Kubernetes ${kind} strategy.`,
    };
  }
  if (type === "Recreate") {
    if (rollingPresent) {
      return {
        type: "Recreate",
        ...blank,
        rejected: "rollingUpdate may not be specified when strategy.type is Recreate.",
      };
    }
    return { type: "Recreate", ...blank, rejected: null };
  }

  const surgeDefaulted = kind === "Deployment" && rolling.maxSurge == null;
  const unavailableDefaulted = rolling.maxUnavailable == null;
  const maxSurge =
    kind === "StatefulSet"
      ? zero
      : surgeDefaulted
        ? { kind: "percent" as const, value: 25 }
        : parseIntOrPercent(rolling.maxSurge, "maxSurge");
  const maxUnavailable = unavailableDefaulted
    ? kind === "StatefulSet"
      ? { kind: "absolute" as const, value: 1 }
      : { kind: "percent" as const, value: 25 }
    : parseIntOrPercent(rolling.maxUnavailable, "maxUnavailable");

  return {
    type: "RollingUpdate",
    maxSurge,
    maxUnavailable,
    surgeDefaulted,
    unavailableDefaulted,
    partition:
      kind === "StatefulSet" ? optionalInt(rolling.partition, 0, "partition") : 0,
    rejected: null,
  };
}

function readOrdinalStart(spec: Record<string, unknown>): number {
  if (spec.ordinals == null) return 0;
  if (!isRecord(spec.ordinals)) {
    throw new Error("ordinals must be an object.");
  }
  return optionalInt(spec.ordinals.start, 0, "ordinals.start");
}

function readDeadline(
  kind: Kind,
  raw: unknown,
): { seconds: number | null; defaulted: boolean } {
  if (kind !== "Deployment") return { seconds: null, defaulted: false };
  if (raw == null) return { seconds: 600, defaulted: true };
  const value = optionalInt(raw, 600, "progressDeadlineSeconds");
  if (value >= MAX_INT32) return { seconds: null, defaulted: false };
  return { seconds: value, defaulted: false };
}

function readProbes(podSpec: Record<string, unknown>): {
  missingReadiness: boolean;
  livenessWithoutStartup: boolean;
  startupBudgetSeconds: number | null;
  readinessInitialDelaySeconds: number | null;
} {
  const containers = [
    ...records(podSpec.containers),
    ...records(podSpec.initContainers).filter(
      (container) => container.restartPolicy === "Always",
    ),
  ];
  let missingReadiness = containers.length === 0;
  let livenessWithoutStartup = false;
  let startupBudgetSeconds: number | null = null;
  let readinessInitialDelaySeconds: number | null = null;

  for (const container of containers) {
    const startup = probeOf(container.startupProbe);
    const readiness = probeOf(container.readinessProbe);
    const liveness = probeOf(container.livenessProbe);
    if (!readiness) missingReadiness = true;
    if (liveness && !startup) livenessWithoutStartup = true;
    if (startup) {
      const budget = probeBudget(startup);
      startupBudgetSeconds =
        startupBudgetSeconds == null
          ? budget
          : Math.max(startupBudgetSeconds, budget);
    }
    if (readiness) {
      readinessInitialDelaySeconds =
        readinessInitialDelaySeconds == null
          ? readiness.initialDelaySeconds
          : Math.max(
              readinessInitialDelaySeconds,
              readiness.initialDelaySeconds,
            );
    }
  }

  return {
    missingReadiness,
    livenessWithoutStartup,
    startupBudgetSeconds,
    readinessInitialDelaySeconds,
  };
}

function probeOf(raw: unknown): {
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
} | null {
  if (!isRecord(raw)) return null;
  return {
    initialDelaySeconds: optionalInt(
      raw.initialDelaySeconds,
      0,
      "probe initialDelaySeconds",
    ),
    periodSeconds: optionalInt(raw.periodSeconds, 10, "probe periodSeconds"),
    failureThreshold: optionalInt(
      raw.failureThreshold,
      3,
      "probe failureThreshold",
    ),
  };
}

export function probeBudget(probe: {
  initialDelaySeconds: number;
  periodSeconds: number;
  failureThreshold: number;
}): number {
  return (
    probe.initialDelaySeconds +
    Math.max(probe.periodSeconds, 1) * Math.max(probe.failureThreshold, 1)
  );
}

/**
 * Scheduling request from AggregateContainerRequests (KEP-753), then pod-level
 * requests (beta, on by default since 1.34) and RuntimeClass overhead.
 *
 * Regular init containers run one at a time. A restartable init container
 * (restartPolicy Always) stays up, so later inits have to fit beside it.
 * The pod request is the high water mark of that sequence and of the
 * long-running containers. Sidecars are not added on top of an earlier init
 * that already exceeded them: order in the list is the start order.
 */
export function effectiveRequests(podSpec: Record<string, unknown>): {
  cpu: number;
  memory: number;
} {
  let cpu = 0;
  let memory = 0;
  for (const container of records(podSpec.containers)) {
    cpu += containerRequest(container, "cpu");
    memory += containerRequest(container, "memory");
  }

  let sidecarCpu = 0;
  let sidecarMemory = 0;
  let initCpu = 0;
  let initMemory = 0;
  for (const init of records(podSpec.initContainers)) {
    const stepCpu = containerRequest(init, "cpu");
    const stepMemory = containerRequest(init, "memory");
    if (init.restartPolicy === "Always") {
      cpu += stepCpu;
      memory += stepMemory;
      sidecarCpu += stepCpu;
      sidecarMemory += stepMemory;
      initCpu = Math.max(initCpu, sidecarCpu);
      initMemory = Math.max(initMemory, sidecarMemory);
    } else {
      initCpu = Math.max(initCpu, stepCpu + sidecarCpu);
      initMemory = Math.max(initMemory, stepMemory + sidecarMemory);
    }
  }
  cpu = Math.max(cpu, initCpu);
  memory = Math.max(memory, initMemory);

  const podResources = isRecord(podSpec.resources) ? podSpec.resources : {};
  const podRequests = isRecord(podResources.requests) ? podResources.requests : {};
  if (isQuantity(podRequests.cpu)) cpu = quantity(podRequests.cpu, "cpu");
  if (isQuantity(podRequests.memory)) memory = quantity(podRequests.memory, "memory");

  const overhead = isRecord(podSpec.overhead) ? podSpec.overhead : {};
  if (isQuantity(overhead.cpu)) cpu += quantity(overhead.cpu, "cpu");
  if (isQuantity(overhead.memory)) memory += quantity(overhead.memory, "memory");
  return { cpu, memory };
}

function containerRequest(
  container: Record<string, unknown>,
  resource: "cpu" | "memory",
): number {
  const resources = isRecord(container.resources) ? container.resources : {};
  const requests = isRecord(resources.requests) ? resources.requests : {};
  const raw = requests[resource];
  if (!isQuantity(raw)) return 0;
  return quantity(raw, resource);
}

function isQuantity(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function quantity(value: string | number, resource: "cpu" | "memory"): number {
  return resource === "cpu" ? parseCpu(value) : parseMemory(value);
}

function readStatus(status: unknown): {
  timedOut: boolean;
  observedAvailable: number | null;
} {
  if (!isRecord(status)) return { timedOut: false, observedAvailable: null };
  const observedAvailable =
    typeof status.availableReplicas === "number" &&
    Number.isInteger(status.availableReplicas)
      ? status.availableReplicas
      : null;
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const timedOut = conditions.some((condition) => {
    if (!isRecord(condition)) return false;
    return (
      condition.type === "Progressing" &&
      condition.status === "False" &&
      condition.reason === "ProgressDeadlineExceeded"
    );
  });
  return { timedOut, observedAvailable };
}

function optionalInt(value: unknown, fallback: number, field: string): number {
  if (value == null) return fallback;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_INT32
  ) {
    return value;
  }
  throw new Error(`${field} must be an integer from 0 to 2147483647.`);
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineOf(error: unknown): number | null {
  if (!isRecord(error) || !Array.isArray(error.linePos)) return null;
  const start = error.linePos[0];
  if (!isRecord(start) || typeof start.line !== "number") return null;
  return start.line;
}
