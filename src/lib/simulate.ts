import { scaleIntOrPercent } from "./quantity";
import type { IntOrPercent, SimStep, Simulation, Workload } from "./types";

const DEFAULT_SURGE: IntOrPercent = { kind: "percent", value: 25 };
const DEFAULT_UNAVAILABLE: IntOrPercent = { kind: "percent", value: 25 };

/**
 * Walks the Deployment rolling-update loop from Kubernetes 1.33
 * (pkg/controller/deployment/rolling.go). Each sync either scales the new
 * ReplicaSet or the old one, never both. New pods are modeled as never
 * becoming Ready, which is the stalled rollout.
 */
export function simulate(workload: Workload): Simulation {
  if (workload.rejected) return invalidSimulation(workload.rejected);
  if (workload.kind === "StatefulSet") {
    if (workload.strategy === "OnDelete") return simulateOnDelete(workload);
    return simulateStatefulSet(workload);
  }
  if (workload.strategy === "OnDelete") {
    return invalidSimulation(
      'Deployment strategy "OnDelete" is not valid. Use RollingUpdate or Recreate.',
    );
  }
  if (workload.strategy === "Recreate") {
    if (workload.replicas === 0) return scaledToZero();
    return simulateRecreate(workload);
  }
  return simulateDeployment(workload);
}

function simulateRecreate(workload: Workload): Simulation {
  const desired = workload.replicas;
  const steps: SimStep[] = [
    {
      sync: 1,
      action: "scale-old",
      title: "Old ReplicaSet scaled to 0",
      detail:
        "Recreate deletes every old pod before it creates a new one. Ready pods hit 0 in that gap.",
      oldReplicas: 0,
      newReplicas: 0,
      ready: 0,
      total: 0,
    },
    {
      sync: 2,
      action: "scale-new",
      title: `New ReplicaSet scaled to ${desired}`,
      detail:
        "The new pods are created only after the old ones are gone. They never become Ready.",
      oldReplicas: 0,
      newReplicas: desired,
      ready: 0,
      total: desired,
    },
    {
      sync: 3,
      action: "steady",
      title: "Controller stops",
      detail: "Recreate has no overlap. Nothing is Ready until the new pods are.",
      oldReplicas: 0,
      newReplicas: desired,
      ready: 0,
      total: desired,
    },
  ];
  return {
    invalid: null,
    maxSurge: 0,
    maxUnavailable: desired,
    minAvailable: 0,
    readyFloor: 0,
    newUnready: desired,
    totalAtFloor: desired,
    bumpedUnavailable: false,
    unavailableRaised: false,
    steps,
  };
}

function simulateDeployment(workload: Workload): Simulation {
  const desired = workload.replicas;
  const surge = workload.maxSurge;
  const unavailable = workload.maxUnavailable;
  // Admission rejects the raw values, before rounding. 0% counts as 0.
  // A small non-zero percent that rounds to 0 is allowed and handled below.
  if (surge.value === 0 && unavailable.value === 0) {
    return invalidSimulation(
      "maxSurge and maxUnavailable are both 0. A value of 0% counts as 0. The API server rejects that Deployment, because the rollout could never move.",
    );
  }
  if (unavailable.kind === "percent" && unavailable.value > 100) {
    return invalidSimulation(
      "maxUnavailable must not be greater than 100%. The API server rejects it.",
    );
  }
  if (desired === 0) return scaledToZero();

  const fence = resolveFenceposts(surge, unavailable, desired);
  const maxSurge = fence.surge;
  let maxUnavailable = fence.unavailable;
  if (maxUnavailable > desired) maxUnavailable = desired;
  const minAvailable = desired - maxUnavailable;

  let old = desired;
  let neu = 0;
  const steps: SimStep[] = [];
  let stopped = false;

  for (let sync = 1; sync <= 32; sync += 1) {
    const scaled = scaleOnce(old, neu, desired, maxSurge, minAvailable);
    if (scaled.kind === "steady") {
      steps.push(steadyStep(sync, old, neu, minAvailable, maxUnavailable));
      stopped = true;
      break;
    }
    old = scaled.old;
    neu = scaled.neu;
    steps.push({
      sync,
      action: scaled.action,
      title: scaled.title,
      detail: scaled.detail,
      oldReplicas: old,
      newReplicas: neu,
      ready: old,
      total: old + neu,
    });
  }

  if (!stopped) {
    return invalidSimulation(
      "The rollout model did not converge. Check the strategy values.",
    );
  }

  const last = steps[steps.length - 1];
  return {
    invalid: null,
    maxSurge,
    maxUnavailable,
    minAvailable,
    readyFloor: last.ready,
    newUnready: last.newReplicas,
    totalAtFloor: last.total,
    bumpedUnavailable: fence.bumped,
    unavailableRaised: false,
    steps,
  };
}

