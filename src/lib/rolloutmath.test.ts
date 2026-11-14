import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeManifest, analyzeWorkload, exitCode } from "./analyze";
import { effectiveRequests } from "./manifest";
import { formatCpu, formatMemory, parseCpu, parseMemory, scaleIntOrPercent } from "./quantity";
import type { Workload } from "./types";

const root = path.resolve(import.meta.dirname, "../..");

function deployment(overrides: Partial<Workload> = {}): Workload {
  return {
    kind: "Deployment",
    namespace: "shop",
    name: "api",
    replicas: 1,
    strategy: "RollingUpdate",
    maxSurge: { kind: "percent", value: 25 },
    maxUnavailable: { kind: "percent", value: 25 },
    surgeDefaulted: false,
    unavailableDefaulted: false,
    minReadySeconds: 0,
    progressDeadlineSeconds: 600,
    deadlineDefaulted: false,
    partition: 0,
    ordinalStart: 0,
    paused: false,
    rejected: null,
    missingReadiness: false,
    livenessWithoutStartup: false,
    startupBudgetSeconds: null,
    readinessInitialDelaySeconds: 0,
    requestsMilliCpu: 0,
    requestsBytes: 0,
    timedOut: false,
    observedAvailable: null,
    ...overrides,
  };
}

test("parses CPU and memory quantities", () => {
  assert.equal(parseCpu("500m"), 500);
  assert.equal(parseCpu("1"), 1000);
  assert.equal(parseCpu(1.5), 1500);
  assert.equal(parseMemory("128Mi"), 128 * 1024 * 1024);
  assert.equal(parseMemory("1G"), 1_000_000_000);
  assert.equal(formatCpu(1500), "1500m");
  assert.equal(formatCpu(2000), "2");
  assert.equal(formatMemory(640 * 1024 * 1024), "640Mi");
  assert.equal(scaleIntOrPercent({ kind: "percent", value: 25 }, 3, true), 1);
  assert.equal(scaleIntOrPercent({ kind: "percent", value: 25 }, 3, false), 0);
  assert.equal(scaleIntOrPercent({ kind: "percent", value: 1 }, 2, false), 0);
});

test("init containers use the sidecar high water mark, in list order", () => {
  const migrateThenSidecar = effectiveRequests({
    containers: [{ name: "app", resources: { requests: { cpu: "100m", memory: "64Mi" } } }],
    initContainers: [
      { name: "migrate", resources: { requests: { cpu: "250m", memory: "32Mi" } } },
      {
        name: "sidecar",
        restartPolicy: "Always",
        resources: { requests: { cpu: "50m", memory: "16Mi" } },
      },
    ],
  });
  // The migrate init runs before the sidecar starts, so the sidecar is not
  // added on top of 250m. max(100m + 50m, 250m) = 250m. Memory is max(64+16, 32).
  assert.equal(migrateThenSidecar.cpu, 250);
  assert.equal(migrateThenSidecar.memory, (64 + 16) * 1024 * 1024);

  const sidecarThenMigrate = effectiveRequests({
    containers: [{ name: "app", resources: { requests: { cpu: "100m", memory: "64Mi" } } }],
    initContainers: [
      {
        name: "sidecar",
        restartPolicy: "Always",
        resources: { requests: { cpu: "50m", memory: "16Mi" } },
      },
      { name: "migrate", resources: { requests: { cpu: "250m", memory: "32Mi" } } },
    ],
  });
  // The sidecar is already running when migrate starts, so migrate needs 250m + 50m.
  assert.equal(sidecarThenMigrate.cpu, 300);
  assert.equal(sidecarThenMigrate.memory, (64 + 16) * 1024 * 1024);

  const overridden = effectiveRequests({
    containers: [{ name: "app", resources: { requests: { cpu: "100m", memory: "64Mi" } } }],
    resources: { requests: { cpu: "1" } },
    overhead: { cpu: "10m", memory: "1Mi" },
  });
  assert.equal(overridden.cpu, 1010);
  assert.equal(overridden.memory, 64 * 1024 * 1024 + 1024 * 1024);
});

