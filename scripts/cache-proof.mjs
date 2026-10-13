import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// This deliberately has no local build mode or CI-detection bypass.
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run in GitHub Actions only.");
assert.equal(
  process.env.CI,
  "true",
  "Keep CI=true, including in pnpm children."
);
assert.equal(process.platform, "linux", "This proof covers Linux only.");
assert.equal(process.env.PNPM_CONFIG_VIRTUAL_STORE_TYPE, "global");

const root = process.cwd();
const evidence = path.join(root, ".agent-layer/tmp/cache-hosted-evidence");
const worktrees = path.join(root, ".agent-layer/tmp/cache-hosted-worktrees");
const a = path.join(worktrees, "a");
const b = path.join(worktrees, "b");
assert(!existsSync(worktrees), "Proof worktrees must start absent.");
mkdirSync(evidence, { recursive: true });
mkdirSync(worktrees, { recursive: true });
/** @type {Record<string, any>} */
const report = {
  status: "running",
  platform: process.platform,
  arch: process.arch,
  commands: []
};
const replacements = [
  [a, "<A>"],
  [b, "<B>"],
  [root, "<CHECKOUT>"],
  [homedir(), "<HOME>"]
];
/** @param {string} value */
function sanitize(value) {
  let text = value;
  for (const [from, to] of replacements) text = text.split(from).join(to);
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(https?:\/\/)[^\s/]+:[^\s/@]+@/g, "$1<REDACTED>@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
      "<REDACTED>"
    );
}
function save() {
  writeFileSync(
    path.join(evidence, "proof.json"),
    sanitize(JSON.stringify(report, null, 2)) + "\n"
  );
}
/** @param {string | Buffer} value */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
/** @param {string} file */
function hashFile(file) {
  return digest(readFileSync(file));
}
/** @param {string} label @param {string} cwd @param {string} command @param {string[]} args */
async function run(label, cwd, command, args) {
  const start = performance.now();
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  writeFileSync(path.join(evidence, `${label}.log`), sanitize(output));
  report.commands.push({
    label,
    cwd,
    command,
    args,
    code,
    milliseconds: Math.round(performance.now() - start)
  });
  save();
  assert.equal(code, 0, `${label} failed; see sanitized ${label}.log`);
  return output;
}
/** @param {string} label @param {string} cwd @param {string[]} args */
const pnpm = (label, cwd, args) =>
  run(label, cwd, "corepack", ["pnpm", ...args]);