function scaleOnce(
  old: number,
  neu: number,
  desired: number,
  maxSurge: number,
  minAvailable: number,
):
  | { kind: "steady" }
  | {
      kind: "scaled";
      action: "scale-new" | "scale-old";
      title: string;
      detail: string;
      old: number;
      neu: number;
    } {
  // New pods are modeled as never Available, so newRSUnavailable equals the
  // new spec. Both scale-down gates in rolling.go then reduce to
  // old - minAvailable. The controller scales the new ReplicaSet first and
  // returns, so one call here is one sync.
  if (neu < desired) {
    const current = old + neu;
    const maxTotal = desired + maxSurge;
    if (current < maxTotal) {
      const scaleUp = Math.min(maxTotal - current, desired - neu);
      if (scaleUp > 0) {
        const next = neu + scaleUp;
        return {
          kind: "scaled",
          action: "scale-new",
          title: `New ReplicaSet scaled to ${next}`,
          detail: `Old ReplicaSet stays at ${old}. The new pods are not Ready, so Ready stays ${old}. Total pods: ${old + next}.`,
          old,
          neu: next,
        };
      }
    }
  }

  if (old === 0) return { kind: "steady" };
  const newUnavailable = neu;
  const maxScaledDown = old + neu - minAvailable - newUnavailable;
  if (maxScaledDown <= 0) return { kind: "steady" };
  if (old <= minAvailable) return { kind: "steady" };
  const scaleDown = Math.min(old, old - minAvailable, maxScaledDown);
  if (scaleDown <= 0) return { kind: "steady" };
  const nextOld = old - scaleDown;
  return {
    kind: "scaled",
    action: "scale-old",
    title: `Old ReplicaSet scaled to ${nextOld}`,
    detail: `Ready pods drop from ${old} to ${nextOld}. The controller will not go below ${minAvailable} while the new pods are NotReady.`,
    old: nextOld,
    neu,
  };
}

function steadyStep(
  sync: number,
  old: number,
  neu: number,
  minAvailable: number,
  maxUnavailable: number,
): SimStep {
  const detail =
    maxUnavailable === 0
      ? `maxUnavailable is 0, so old pods stay up until new pods become Ready. A failed rollout keeps all ${old} Ready, and ${neu} new pods sit NotReady.`
      : `Available pods are at the minimum of ${minAvailable}. The new pods are still NotReady, so this is where the failed rollout sits until someone rolls it back.`;
  return {
    sync,
    action: "steady",
    title: "Controller stops",
    detail,
    oldReplicas: old,
    newReplicas: neu,
    ready: old,
    total: old + neu,
  };
}

function resolveFenceposts(
  maxSurge: IntOrPercent,
  maxUnavailable: IntOrPercent,
  desired: number,
): { surge: number; unavailable: number; bumped: boolean } {
  const surge = scaleIntOrPercent(maxSurge, desired, true);
  let unavailable = scaleIntOrPercent(maxUnavailable, desired, false);
  let bumped = false;
  if (surge === 0 && unavailable === 0) {
    unavailable = 1;
    bumped = true;
  }
  return { surge, unavailable, bumped };
}

function simulateOnDelete(workload: Workload): Simulation {
  const desired = workload.replicas;
  if (desired === 0) return scaledToZero();
  return {
    invalid: null,
    maxSurge: 0,
    maxUnavailable: 0,
    minAvailable: desired,
    readyFloor: desired,
    newUnready: 0,
    totalAtFloor: desired,
    bumpedUnavailable: false,
    unavailableRaised: false,
    steps: [
      {
        sync: 1,
        action: "steady",
        title: "OnDelete does not replace pods",
        detail:
          "The controller leaves every pod on its current revision until something deletes it. A template change alone does not take Ready pods down.",
        oldReplicas: desired,
        newReplicas: 0,
        ready: desired,
        total: desired,
      },
    ],
  };
}