test("the Kubernetes 1.33 comment: 10 replicas, surge 3, unavailable 2", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 10,
      maxSurge: { kind: "absolute", value: 3 },
      maxUnavailable: { kind: "absolute", value: 2 },
      requestsMilliCpu: 100,
      requestsBytes: 128 * 1024 * 1024,
    }),
  );
  assert.equal(report.simulation.readyFloor, 8);
  assert.equal(exitCode({ error: null, workloads: [report] }, { floor: 8, strict: false }), 0);
  assert.equal(report.simulation.newUnready, 5);
  assert.equal(report.simulation.totalAtFloor, 13);
  assert.deepEqual(
    report.simulation.steps.map((step) => [step.oldReplicas, step.newReplicas, step.ready]),
    [
      [10, 3, 10],
      [8, 3, 8],
      [8, 5, 8],
      [8, 5, 8],
    ],
  );
  assert.equal(report.findings.some((finding) => finding.code === "EXTRA_REQUESTS"), true);
  assert.match(
    report.findings.find((finding) => finding.code === "EXTRA_REQUESTS")?.message ?? "",
    /500m CPU and 640Mi memory/,
  );
});

test("one replica with maxSurge 0 drops to zero Ready pods", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 1,
      maxSurge: { kind: "absolute", value: 0 },
      maxUnavailable: { kind: "absolute", value: 1 },
    }),
  );
  assert.equal(report.simulation.readyFloor, 0);
  assert.equal(report.simulation.newUnready, 1);
  assert.equal(report.findings.some((finding) => finding.code === "FLOOR_ZERO"), true);
  assert.equal(exitCode({ error: null, workloads: [report] }, { floor: null, strict: false }), 2);
});

test("one replica with maxUnavailable 0 keeps the old pod", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 1,
      maxSurge: { kind: "absolute", value: 1 },
      maxUnavailable: { kind: "absolute", value: 0 },
    }),
  );
  assert.equal(report.simulation.readyFloor, 1);
  assert.equal(report.simulation.newUnready, 1);
  assert.equal(report.findings.some((finding) => finding.code === "FLOOR_FULL"), true);
});

test("25% of 4 replicas keeps 3, 25% of 3 keeps all 3", () => {
  const four = analyzeWorkload(
    deployment({
      replicas: 4,
      maxSurge: { kind: "percent", value: 25 },
      maxUnavailable: { kind: "percent", value: 25 },
    }),
  );
  assert.equal(four.simulation.maxSurge, 1);
  assert.equal(four.simulation.maxUnavailable, 1);
  assert.equal(four.simulation.readyFloor, 3);
  assert.equal(four.simulation.newUnready, 2);

  const three = analyzeWorkload(
    deployment({
      replicas: 3,
      maxSurge: { kind: "percent", value: 25 },
      maxUnavailable: { kind: "percent", value: 25 },
    }),
  );
  assert.equal(three.simulation.maxSurge, 1);
  assert.equal(three.simulation.maxUnavailable, 0);
  assert.equal(three.simulation.readyFloor, 3);
  assert.equal(three.simulation.newUnready, 1);
});

test("percentages that round to zero bump maxUnavailable to 1", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 2,
      maxSurge: { kind: "percent", value: 0 },
      maxUnavailable: { kind: "percent", value: 1 },
    }),
  );
  assert.equal(report.simulation.bumpedUnavailable, true);
  assert.equal(report.simulation.maxUnavailable, 1);
  assert.equal(report.simulation.readyFloor, 1);
  assert.equal(report.findings.some((finding) => finding.code === "FENCEPOST"), true);
});

test("explicit zero surge and zero unavailable is rejected", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 4,
      maxSurge: { kind: "absolute", value: 0 },
      maxUnavailable: { kind: "absolute", value: 0 },
    }),
  );
  assert.match(report.simulation.invalid ?? "", /both 0/);
  assert.equal(report.findings[0]?.code, "INVALID_STRATEGY");
});

test("Recreate leaves a gap with nothing Ready", () => {
  const report = analyzeWorkload(
    deployment({ replicas: 5, strategy: "Recreate" }),
  );
  assert.equal(report.simulation.readyFloor, 0);
  assert.equal(report.simulation.steps[0]?.total, 0);
  assert.equal(report.findings.some((finding) => finding.code === "FLOOR_ZERO"), true);
});

