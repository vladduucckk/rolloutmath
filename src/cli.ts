import { readFileSync } from "node:fs";
import { argv, exit, stdin } from "node:process";
import { NO_WORKLOAD_ERROR, analyzeManifest, exitCode } from "./lib/analyze";
import { formatMarkdown, formatText } from "./lib/format";
import type { Report } from "./lib/types";

interface Options {
  floor: number | null;
  strict: boolean;
  format: "text" | "json" | "markdown";
  files: string[];
}

const HELP = `rolloutmath — how many pods stay Ready if a rollout never becomes Ready

Usage
  rolloutmath check <file|-> [more files] [--floor N] [--format text|json|markdown] [--strict]

Exit codes
  0  no errors
  1  the document could not be read, or it has no Deployment or StatefulSet
  2  a rollout can leave 0 Ready pods, the strategy is invalid, or --floor / --strict failed

Examples
  rolloutmath check deploy.yaml
  kubectl get deploy -A -o yaml | rolloutmath check -
  rolloutmath check deploy.yaml --floor 3 --format markdown
`;

function parseArgs(
  args: string[],
):
  | { help: true; requested: boolean }
  | { error: string }
  | Options {
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    return {
      help: true,
      requested: args.includes("-h") || args.includes("--help"),
    };
  }
  if (args[0] !== "check") {
    return {
      error: `Unknown command "${args[0]}". Use: rolloutmath check <file>`,
    };
  }

  const options: Options = {
    floor: null,
    strict: false,
    format: "text",
    files: [],
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    const floor = flagValue(args, index, "--floor");
    if (floor.matched) {
      if (floor.error || floor.value == null || !/^\d+$/.test(floor.value)) {
        return { error: "--floor needs a non-negative integer." };
      }
      options.floor = Number(floor.value);
      index += floor.inline ? 0 : 1;
      continue;
    }
    const format = flagValue(args, index, "--format");
    if (format.matched) {
      if (
        format.error ||
        (format.value !== "text" &&
          format.value !== "json" &&
          format.value !== "markdown")
      ) {
        return { error: "--format must be text, json, or markdown." };
      }
      options.format = format.value;
      index += format.inline ? 0 : 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return { error: `Unknown flag ${arg}.` };
    }
    options.files.push(arg);
  }

  if (options.files.length === 0) {
    return { error: "Pass a manifest file, or - to read stdin." };
  }
  return options;
}

async function readInput(file: string): Promise<string> {
  if (file === "-") {
    const buffers: Buffer[] = [];
    for await (const chunk of stdin) buffers.push(Buffer.from(chunk));
    return Buffer.concat(buffers).toString("utf8");
  }
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT";
    throw new Error(missing ? `No such file: ${file}` : `Could not read ${file}.`);
  }
}

function flagValue(
  args: string[],
  index: number,
  flag: string,
): { matched: boolean; inline: boolean; value: string | null; error: boolean } {
  const arg = args[index];
  if (arg === flag) {
    const value = args[index + 1];
    if (value == null || value.startsWith("-")) {
      return { matched: true, inline: false, value: null, error: true };
    }
    return { matched: true, inline: false, value, error: false };
  }
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    return {
      matched: true,
      inline: true,
      value,
      error: value.length === 0,
    };
  }
  return { matched: false, inline: false, value: null, error: false };
}

function merge(texts: string[]): Report {
  const workloads: Report["workloads"] = [];
  for (const text of texts) {
    const report = analyzeManifest(text);
    if (report.error && report.error !== NO_WORKLOAD_ERROR) return report;
    workloads.push(...report.workloads);
  }
  if (workloads.length === 0) {
    return { error: NO_WORKLOAD_ERROR, workloads: [] };
  }
  return { error: null, workloads };
}

function render(report: Report, options: Options): string {
  if (options.format === "json") {
    return JSON.stringify(
      {
        error: report.error,
        requiredFloor: options.floor,
        workloads: report.workloads,
      },
      null,
      2,
    ) + "\n";
  }
  if (options.format === "markdown") return formatMarkdown(report, options.floor);
  return formatText(report, options.floor);
}

async function main() {
  const parsed = parseArgs(argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(HELP);
    exit(parsed.requested ? 0 : 1);
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n${HELP}`);
    exit(1);
  }

  let texts: string[];
  try {
    texts = [];
    for (const file of parsed.files) texts.push(await readInput(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read input.";
    process.stderr.write(`${message}\n`);
    exit(1);
  }

  const report = merge(texts);
  const output = render(report, parsed);
  if (report.error) process.stderr.write(output);
  else process.stdout.write(output);
  exit(exitCode(report, { floor: parsed.floor, strict: parsed.strict }));
}

void main();
