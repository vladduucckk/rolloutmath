import { formatIntOrPercent } from "./quantity";
import type { Report, WorkloadReport } from "./types";
import { workloadRef } from "./types";

/** Travels with every copied/CI report so a floor is not read as a broader SLA. */
export const READY_FLOOR_ASSUMPTION =
  "Assumption: old pods start Ready and stay Ready. This is a stalled-rollout Ready floor, not a broader availability guarantee — node failures or already-NotReady old pods can go lower.";

export function formatText(report: Report, floor: number | null): string {
  if (report.error) return `${report.error}\n`;
  const blocks = report.workloads.map((item) => formatWorkloadText(item));
  const floorNotes = floorNotesFor(report, floor);
  return [...blocks, ...floorNotes].join("\n\n") + "\n";
}

export function formatMarkdown(report: Report, floor: number | null): string {
  if (report.error) return `${report.error}\n`;
  const blocks = report.workloads.map((item) => formatWorkloadMarkdown(item));
  const notes = floorNotesFor(report, floor);
  const noteBlock =
    notes.length > 0 ? `\n\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
  return blocks.join("\n\n") + noteBlock + "\n";
}

function formatWorkloadText(item: WorkloadReport): string {
  const { workload, simulation, findings } = item;
  const lines = [
    workloadRef(workload),
    `  ${workload.replicas} replicas, ${workload.strategy}`,
  ];
  if (simulation.invalid) {
    lines.push(`  error  ${simulation.invalid}`);
  } else {
    lines.push(
      `  maxSurge ${formatIntOrPercent(workload.maxSurge)} -> ${simulation.maxSurge}, maxUnavailable ${formatIntOrPercent(workload.maxUnavailable)} -> ${simulation.maxUnavailable}`,
    );
    lines.push(
      `  if new pods never become Ready: ${simulation.readyFloor} stay Ready, ${simulation.newUnready} new pods stay NotReady, ${simulation.totalAtFloor} pods total`,
    );
    lines.push(`  ${READY_FLOOR_ASSUMPTION}`);
    for (const step of simulation.steps) {
      lines.push(`  ${step.sync}. ${step.title}. ${step.detail}`);
    }
  }
  for (const finding of findings) {
    lines.push(`  ${finding.severity}  ${finding.code}  ${finding.message}`);
  }
  return lines.join("\n");
}

function formatWorkloadMarkdown(item: WorkloadReport): string {
  const { workload, simulation, findings } = item;
  const ref = workloadRef(workload);
  if (simulation.invalid) {
    return `## ${ref}\n\n${simulation.invalid}`;
  }
  const rows = simulation.steps
    .map(
      (step) =>
        `| ${step.sync} | ${step.title} | ${step.ready} | ${step.newReplicas} | ${step.total} |`,
    )
    .join("\n");
  const findingLines = findings
    .map((finding) => `- **${finding.severity} ${finding.code}.** ${finding.message}`)
    .join("\n");
  return [
    `## ${ref}`,
    "",
    `${simulation.readyFloor} of ${workload.replicas} pods stay Ready if the new version never becomes Ready. ${simulation.newUnready} new pods stay NotReady (${simulation.totalAtFloor} pods total).`,
    "",
    `_${READY_FLOOR_ASSUMPTION}_`,
    "",
    `| step | what the controller does | ready | new, not ready | total |`,
    `| --- | --- | --- | --- | --- |`,
    rows,
    "",
    findingLines,
  ].join("\n");
}

function floorNotesFor(report: Report, floor: number | null): string[] {
  if (floor == null || report.error) return [];
  return report.workloads
    .filter(
      (item) =>
        item.workload.replicas > 0 &&
        item.simulation.invalid == null &&
        item.simulation.readyFloor < floor,
    )
    .map(
      (item) =>
        `${workloadRef(item.workload)} keeps ${item.simulation.readyFloor} Ready, below the required floor of ${floor}.`,
    );
}
