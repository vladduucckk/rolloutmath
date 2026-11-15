"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { analyzeManifest, analyzeWorkload } from "@/lib/analyze";
import { formatMarkdown, READY_FLOOR_ASSUMPTION } from "@/lib/format";
import { workloadFromObject } from "@/lib/manifest";
import { parseCpu, parseMemory } from "@/lib/quantity";
import type { Report, SimStep, Workload, WorkloadReport } from "@/lib/types";
import { workloadRef } from "@/lib/types";

type Mode = "calculator" | "yaml";
type Kind = "Deployment" | "StatefulSet";
type Strategy = "RollingUpdate" | "Recreate";

interface Draft {
  kind: Kind;
  name: string;
  namespace: string;
  replicas: string;
  strategy: Strategy;
  maxSurge: string;
  maxUnavailable: string;
  minReadySeconds: string;
  progressDeadlineSeconds: string;
  partition: string;
  readiness: boolean;
  liveness: boolean;
  hasStartup: boolean;
  startupDelay: string;
  startupPeriod: string;
  startupFailures: string;
  cpu: string;
  memory: string;
}

const DOCUMENTED_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: shop
spec:
  replicas: 10
  strategy:
    rollingUpdate:
      maxSurge: 3
      maxUnavailable: 2
  template:
    spec:
      containers:
        - name: api
          image: shop/api:1.4.0
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
`;

const samples: Array<{ id: string; label: string; draft: Draft; yaml: string }> = [
  {
    id: "documented",
    label: "10 replicas, surge 3",
    draft: draft({
      replicas: "10",
      maxSurge: "3",
      maxUnavailable: "2",
      cpu: "100m",
      memory: "128Mi",
    }),
    yaml: DOCUMENTED_YAML,
  },
  {
    id: "zero",
    label: "Drops to zero",
    draft: draft({
      name: "checkout",
      replicas: "1",
      maxSurge: "0",
      maxUnavailable: "1",
      cpu: "200m",
      memory: "256Mi",
    }),
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout
  namespace: shop
spec:
  replicas: 1
  strategy:
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: checkout
          image: shop/checkout:8
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
`,
  },
  {
    id: "full",
    label: "Unavailable 0",
    draft: draft({
      name: "web",
      replicas: "4",
      maxSurge: "1",
      maxUnavailable: "0",
    }),
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: shop
spec:
  replicas: 4
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
        - name: web
          image: shop/web:2
          readinessProbe:
            httpGet:
              path: /
              port: 80
`,
  },
  {
    id: "recreate",
    label: "Recreate",
    draft: draft({
      name: "batch",
      replicas: "4",
      strategy: "Recreate",
    }),
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: batch
  namespace: shop
spec:
  replicas: 4
  strategy:
    type: Recreate
  template:
    spec:
      containers:
        - name: batch
          image: shop/batch:1
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
`,
  },
  {
    id: "deadline",
    label: "Startup vs deadline",
    draft: draft({
      name: "slow",
      replicas: "2",
      maxSurge: "1",
      maxUnavailable: "0",
      progressDeadlineSeconds: "30",
      hasStartup: true,
      startupPeriod: "10",
      startupFailures: "12",
    }),
    yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: slow
  namespace: shop
spec:
  replicas: 2
  progressDeadlineSeconds: 30
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
        - name: slow
          image: shop/slow:1
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
          startupProbe:
            httpGet:
              path: /ready
              port: 8080
            periodSeconds: 10
            failureThreshold: 12
`,
  },
  {
    id: "stateful",
    label: "StatefulSet",
    draft: draft({
      kind: "StatefulSet",
      name: "db",
      replicas: "3",
      maxUnavailable: "2",
      liveness: true,
      cpu: "500m",
      memory: "1Gi",
    }),
    yaml: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: shop
spec:
  replicas: 3
  serviceName: db
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 2
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
          resources:
            requests:
              cpu: 500m
              memory: 1Gi
          readinessProbe:
            tcpSocket:
              port: 5432
          livenessProbe:
            tcpSocket:
              port: 5432
`,
  },
];