const inputFiles = [
  "package.json",
  "toolchain.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "next.config.ts",
  "open-next.config.ts",
  "tsconfig.json",
  "scripts/browser-build-config.ts"
];
/** @param {string} cwd */
function inputs(cwd) {
  return Object.fromEntries(
    inputFiles.map((name) => [name, hashFile(path.join(cwd, name))])
  );
}
/** @param {string} parent @param {string} child */
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))
  );
}
/** @param {string} cwd */
function installed(cwd) {
  const modulesFile = path.join(cwd, "node_modules/.modules.yaml");
  // Exact pnpm 11.25.0 writes JSON, despite this filename's suffix.
  const modules = JSON.parse(readFileSync(modulesFile, "utf8"));
  const store = realpathSync(
    path.resolve(cwd, "node_modules", modules.virtualStoreDir)
  );
  assert.equal(
    store,
    realpathSync(path.join(modules.storeDir, "links")),
    "Must use native global installed store."
  );
  assert(
    !inside(cwd, store),
    "A project-local store is not global compatibility proof."
  );
  const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
  const names = [
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
    "node"
  ];
  const targets = Object.fromEntries(
    names.map((name) => {
      const target = realpathSync(path.join(cwd, "node_modules", name));
      assert(inside(store, target), `${name} must resolve into global links.`);
      const stat = statSync(target);
      return [name, { target, dev: stat.dev, ino: stat.ino }];
    })
  );
  return {
    modules: {
      sha256: hashFile(modulesFile),
      storeDir: modules.storeDir,
      virtualStoreDir: modules.virtualStoreDir,
      nodeLinker: modules.nodeLinker
    },
    store,
    targets
  };
}
/** @param {string} dir */
function files(dir) {
  /** @type {string[]} */
  const result = [];
  /** @param {string} current */
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result.push(file);
      // Never follow dependency symlinks into sibling graphs.
    }
  }
  visit(dir);
  return result.sort();
}
/** @param {Record<string, {target: string}>} targets */
function dependencyDigest(targets) {
  return Object.fromEntries(
    Object.entries(targets).map(([name, { target }]) => [
      name,
      digest(
        files(target)
          .map((file) => `${path.relative(target, file)}:${hashFile(file)}`)
          .join("\n")
      )
    ])
  );
}
/** @param {string} cwd */
function cache(cwd) {
  const base = path.join(cwd, ".next/cache/turbopack");
  const all = files(base);
  const current = all.filter((file) => path.basename(file) === "CURRENT");
  assert(current.length > 0, "Native Turbopack CURRENT must exist.");
  const entries = Object.fromEntries(
    all.map((file) => {
      const stat = statSync(file);
      return [
        path.relative(base, file),
        { dev: stat.dev, ino: stat.ino, bytes: stat.size }
      ];
    })
  );
  assert(
    Object.keys(entries).some((file) => /\.(sst|blob|meta|del)$/.test(file)),
    "Native immutable cache files must exist."
  );
  return {
    entries,
    commits: current.map((file) => ({
      file: path.relative(base, file),
      data: JSON.parse(readFileSync(file, "utf8"))
    }))
  };
}
function independentOutputs() {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const name of [
    ".next",
    ".next/cache/turbopack",
    ".next/server",
    "tsconfig.tsbuildinfo"
  ]) {
    const paths = [a, b].map((cwd) => path.join(cwd, name));
    const stats = paths.map((file) => lstatSync(file));
    assert(
      stats.every((stat) => !stat.isSymbolicLink()),
      `${name} must not be a shared symlink.`
    );
    assert.notEqual(
      `${stats[0].dev}:${stats[0].ino}`,
      `${stats[1].dev}:${stats[1].ino}`,
      `${name} must have independent writable inodes.`
    );
    output[name] = paths.map((file, i) => ({
      path: realpathSync(file),
      dev: stats[i].dev,
      ino: stats[i].ino
    }));
  }
  return output;
}