function simulateStatefulSet(workload: Workload): Simulation {
  const desired = workload.replicas;
  const unavailable = workload.maxUnavailable;
  if (unavailable.value === 0) {
    return invalidSimulation(
      "StatefulSet maxUnavailable cannot be 0. A value of 0% counts as 0. The API server rejects it.",
    );
  }
  if (unavailable.kind === "percent" && unavailable.value > 100) {
    return invalidSimulation(
      "maxUnavailable must not be greater than 100%. The API server rejects it.",
    );
  }
  if (desired === 0) return scaledToZero();

  // getStatefulSetMaxUnavailable rounds the percentage down, then raises a
  // 0 to 1. Explicit 0 is rejected above. Absolute numbers are used as-is.
  let maxUnavailable = scaleIntOrPercent(unavailable, desired, false);
  let unavailableRaised = false;
  if (maxUnavailable < 1) {
    maxUnavailable = 1;
    unavailableRaised = true;
  }
  if (maxUnavailable > desired) maxUnavailable = desired;

  // The controller stores pods in a slice indexed from the lowest ordinal.
  // It updates while index >= partition. That index equals the ordinal only
  // when spec.ordinals.start is 0.
  const partition = Math.max(workload.partition, 0);
  const firstIndex = Math.min(partition, desired);
  const candidates = desired - firstIndex;
  const unready = Math.min(maxUnavailable, candidates);
  const floor = desired - unready;
  const highest = workload.ordinalStart + desired - 1;
  const lowestUpdated = highest - unready + 1;
  const ordinals =
    workload.ordinalStart === 0
      ? ""
      : ` Ordinals run from ${workload.ordinalStart} to ${highest}; partition is compared to the index, not the ordinal.`;

  const updating =
    unready === 0
      ? `partition ${partition} is past the last index in this set of ${desired}, so the controller updates nothing.${ordinals}`
      : unready === 1
        ? `The controller updates ordinal ${highest} first. That pod never becomes Ready, so lower ordinals stay on the old revision.${ordinals}`
        : `The controller may have ${unready} pods NotReady at once, starting at ordinal ${highest} down through ${lowestUpdated}. Lower ordinals stay on the old revision.${ordinals}`;

  const steps: SimStep[] = [
    {
      sync: 1,
      action: unready === 0 ? "steady" : "scale-new",
      title: unready === 0 ? "No pods updated" : `${unready} pod${unready === 1 ? "" : "s"} updated`,
      detail: updating,
      oldReplicas: floor,
      newReplicas: unready,
      ready: floor,
      total: desired,
    },
    {
      sync: 2,
      action: "steady",
      title: "Controller stops",
      detail:
        unready === 0
          ? "Every pod stays Ready because none of them are in the update partition."
          : "A StatefulSet does not surge. It waits for the updated pods to become Ready before it continues down the ordinals.",
      oldReplicas: floor,
      newReplicas: unready,
      ready: floor,
      total: desired,
    },
  ];

  return {
    invalid: null,
    maxSurge: 0,
    maxUnavailable,
    minAvailable: floor,
    readyFloor: floor,
    newUnready: unready,
    totalAtFloor: desired,
    bumpedUnavailable: false,
    unavailableRaised,
    steps,
  };
}

function scaledToZero(): Simulation {
  return {
    invalid: null,
    maxSurge: 0,
    maxUnavailable: 0,
    minAvailable: 0,
    readyFloor: 0,
    newUnready: 0,
    totalAtFloor: 0,
    bumpedUnavailable: false,
    unavailableRaised: false,
    steps: [
      {
        sync: 1,
        action: "steady",
        title: "Scaled to zero",
        detail: "spec.replicas is 0, so there is nothing to roll.",
        oldReplicas: 0,
        newReplicas: 0,
        ready: 0,
        total: 0,
      },
    ],
  };
}

function invalidSimulation(invalid: string): Simulation {
  return emptySimulation(invalid);
}

function emptySimulation(invalid: string): Simulation {
  return {
    invalid: invalid || null,
    maxSurge: 0,
    maxUnavailable: 0,
    minAvailable: 0,
    readyFloor: 0,
    newUnready: 0,
    totalAtFloor: 0,
    bumpedUnavailable: false,
    unavailableRaised: false,
    steps: [],
  };
}

export { DEFAULT_SURGE, DEFAULT_UNAVAILABLE };