export function Workbench() {
  const initial = samples[0];
  const [mode, setMode] = useState<Mode>("calculator");
  const [draft, setDraft] = useState<Draft>(initial.draft);
  const [yaml, setYaml] = useState(initial.yaml);
  const [activeSample, setActiveSample] = useState(initial.id);
  const [copied, setCopied] = useState(false);

  const report = useMemo(() => {
    if (mode === "yaml") return analyzeManifest(yaml);
    return reportFromDraft(draft);
  }, [mode, draft, yaml]);

  async function copyMarkdown() {
    const text = formatMarkdown(report, null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  function applySample(sample: (typeof samples)[number]) {
    setDraft(sample.draft);
    setYaml(sample.yaml);
    setActiveSample(sample.id);
  }

  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setYaml(String(reader.result ?? ""));
      setMode("yaml");
      setActiveSample("");
    };
    reader.readAsText(file);
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-[0.18em] text-primary uppercase">
          rolloutmath
        </p>
        <h1 className="max-w-3xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
          How many pods stay Ready if the new version never does
        </h1>
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
          A Deployment will not scale the old ReplicaSet below replicas minus
          maxUnavailable while the new pods are NotReady. Paste a manifest, or
          move the numbers. The YAML stays in this browser.
        </p>
      </header>

      <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <section className="order-2 flex flex-col gap-4 lg:order-1">
          <div className="flex flex-wrap gap-2">
            {samples.map((sample) => (
              <Button
                key={sample.id}
                type="button"
                size="sm"
                variant={activeSample === sample.id ? "default" : "outline"}
                aria-pressed={activeSample === sample.id}
                onClick={() => applySample(sample)}
              >
                {sample.label}
              </Button>
            ))}
          </div>

          <Tabs
            value={mode}
            onValueChange={(value) => {
              if (value === "calculator" || value === "yaml") setMode(value);
            }}
          >
            <TabsList>
              <TabsTrigger value="calculator">Calculator</TabsTrigger>
              <TabsTrigger value="yaml">YAML</TabsTrigger>
            </TabsList>
            <TabsContent value="calculator" className="pt-3">
              <Calculator draft={draft} onChange={(next) => {
                setDraft(next);
                setActiveSample("");
              }} />
            </TabsContent>
            <TabsContent value="yaml" className="flex flex-col gap-3 pt-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="manifest">Manifest</Label>
                <label className="cursor-pointer text-xs text-primary">
                  Open a file
                  <input
                    className="sr-only"
                    type="file"
                    accept=".yaml,.yml,.json,text/yaml,application/json"
                    onChange={(event) => {
                      onFile(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
              <Textarea
                id="manifest"
                value={yaml}
                spellCheck={false}
                onChange={(event) => {
                  setYaml(event.target.value);
                  setActiveSample("");
                }}
                className="min-h-80 font-mono text-xs leading-5"
              />
            </TabsContent>
          </Tabs>
        </section>

        <section className="order-1 lg:order-2">
          <Result report={report} copied={copied} onCopy={() => void copyMarkdown()} />
        </section>
      </div>

      <footer className="max-w-3xl text-xs leading-5 text-muted-foreground">
        The loop matches the Deployment controller: one scale per sync, new
        ReplicaSet first, new pods modeled as never Ready. A PodDisruptionBudget
        does not limit that loop. A node failure, or pods that are already
        NotReady, can land lower than this floor. A StatefulSet reads
        spec.updateStrategy, rounds maxUnavailable down, and does not surge.
      </footer>
    </div>
  );
}

function Calculator({
  draft,
  onChange,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const stateful = draft.kind === "StatefulSet";
  const recreate = !stateful && draft.strategy === "Recreate";

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Kind" htmlFor="kind">
        <Select
          id="kind"
          value={draft.kind}
          onChange={(value) =>
            set({
              kind: value as Kind,
              strategy: value === "StatefulSet" ? "RollingUpdate" : draft.strategy,
            })
          }
        >
          <option value="Deployment">Deployment</option>
          <option value="StatefulSet">StatefulSet</option>
        </Select>
      </Field>
      <Field label="Namespace" htmlFor="namespace">
        <Input
          id="namespace"
          value={draft.namespace}
          onChange={(event) => set({ namespace: event.target.value })}
        />
      </Field>
      <Field label="Name" htmlFor="name">
        <Input
          id="name"
          value={draft.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>
      <Field label="Replicas" htmlFor="replicas">
        <Input
          id="replicas"
          inputMode="numeric"
          value={draft.replicas}
          onChange={(event) => set({ replicas: event.target.value })}
        />
      </Field>
      {stateful ? (
        <Field label="Partition" htmlFor="partition">
          <Input
            id="partition"
            inputMode="numeric"
            value={draft.partition}
            onChange={(event) => set({ partition: event.target.value })}
          />
        </Field>
      ) : (
        <Field label="Strategy" htmlFor="strategy">
          <Select
            id="strategy"
            value={draft.strategy}
            onChange={(value) => set({ strategy: value as Strategy })}
          >
            <option value="RollingUpdate">RollingUpdate</option>
            <option value="Recreate">Recreate</option>
          </Select>
        </Field>
      )}
      <Field label={stateful ? "Max unavailable" : "Max surge"} htmlFor="surge">
        <Input
          id="surge"
          disabled={recreate}
          placeholder={stateful ? "1" : "25%"}
          value={stateful ? draft.maxUnavailable : draft.maxSurge}
          onChange={(event) =>
            set(
              stateful
                ? { maxUnavailable: event.target.value }
                : { maxSurge: event.target.value },
            )
          }
        />
      </Field>
      {stateful ? null : (
        <Field label="Max unavailable" htmlFor="unavailable">
          <Input
            id="unavailable"
            disabled={recreate}
            placeholder="25%"
            value={draft.maxUnavailable}
            onChange={(event) => set({ maxUnavailable: event.target.value })}
          />
        </Field>
      )}
      <Field label="minReadySeconds" htmlFor="min-ready">
        <Input
          id="min-ready"
          inputMode="numeric"
          value={draft.minReadySeconds}
          onChange={(event) => set({ minReadySeconds: event.target.value })}
        />
      </Field>
      {stateful ? null : (
        <Field label="Progress deadline" htmlFor="deadline">
          <Input
            id="deadline"
            inputMode="numeric"
            value={draft.progressDeadlineSeconds}
            onChange={(event) =>
              set({ progressDeadlineSeconds: event.target.value })
            }
          />
        </Field>
      )}
      <Field label="CPU request" htmlFor="cpu">
        <Input
          id="cpu"
          placeholder="100m"
          value={draft.cpu}
          onChange={(event) => set({ cpu: event.target.value })}
        />
      </Field>
      <Field label="Memory request" htmlFor="memory">
        <Input
          id="memory"
          placeholder="128Mi"
          value={draft.memory}
          onChange={(event) => set({ memory: event.target.value })}
        />
      </Field>
      <div className="col-span-2 flex flex-wrap gap-4 pt-1 text-sm">
        <Check
          label="Readiness probe"
          checked={draft.readiness}
          onChange={(readiness) => set({ readiness })}
        />
        <Check
          label="Liveness probe"
          checked={draft.liveness}
          onChange={(liveness) => set({ liveness })}
        />
        <Check
          label="Startup probe"
          checked={draft.hasStartup}
          onChange={(hasStartup) => set({ hasStartup })}
        />
      </div>
      {draft.hasStartup ? (
        <>
          <Field label="Startup delay" htmlFor="startup-delay">
            <Input
              id="startup-delay"
              inputMode="numeric"
              value={draft.startupDelay}
              onChange={(event) => set({ startupDelay: event.target.value })}
            />
          </Field>
          <Field label="Startup period" htmlFor="startup-period">
            <Input
              id="startup-period"
              inputMode="numeric"
              value={draft.startupPeriod}
              onChange={(event) => set({ startupPeriod: event.target.value })}
            />
          </Field>
          <Field label="Startup failures" htmlFor="startup-failures">
            <Input
              id="startup-failures"
              inputMode="numeric"
              value={draft.startupFailures}
              onChange={(event) => set({ startupFailures: event.target.value })}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
}

function Result({
  report,
  copied,
  onCopy,
}: {
  report: Report;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">If the new pods never become Ready</h2>
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          {copied ? "Copied" : "Copy Markdown"}
        </Button>
      </div>
      {report.error ? (
        <p className="text-sm leading-6 text-destructive" role="alert">
          {report.error}
        </p>
      ) : (
        report.workloads.map((item, index) => (
          <WorkloadResult
            key={`${workloadRef(item.workload)}#${index}`}
            item={item}
          />
        ))
      )}
    </div>
  );
}

function WorkloadResult({ item }: { item: WorkloadReport }) {
  const { workload, simulation } = item;
  const tone = simulation.invalid
    ? "text-destructive"
    : workload.replicas === 0
      ? "text-foreground"
      : simulation.readyFloor === 0
        ? "text-destructive"
        : simulation.readyFloor === workload.replicas
          ? "text-primary"
          : "text-[oklch(0.86_0.14_85)]";

  return (
    <article className="flex flex-col gap-4 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <p className="font-mono text-xs text-muted-foreground">
        {workloadRef(workload)}
      </p>
      {simulation.invalid ? (
        <p className="text-sm leading-6 text-destructive">{simulation.invalid}</p>
      ) : (
        <>
          <div>
            <p
              className={`font-mono text-6xl tracking-tight ${tone}`}
              aria-live="polite"
            >
              {simulation.readyFloor}
            </p>
            <p className="text-sm text-muted-foreground">
              of {workload.replicas} stay Ready
              {simulation.newUnready > 0
                ? `. ${simulation.newUnready} new ${simulation.newUnready === 1 ? "pod stays" : "pods stay"} NotReady (${simulation.totalAtFloor} total).`
                : "."}
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {READY_FLOOR_ASSUMPTION}
            </p>
          </div>
          <ol className="flex flex-col gap-3">
            {simulation.steps.map((step) => (
              <li key={step.sync} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    <span className="font-mono text-muted-foreground">
                      {step.sync}.
                    </span>{" "}
                    {step.title}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    ready {step.ready}
                  </span>
                </div>
                <StepBar step={step} />
                <p className="text-xs leading-5 text-muted-foreground">
                  {step.detail}
                </p>
              </li>
            ))}
          </ol>
        </>
      )}
      <ul className="flex flex-col gap-2">
        {item.findings.map((finding, index) => (
          <li
            key={`${finding.code}-${index}`}
            className="flex items-start gap-2 text-sm leading-5"
          >
            <Badge
              variant={
                finding.severity === "error"
                  ? "destructive"
                  : finding.severity === "warning"
                    ? "outline"
                    : "secondary"
              }
            >
              {finding.severity}
            </Badge>
            <span>{finding.message}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function StepBar({ step }: { step: SimStep }) {
  if (step.total === 0) {
    return (
      <div className="h-2 rounded-full bg-destructive/70" title="No pods" />
    );
  }
  const ready = (step.ready / step.total) * 100;
  const pending = (step.newReplicas / step.total) * 100;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
      <div className="bg-primary" style={{ width: `${ready}%` }} />
      <div className="bg-destructive" style={{ width: `${pending}%` }} />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[oklch(0.9_0.17_128)]"
      />
      {label}
    </label>
  );
}

function Select({
  id,
  value,
  onChange,
  children,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 w-full rounded-lg border border-input bg-input/30 px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {children}
    </select>
  );
}

function reportFromDraft(draft: Draft): Report {
  try {
    return { error: null, workloads: [analyzeWorkload(workloadFromDraft(draft))] };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Check the fields.",
      workloads: [],
    };
  }
}

function workloadFromDraft(draft: Draft): Workload {
  const name = draft.name.trim() || "(unnamed)";
  const namespace = draft.namespace.trim() || "default";
  const stateful = draft.kind === "StatefulSet";
  const container: Record<string, unknown> = { name: "app" };
  const requests: Record<string, string> = {};
  if (draft.cpu.trim()) {
    parseLabeled(draft.cpu, "CPU request", parseCpu);
    requests.cpu = draft.cpu.trim();
  }
  if (draft.memory.trim()) {
    parseLabeled(draft.memory, "Memory request", parseMemory);
    requests.memory = draft.memory.trim();
  }
  if (Object.keys(requests).length > 0) {
    container.resources = { requests };
  }
  if (draft.readiness) container.readinessProbe = { tcpSocket: { port: 1 } };
  if (draft.liveness) container.livenessProbe = { tcpSocket: { port: 1 } };
  if (draft.hasStartup) {
    container.startupProbe = {
      tcpSocket: { port: 1 },
      initialDelaySeconds: whole(draft.startupDelay, "Startup delay"),
      periodSeconds: whole(draft.startupPeriod, "Startup period"),
      failureThreshold: whole(draft.startupFailures, "Startup failures"),
    };
  }

  const spec: Record<string, unknown> = {
    replicas: whole(draft.replicas, "Replicas"),
    minReadySeconds: whole(draft.minReadySeconds, "minReadySeconds"),
    template: { spec: { containers: [container] } },
  };

  if (stateful) {
    spec.serviceName = "app";
    const rollingUpdate: Record<string, unknown> = {};
    if (draft.partition.trim()) {
      rollingUpdate.partition = whole(draft.partition, "Partition");
    }
    if (draft.maxUnavailable.trim()) {
      rollingUpdate.maxUnavailable = rollingScalar(
        draft.maxUnavailable,
        "maxUnavailable",
      );
    }
    spec.updateStrategy = { type: "RollingUpdate", rollingUpdate };
  } else if (draft.strategy === "Recreate") {
    spec.strategy = { type: "Recreate" };
  } else {
    const rollingUpdate: Record<string, unknown> = {};
    if (draft.maxSurge.trim()) {
      rollingUpdate.maxSurge = rollingScalar(draft.maxSurge, "maxSurge");
    }
    if (draft.maxUnavailable.trim()) {
      rollingUpdate.maxUnavailable = rollingScalar(
        draft.maxUnavailable,
        "maxUnavailable",
      );
    }
    spec.strategy = { type: "RollingUpdate", rollingUpdate };
    if (draft.progressDeadlineSeconds.trim()) {
      spec.progressDeadlineSeconds = whole(
        draft.progressDeadlineSeconds,
        "Progress deadline",
      );
    }
  }

  const workload = workloadFromObject({
    apiVersion: "apps/v1",
    kind: draft.kind,
    metadata: { name, namespace },
    spec,
  });
  if (!workload) throw new Error("Could not read that workload.");
  return workload;
}

function rollingScalar(value: string, field: string): number | string {
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const parsed = Number(text);
    if (parsed > 2_147_483_647) {
      throw new Error(`${field} must be an integer from 0 to 2147483647, or a percent.`);
    }
    return parsed;
  }
  if (/^[0-9]+%$/.test(text)) return text;
  throw new Error(`${field} must be a whole number or a percent, like 1 or 25%.`);
}

function parseLabeled(
  value: string,
  field: string,
  parse: (raw: string) => number,
): number {
  try {
    return parse(value);
  } catch {
    throw new Error(`${field} is not a quantity Kubernetes would accept.`);
  }
}

function whole(value: string, field: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${field} must be a whole number.`);
  }
  const parsed = Number(value.trim());
  if (parsed > 2_147_483_647) {
    throw new Error(`${field} must be an integer from 0 to 2147483647.`);
  }
  return parsed;
}

function draft(overrides: Partial<Draft>): Draft {
  return {
    kind: "Deployment",
    name: "api",
    namespace: "shop",
    replicas: "2",
    strategy: "RollingUpdate",
    maxSurge: "25%",
    maxUnavailable: "25%",
    minReadySeconds: "0",
    progressDeadlineSeconds: "600",
    partition: "0",
    readiness: true,
    liveness: false,
    hasStartup: false,
    startupDelay: "0",
    startupPeriod: "10",
    startupFailures: "3",
    cpu: "",
    memory: "",
    ...overrides,
  };
}