/** @param {string} cwd */
function taskStatistics(cwd) {
  /** @type {Record<string, {cache_hit: number, cache_miss: number}>} */
  const tasks = JSON.parse(
    readFileSync(path.join(cwd, ".next/cache-proof-task-stats.json"), "utf8")
  );
  let hits = 0;
  let misses = 0;
  for (const stats of Object.values(tasks)) {
    assert(Number.isSafeInteger(stats.cache_hit) && stats.cache_hit >= 0);
    assert(Number.isSafeInteger(stats.cache_miss) && stats.cache_miss >= 0);
    hits += stats.cache_hit;
    misses += stats.cache_miss;
  }
  assert(hits + misses > 0, "Native task statistics must be populated.");
  return { hits, misses, tasks };
}

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.dependencies.next, "16.4.0");
  assert.equal(pkg.packageManager, "pnpm@11.25.0");
  assert.equal(process.version, `v${pkg.devEngines.runtime.version}`);
  report.sha = (
    await run("candidate-sha", root, "git", ["rev-parse", "HEAD"])
  ).trim();
  assert.equal(
    (await pnpm("pnpm-version", root, ["--version"])).trim(),
    "11.25.0"
  );
  const dirty = await run("candidate-status", root, "git", [
    "status",
    "--porcelain",
    "--untracked-files=no"
  ]);
  assert.equal(
    dirty.trim(),
    "",
    "Hosted checkout must contain frozen candidate inputs."
  );
  for (const [name, cwd] of [
    ["a", a],
    ["b", b]
  ]) {
    await run(`worktree-${name}`, root, "git", [
      "worktree",
      "add",
      "--detach",
      cwd,
      "HEAD"
    ]);
    assert.deepEqual(inputs(cwd), inputs(root));
    assert(
      !existsSync(path.join(cwd, ".env")),
      "Do not load operator environment files."
    );
  }
  report.inputs = inputs(root);
  await run("setup-a", a, "make", ["setup"]);
  report.a = installed(a);
  replacements.unshift([report.a.store, "<GLOBAL-LINKS>"]);
  assert.equal(
    (await pnpm("runtime-a", a, ["exec", "node", "--version"])).trim(),
    `v${pkg.devEngines.runtime.version}`
  );

  // Deliberate peer-input variant, then restore FINAL candidate bytes before builds.
  const workspaceFile = path.join(b, "pnpm-workspace.yaml");
  const lockFile = path.join(b, "pnpm-lock.yaml");
  const workspace = readFileSync(workspaceFile, "utf8");
  const lock = readFileSync(lockFile);
  const variant = workspace.replace(
    /  next:\n    peerDependencies:\n      "@types\/react": "\*"\n/,
    ""
  );
  assert.notEqual(
    variant,
    workspace,
    "Expected explicit Next type peer fixture."
  );
  writeFileSync(workspaceFile, variant);
  await pnpm("variant-lock-b", b, [
    "install",
    "--lockfile-only",
    "--no-frozen-lockfile"
  ]);
  await pnpm("variant-setup-b", b, ["install", "--frozen-lockfile"]);
  const variantTargets = installed(b);
  assert.notEqual(
    variantTargets.targets.next.target,
    report.a.targets.next.target
  );
  for (const name of ["react", "typescript"])
    assert.deepEqual(variantTargets.targets[name], report.a.targets[name]);
  report.dependencyIsolation = {
    variantWorkspaceSHA256: hashFile(workspaceFile),
    variantLockSHA256: hashFile(lockFile),
    variantNext: variantTargets.targets.next,
    unchanged: {
      react: variantTargets.targets.react,
      typescript: variantTargets.targets.typescript
    },
    aNext: installed(a).targets.next
  };
  assert.deepEqual(
    installed(a).targets,
    report.a.targets,
    "B install must not relink A."
  );
  writeFileSync(workspaceFile, workspace);
  writeFileSync(lockFile, lock);
  await run("setup-b", b, "make", ["setup"]);
  report.b = installed(b);
  assert.deepEqual(
    report.b.targets,
    report.a.targets,
    "Final setups must share real paths and inodes for every direct dependency/runtime."
  );
  assert.deepEqual(inputs(a), inputs(b));
  assert.deepEqual(inputs(b), report.inputs);
  const beforeDependencies = dependencyDigest(report.a.targets);
  report.dependencyHashesBefore = beforeDependencies;
  save();

  await run("build-a", a, "make", ["build"]);
  report.coldTasks = taskStatistics(a);
  report.cacheBeforeSeed = cache(a);
  // Exercise the exact native function invoked by Next's configured build path;
  // capture identities before the subsequent build can compact its cache.
  const seedLog = await pnpm("native-seed-b", b, [
    "exec",
    "node",
    "-e",
    'require("next/dist/lib/turbopack-cache-seed").seedTurbopackCacheIfNeeded({projectDir:process.cwd(),distDir:require("node:path").join(process.cwd(),".next")})'
  ]);
  assert(
    seedLog.includes("Seeded Turbopack cache from"),
    "Native seeding must actually happen."
  );
  report.cacheAfterSeed = cache(b);
  let linkedFiles = 0;
  let linkedBytes = 0;
  let mutableCopies = 0;
  for (const [name, target] of Object.entries(report.cacheAfterSeed.entries)) {
    const source = report.cacheBeforeSeed.entries[name];
    assert(source, `Unexpected seeded file ${name}`);
    assert.equal(target.bytes, source.bytes);
    if (/\.(sst|blob|meta|del)$/.test(name)) {
      assert.equal(
        `${target.dev}:${target.ino}`,
        `${source.dev}:${source.ino}`
      );
      linkedFiles++;
      linkedBytes += target.bytes;
    } else {
      assert.notEqual(
        `${target.dev}:${target.ino}`,
        `${source.dev}:${source.ino}`
      );
      mutableCopies++;
    }
  }
  assert(linkedFiles > 0 && mutableCopies > 0);
  report.seedMetrics = { linkedFiles, linkedBytes, mutableCopies };
  save();
  await run("build-b-unchanged", b, "make", ["build"]);
  report.seededTasks = taskStatistics(b);
  assert(
    report.seededTasks.hits > 0,
    "Seeded build must record native cache hits."
  );
  assert(
    report.seededTasks.misses < report.coldTasks.misses,
    "Seeded unchanged build must recompute fewer native tasks than cold build."
  );
  const originalHTML = readFileSync(
    path.join(a, ".next/server/app/index.html"),
    "utf8"
  );
  const unchangedHTML = readFileSync(
    path.join(b, ".next/server/app/index.html"),
    "utf8"
  );
  const mainA = originalHTML.match(/<main[\s\S]*?<\/main>/)?.[0];
  const mainB = unchangedHTML.match(/<main[\s\S]*?<\/main>/)?.[0];
  assert(mainA && mainB, "Both builds must render the home-page main element.");
  assert.equal(
    mainB,
    mainA,
    "Unchanged seeded build must render the same home page."
  );
  report.unchangedOutput = { mainSHA256: digest(mainA), matches: true };
  report.cacheAfterUnchangedBuild = cache(b);
  report.outputs = independentOutputs();

  // Only proof-worktree source is changed, never installed dependency files.
  const sourceFile = path.join(b, "app/page.tsx");
  const source = readFileSync(sourceFile, "utf8");
  const marker = "CACHE_PROOF_CHANGED_SOURCE_1640";
  const changed = source.replace(
    '<main className="landing">',
    `<main className="landing"><span>${marker}</span>`
  );
  assert.notEqual(
    changed,
    source,
    "Expected home-page fixture insertion point."
  );
  writeFileSync(sourceFile, changed);
  report.sourceInvalidation = {
    beforeSHA256: digest(source),
    afterSHA256: hashFile(sourceFile),
    marker
  };
  const concurrentStart = performance.now();
  // Wait for both even when one fails, so diagnostics and final status are durable.
  const concurrent = await Promise.allSettled([
    pnpm("worker-dry-run-a", a, ["run", "worker:dry-run"]),
    run("build-b-changed", b, "make", ["build"])
  ]);
  for (const result of concurrent) {
    if (result.status === "rejected") throw result.reason;
  }
  report.concurrentMilliseconds = Math.round(
    performance.now() - concurrentStart
  );
  report.changedTasks = taskStatistics(b);
  report.workerTasks = taskStatistics(a);
  assert(
    report.changedTasks.misses > 0,
    "Changed source must trigger native task computation."
  );
  const htmlA = readFileSync(
    path.join(a, ".next/server/app/index.html"),
    "utf8"
  );
  const htmlB = readFileSync(
    path.join(b, ".next/server/app/index.html"),
    "utf8"
  );
  assert(!htmlA.includes(marker), "A must keep its original source output.");
  assert(
    htmlB.includes(marker),
    "B must reflect changed source despite seeded cache."
  );
  assert.equal(hashFile(path.join(a, "app/page.tsx")), digest(source));
  report.sourceInvalidation.outputs = {
    aSHA256: digest(htmlA),
    bSHA256: digest(htmlB),
    markerOnlyInB: true
  };
  report.outputsAfterConcurrency = independentOutputs();
  assert(
    existsSync(path.join(a, ".open-next/worker.js")),
    "OpenNext must produce a Worker."
  );
  assert(
    !existsSync(path.join(b, ".open-next")),
    "A Worker outputs must stay in A."
  );
  report.worker = {
    path: path.join(a, ".open-next/worker.js"),
    sha256: hashFile(path.join(a, ".open-next/worker.js"))
  };
  report.dependencyHashesAfter = dependencyDigest(report.a.targets);
  assert.deepEqual(
    report.dependencyHashesAfter,
    beforeDependencies,
    "Builds must not modify shared direct dependency files."
  );
  assert.deepEqual(installed(a).targets, report.a.targets);
  assert.deepEqual(installed(b).targets, report.b.targets);
  report.status = "passed";
  save();
  console.log(
    "Linux cache compatibility proof passed; see sanitized artifact."
  );
} catch (error) {
  report.status = "failed";
  const message = error instanceof Error ? error.message : String(error);
  report.error = message;
  save();
  throw new Error(sanitize(message));
}
