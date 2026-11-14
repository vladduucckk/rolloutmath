import { formatCpu, formatMemory } from "./quantity";
import { simulate } from "./simulate";
import { parseManifests } from "./manifest";
import type { Finding, Report, Workload, WorkloadReport } from "./types";
import { workloadRef } from "./types";

export const NO_WORKLOAD_ERROR =
  "No Deployment or StatefulSet in that document. Other kinds are skipped.";

export function analyzeManifest(text: string): Report {
  const parsed = parseManifests(text);
  if (!parsed.ok) return { error: parsed.error, workloads: [] };
  if (parsed.workloads.length === 0) {
    return { error: NO_WORKLOAD_ERROR, workloads: [] };
  }
  return {
    error: null,
    workloads: parsed.workloads.map(analyzeWorkload),
  };
}

export function analyzeWorkload(workload: Workload): WorkloadReport {
  const simulation = simulate(workload);
  const findings: Finding[] = [];
  const ref = workloadRef(workload);

  if (simulation.invalid) {
    findings.push({
      severity: "error",
      code: "INVALID_STRATEGY",
      message: `${ref}: ${simulation.invalid}`,
    });
    return { workload, simulation, findings };
  }

  if (workload.paused) {
    findings.push({
      severity: "info",
      code: "PAUSED",
      message: `${ref} is paused, so this rollout will not start until it is resumed. The floor is what happens after resume if the new pods never become Ready.`,
    });
  }

  if (workload.replicas === 0) {
    findings.push({
      severity: "info",
      code: "SCALED_TO_ZERO",
      message: `${ref} sets spec.replicas to 0. There is no rollout to keep Ready.`,
    });
    return { workload, simulation, findings };
  }

  if (workload.strategy === "OnDelete") {
    findings.push({
      severity: "info",
      code: "ON_DELETE",
      message: `${ref} uses OnDelete. Pods stay on the current revision until something deletes them, so a template change leaves all ${workload.replicas} Ready.`,
    });
  }

  if (simulation.bumpedUnavailable) {
    findings.push({
      severity: "info",
      code: "FENCEPOST",
      message: `maxSurge and maxUnavailable both round to 0 for ${workload.replicas} replicas. The controller sets maxUnavailable to 1 so the rollout can move.`,
    });
  }

  if (simulation.unavailableRaised) {
    findings.push({
      severity: "info",
      code: "UNAVAILABLE_MINIMUM",
      message: `maxUnavailable rounds down to 0 for ${workload.replicas} replicas. The StatefulSet controller raises it to 1.`,
    });
  }

  if (workload.kind === "StatefulSet") {
    if (workload.unavailableDefaulted && workload.strategy === "RollingUpdate") {
      findings.push({
        severity: "info",
        code: "API_DEFAULT",
        message: "maxUnavailable is omitted, so the StatefulSet default of 1 applies.",
      });
    }
  } else if (workload.surgeDefaulted || workload.unavailableDefaulted) {
    const omitted = [
      workload.surgeDefaulted ? "maxSurge" : null,
      workload.unavailableDefaulted ? "maxUnavailable" : null,
    ].filter((item): item is string => item != null);
    const verb = omitted.length > 1 ? "are" : "is";
    findings.push({
      severity: "info",
      code: "API_DEFAULT",
      message: `${omitted.join(" and ")} ${verb} omitted, so the API default applies. Resolved maxSurge is ${simulation.maxSurge} and maxUnavailable is ${simulation.maxUnavailable}.`,
    });
  }

  if (workload.strategy !== "OnDelete") {
    if (simulation.readyFloor === 0) {
      const message =
        workload.strategy === "Recreate"
          ? `${ref} uses Recreate. Old pods are deleted before new ones exist, so a version that never becomes Ready leaves 0 pods Ready.`
          : `${ref} keeps 0 pods Ready if the new ones never become Ready. maxUnavailable resolves to ${simulation.maxUnavailable} on ${workload.replicas} replica${workload.replicas === 1 ? "" : "s"}.`;
      findings.push({ severity: "error", code: "FLOOR_ZERO", message });
    } else if (simulation.readyFloor === workload.replicas) {
      const extra =
        simulation.newUnready > 0
          ? `, and leaves ${simulation.newUnready} new pod${simulation.newUnready === 1 ? "" : "s"} NotReady`
          : "";
      findings.push({
        severity: "info",
        code: "FLOOR_FULL",
        message: `${ref} keeps all ${workload.replicas} pods Ready if the new version never becomes Ready${extra}.`,
      });
    } else {
      findings.push({
        severity: "info",
        code: "FLOOR_PARTIAL",
        message: `${ref} keeps ${simulation.readyFloor} of ${workload.replicas} pods Ready if the new version never becomes Ready. ${simulation.newUnready} new pod${simulation.newUnready === 1 ? " stays" : "s stay"} NotReady.`,
      });
    }
  }

  if (
    workload.strategy !== "OnDelete" &&
    simulation.newUnready > 0 &&
    (workload.requestsMilliCpu > 0 || workload.requestsBytes > 0)
  ) {
    const parts: string[] = [];
    if (workload.requestsMilliCpu > 0) {
      parts.push(
        `${formatCpu(simulation.newUnready * workload.requestsMilliCpu)} CPU`,
      );
    }
    if (workload.requestsBytes > 0) {
      parts.push(
        `${formatMemory(simulation.newUnready * workload.requestsBytes)} memory`,
      );
    }
    const reserved =
      simulation.newUnready === 1
        ? "That NotReady pod still reserves"
        : `Those ${simulation.newUnready} NotReady pods still reserve`;
    findings.push({
      severity: "info",
      code: "EXTRA_REQUESTS",
      message: `${reserved} ${parts.join(" and ")}, on top of the pods that stay Ready.`,
    });
  }

  if (workload.missingReadiness) {
    findings.push({
      severity: "warning",
      code: "NO_READINESS",
      message: `${ref} has a container without a readiness probe. The rollout marks the pod Ready as soon as its process starts, before it is listening.`,
    });
  }

  if (workload.livenessWithoutStartup) {
    findings.push({
      severity: "warning",
      code: "LIVENESS_WITHOUT_STARTUP",
      message: `${ref} sets a liveness probe and no startup probe. A slow boot can be killed before the process is ready, and the rollout never makes progress.`,
    });
  }

  const deadline = workload.progressDeadlineSeconds;
  if (deadline != null) {
    if (workload.minReadySeconds >= deadline) {
      findings.push({
        severity: "error",
        code: "MIN_READY_EXCEEDS_DEADLINE",
        message: `${ref} sets minReadySeconds to ${workload.minReadySeconds} and progressDeadlineSeconds to ${deadline}. A pod cannot become available before the progress deadline, so the Deployment is marked ProgressDeadlineExceeded even when the new pods are Ready.`,
      });
    }
    const readinessDelay = workload.readinessInitialDelaySeconds ?? 0;
    if (
      workload.startupBudgetSeconds != null &&
      workload.startupBudgetSeconds + readinessDelay + workload.minReadySeconds > deadline
    ) {
      const afterStartup =
        readinessDelay > 0
          ? `, then waits ${readinessDelay}s before the first readiness probe,`
          : "";
      findings.push({
        severity: "warning",
        code: "STARTUP_EXCEEDS_DEADLINE",
        message: `${ref} lets a startup probe run for about ${workload.startupBudgetSeconds}s (initialDelay + period × failureThreshold) before it is declared failed${afterStartup}, then waits another ${workload.minReadySeconds}s for minReadySeconds. progressDeadlineSeconds is ${deadline}, so a slow but legal start can be marked ProgressDeadlineExceeded.`,
      });
    }
    if (
      workload.startupBudgetSeconds == null &&
      workload.readinessInitialDelaySeconds != null &&
      workload.readinessInitialDelaySeconds >= deadline
    ) {
      findings.push({
        severity: "warning",
        code: "READINESS_DELAY_EXCEEDS_DEADLINE",
        message: `${ref} waits ${workload.readinessInitialDelaySeconds}s before the first readiness check, and progressDeadlineSeconds is ${deadline}. The deadline can fire before that probe runs.`,
      });
    }
  }

  if (workload.timedOut) {
    const observed =
      workload.observedAvailable == null
        ? "The live status does not say how many replicas are available."
        : `The live status reports ${workload.observedAvailable} available.`;
    findings.push({
      severity: "error",
      code: "ALREADY_TIMED_OUT",
      message: `${ref} is already ProgressDeadlineExceeded. ${observed} This spec sits at ${simulation.readyFloor} Ready when new pods never become Ready.`,
    });
  }

  return { workload, simulation, findings };
}

export function exitCode(
  report: Report,
  options: { floor: number | null; strict: boolean },
): number {
  if (report.error || report.workloads.length === 0) return 1;
  for (const item of report.workloads) {
    for (const finding of item.findings) {
      if (finding.severity === "error") return 2;
      if (options.strict && finding.severity === "warning") return 2;
    }
    if (
      options.floor != null &&
      item.workload.replicas > 0 &&
      item.simulation.invalid == null &&
      item.simulation.readyFloor < options.floor
    ) {
      return 2;
    }
  }
  return 0;
}