test("StatefulSet updates from the highest ordinal and does not surge", () => {
  const report = analyzeManifest(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
  namespace: shop
spec:
  replicas: 3
  serviceName: db
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
          readinessProbe:
            tcpSocket:
              port: 5432
`);
  assert.equal(report.error, null);
  const simulation = report.workloads[0]?.simulation;
  assert.equal(simulation?.readyFloor, 2);
  assert.equal(simulation?.newUnready, 1);
  assert.equal(simulation?.totalAtFloor, 3);
  assert.match(simulation?.steps[0]?.detail ?? "", /ordinal 2/);
});

test("a startup budget longer than the progress deadline is a warning", () => {
  const report = analyzeManifest(`
apiVersion: apps/v1
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
        - name: app
          image: app:1
          readinessProbe:
            httpGet: { path: /ready, port: 80 }
          startupProbe:
            httpGet: { path: /ready, port: 80 }
            periodSeconds: 10
            failureThreshold: 12
`);
  const codes = report.workloads[0]?.findings.map((finding) => finding.code);
  assert.ok(codes?.includes("STARTUP_EXCEEDS_DEADLINE"));
  assert.equal(
    exitCode(report, { floor: null, strict: false }),
    0,
  );
  assert.equal(exitCode(report, { floor: null, strict: true }), 2);
});

test("minReadySeconds at least as long as the deadline fails the rollout by construction", () => {
  const report = analyzeWorkload(
    deployment({
      replicas: 2,
      maxSurge: { kind: "absolute", value: 1 },
      maxUnavailable: { kind: "absolute", value: 0 },
      minReadySeconds: 600,
      progressDeadlineSeconds: 600,
    }),
  );
  assert.equal(
    report.findings.some((finding) => finding.code === "MIN_READY_EXCEEDS_DEADLINE"),
    true,
  );
});

test("a manifest report never echoes secret values, and a broken document does not either", () => {
  const shop = readFileSync(path.join(root, "fixtures/shop.yaml"), "utf8");
  const report = analyzeManifest(shop);
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes("fixture-marker-alpha"), false);
  assert.equal(report.workloads[0]?.simulation.readyFloor, 8);
  assert.equal(report.workloads[1]?.simulation.readyFloor, 2);
  assert.equal(
    report.workloads[1]?.findings.some(
      (finding) => finding.code === "LIVENESS_WITHOUT_STARTUP",
    ),
    true,
  );

  const broken = analyzeManifest(
    "apiVersion: v1\nkind: Secret\nstringData:\n  token: fixture-marker-alpha\n  bad: [\n",
  );
  assert.equal(broken.workloads.length, 0);
  assert.match(broken.error ?? "", /not valid/);
  assert.equal((broken.error ?? "").includes("fixture-marker-alpha"), false);
});

test("omitted rolling-update fields use the API defaults", () => {
  const report = analyzeManifest(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  template:
    spec:
      containers:
        - name: web
          image: web:1
          readinessProbe:
            httpGet: { path: /, port: 80 }
`);
  assert.equal(report.workloads[0]?.workload.namespace, "default");
  assert.equal(report.workloads[0]?.simulation.maxSurge, 1);
  assert.equal(report.workloads[0]?.simulation.maxUnavailable, 1);
  assert.equal(report.workloads[0]?.simulation.readyFloor, 3);
  assert.equal(
    report.workloads[0]?.findings.some((finding) => finding.code === "API_DEFAULT"),
    true,
  );
});

test("one replica with the API default stays up, and maxUnavailable 1 takes it down", () => {
  const safe = analyzeManifest(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: web
          image: web:1
          readinessProbe:
            httpGet: { path: /, port: 80 }
`);
  assert.equal(safe.workloads[0]?.simulation.maxSurge, 1);
  assert.equal(safe.workloads[0]?.simulation.maxUnavailable, 0);
  assert.equal(safe.workloads[0]?.simulation.readyFloor, 1);

  const outage = analyzeWorkload(
    deployment({
      replicas: 1,
      maxSurge: { kind: "absolute", value: 1 },
      maxUnavailable: { kind: "absolute", value: 1 },
    }),
  );
  assert.equal(outage.simulation.readyFloor, 0);
  assert.equal(outage.simulation.newUnready, 1);
});

test("the controller comment's stalled floors, not the successful rollout", () => {
  const two = analyzeWorkload(
    deployment({
      replicas: 2,
      maxSurge: { kind: "percent", value: 0 },
      maxUnavailable: { kind: "percent", value: 1 },
    }),
  );
  assert.equal(two.simulation.bumpedUnavailable, true);
  assert.equal(two.simulation.readyFloor, 1);

  const one = analyzeWorkload(
    deployment({
      replicas: 1,
      maxSurge: { kind: "percent", value: 0 },
      maxUnavailable: { kind: "percent", value: 1 },
    }),
  );
  assert.equal(one.simulation.readyFloor, 0);

  const held = analyzeWorkload(
    deployment({
      replicas: 2,
      maxSurge: { kind: "percent", value: 1 },
      maxUnavailable: { kind: "percent", value: 25 },
    }),
  );
  assert.equal(held.simulation.maxSurge, 1);
  assert.equal(held.simulation.maxUnavailable, 0);
  assert.equal(held.simulation.readyFloor, 2);
  assert.equal(held.simulation.newUnready, 1);
});

test("explicit 0% and 0% is rejected, and maxUnavailable above 100% is rejected", () => {
  const zeros = analyzeManifest(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 4
  strategy:
    rollingUpdate:
      maxSurge: 0%
      maxUnavailable: 0%
  template:
    spec:
      containers:
        - name: web
          image: web:1
`);
  assert.match(zeros.workloads[0]?.simulation.invalid ?? "", /both 0/);
  assert.equal(zeros.workloads[0]?.simulation.bumpedUnavailable, false);

  const huge = analyzeManifest(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 200%
  template:
    spec:
      containers:
        - name: web
          image: web:1
`);
  assert.match(huge.workloads[0]?.simulation.invalid ?? "", /100%/);
  assert.equal(exitCode(huge, { floor: null, strict: false }), 2);
});

test("StatefulSet reads updateStrategy, rounds maxUnavailable down, and keeps siblings", () => {
  const report = analyzeManifest(`
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: Service
    metadata:
      name: ignored
    spec:
      ports:
        - port: 80
  - apiVersion: apps/v1
    kind: StatefulSet
    metadata:
      name: db
      namespace: shop
    spec:
      replicas: 3
      serviceName: db
      strategy:
        rollingUpdate:
          maxUnavailable: 1
      updateStrategy:
        type: RollingUpdate
        rollingUpdate:
          partition: 12
          maxUnavailable: 3
      ordinals:
        start: 10
      template:
        spec:
          containers:
            - name: db
              image: postgres:16
              readinessProbe:
                tcpSocket:
                  port: 5432
  - apiVersion: apps/v1
    kind: StatefulSet
    metadata:
      name: pinned
    spec:
      replicas: 4
      serviceName: pinned
      updateStrategy:
        type: OnDelete
      template:
        spec:
          containers:
            - name: pinned
              image: app:1
              readinessProbe:
                tcpSocket:
                  port: 80
`);
  assert.equal(report.error, null);
  assert.equal(report.workloads.length, 2);
  const rolling = report.workloads[0];
  // partition 12 is past indexes 0..2 (ordinals 10..12). spec.strategy is the
  // Deployment field and must be ignored. maxUnavailable 3 would otherwise
  // take every pod down.
  assert.equal(rolling?.simulation.maxUnavailable, 3);
  assert.equal(rolling?.simulation.readyFloor, 3);
  assert.equal(rolling?.simulation.newUnready, 0);
  assert.match(rolling?.simulation.steps[0]?.detail ?? "", /past the last index/);
  assert.match(rolling?.simulation.steps[0]?.detail ?? "", /10 to 12/);

  const percent = analyzeManifest(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  replicas: 3
  serviceName: db
  updateStrategy:
    rollingUpdate:
      maxUnavailable: 50%
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
          readinessProbe:
            tcpSocket:
              port: 5432
`);
  assert.equal(percent.workloads[0]?.simulation.maxUnavailable, 1);
  assert.equal(percent.workloads[0]?.simulation.readyFloor, 2);
  assert.equal(
    report.workloads[1]?.findings.some((finding) => finding.code === "ON_DELETE"),
    true,
  );
  assert.equal(report.workloads[1]?.simulation.readyFloor, 4);
  assert.equal(
    report.workloads[1]?.findings.some((finding) => finding.code === "FLOOR_FULL"),
    false,
  );
});

test("a small StatefulSet percentage is raised to 1, and 0 is rejected", () => {
  const raised = analyzeManifest(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  replicas: 10
  serviceName: db
  updateStrategy:
    rollingUpdate:
      maxUnavailable: 1%
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
`);
  assert.equal(raised.workloads[0]?.simulation.unavailableRaised, true);
  assert.equal(raised.workloads[0]?.simulation.maxUnavailable, 1);
  assert.equal(raised.workloads[0]?.simulation.readyFloor, 9);
  assert.equal(
    raised.workloads[0]?.findings.some((finding) => finding.code === "UNAVAILABLE_MINIMUM"),
    true,
  );

  const zero = analyzeManifest(`
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  replicas: 3
  serviceName: db
  updateStrategy:
    rollingUpdate:
      maxUnavailable: 0
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
`);
  assert.match(zero.workloads[0]?.simulation.invalid ?? "", /cannot be 0/);
});

test("an unknown strategy does not drop the next workload, and a paused deploy is reported", () => {
  const report = analyzeManifest(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: broken
spec:
  replicas: 2
  strategy:
    type: BlueGreen
  template:
    spec:
      containers:
        - name: app
          image: app:1
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: held
spec:
  replicas: 2
  paused: true
  strategy:
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    spec:
      containers:
        - name: app
          image: app:1
          readinessProbe:
            httpGet: { path: /, port: 80 }
`);
  assert.equal(report.error, null);
  assert.equal(report.workloads.length, 2);
  assert.equal(report.workloads[0]?.findings[0]?.code, "INVALID_STRATEGY");
  assert.equal(report.workloads[1]?.simulation.readyFloor, 2);
  assert.equal(
    report.workloads[1]?.findings.some((finding) => finding.code === "PAUSED"),
    true,
  );
  assert.equal(exitCode(report, { floor: null, strict: false }), 2);
});

test("a Service file does not hide a Deployment in a second file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rolloutmath-"));
  writeFileSync(
    path.join(dir, "service.yaml"),
    "apiVersion: v1\nkind: Service\nmetadata:\n  name: web\n",
  );
  writeFileSync(
    path.join(dir, "deploy.yaml"),
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  strategy:
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: web
          image: web:1
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "src/cli.ts"),
      "check",
      path.join(dir, "service.yaml"),
      path.join(dir, "deploy.yaml"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /default\/Deployment\/web/);
});

test("stdin accepts --floor= and skips other kinds in the same stream", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "src/cli.ts"),
      "check",
      "-",
      "--floor=1",
      "--format=text",
    ],
    {
      cwd: root,
      encoding: "utf8",
      input: `apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  ports:
    - port: 80
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  strategy:
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: web
          image: web:1
          readinessProbe:
            httpGet: { path: /, port: 80 }
`,
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /default\/Deployment\/web/);
  assert.match(result.stdout, /below the required floor of 1/);
});

test("the bin wrapper forwards stdin and the status code", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/rolloutmath.js"), "check", "-"],
    {
      cwd: root,
      encoding: "utf8",
      input: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  strategy:
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  template:
    spec:
      containers:
        - name: web
          image: web:1
`,
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /0 stay Ready/);
});

test("the CLI exits 2 when the ready floor is below --floor", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(root, "node_modules/tsx/dist/loader.mjs"),
      path.join(root, "src/cli.ts"),
      "check",
      "fixtures/shop.yaml",
      "--floor",
      "9",
      "--format",
      "text",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /keeps 8 Ready, below the required floor of 9/);
  assert.equal(result.stdout.includes("fixture-marker-alpha"), false);
});
