export const issueTitle = "Review dependency updates";
export const startMarker = "<!-- relay-dependency-report:start -->";
export const endMarker = "<!-- relay-dependency-report:end -->";

export interface Dependency {
  readonly ecosystem: "npm" | "GitHub Actions";
  readonly name: string;
  readonly current: string;
  readonly files: readonly string[];
}

export interface Update extends Dependency {
  readonly latest: string;
}

type Request = (
  path: string,
  method?: "GET" | "POST" | "PATCH",
  body?: unknown,
) => Promise<unknown>;

function versionParts(version: string): number[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected a stable, exact version: ${version}`);
  return match.slice(1).map(Number);
}

export function isNewer(current: string, latest: string): boolean {
  const before = versionParts(current);
  const after = versionParts(latest);
  for (let index = 0; index < 3; index++) {
    if (before[index] !== after[index]) return after[index] > before[index];
  }
  return false;
}

export function npmDependencies(manifest: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): Dependency[] {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).map(([name, current]) => {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name)) {
      throw new Error("Unsupported npm package name");
    }
    versionParts(current);
    return {
      ecosystem: "npm",
      name,
      current,
      files: ["apps/web/package.json"],
    };
  });
}

export function actionDependencies(
  workflows: readonly { path: string; source: string }[],
): Dependency[] {
  const dependencies = new Map<string, Dependency>();
  for (const workflow of workflows) {
    for (
      const [, reference] of workflow.source.matchAll(
        /^\s*(?:-\s*)?uses:\s*(.+)$/gm,
      )
    ) {
      if (reference.startsWith("./")) continue;
      const match =
        /^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@[a-f0-9]{40}\s+#\s*v?(\d+\.\d+\.\d+)\s*$/
          .exec(reference);
      if (!match) {
        throw new Error(`Unrecognized action pin in ${workflow.path}`);
      }
      const [, name, current] = match;
      const key = `${name}@${current}`;
      const previous = dependencies.get(key);
      dependencies.set(key, {
        ecosystem: "GitHub Actions",
        name,
        current,
        files: [...new Set([...(previous?.files ?? []), workflow.path])].sort(),
      });
    }
  }
  return [...dependencies.values()];
}

export async function findUpdates(
  dependencies: readonly Dependency[],
  latestVersion: (dependency: Dependency) => Promise<string>,
): Promise<Update[]> {
  // Complete every lookup before publishing. A failed lookup must not erase
  // an existing report or incorrectly report that dependencies are current.
  const updates = await Promise.all(dependencies.map(async (dependency) => {
    const latest = await latestVersion(dependency);
    return isNewer(dependency.current, latest)
      ? { ...dependency, latest }
      : null;
  }));
  return updates.filter((update): update is Update => update !== null)
    .sort((a, b) =>
      `${a.ecosystem}/${a.name}`.localeCompare(`${b.ecosystem}/${b.name}`)
    );
}

export function renderReport(updates: readonly Update[]): string {
  const rows = updates.map((update) => {
    const url = update.ecosystem === "npm"
      ? `https://www.npmjs.com/package/${update.name}/v/${update.latest}`
      : `https://github.com/${update.name}/releases`;
    return `| ${update.ecosystem} | [${update.name}](${url}) | ${update.current} | ${update.latest} | ${
      update.files.map((file) => `\`${file}\``).join(", ")
    } |`;
  });
  return [
    startMarker,
    "Dependency updates require review and a deliberate implementation PR.",
    "This report checks direct web npm dependencies and pinned GitHub Actions against their latest stable releases.",
    "",
    ...(rows.length > 0
      ? [
        "| Ecosystem | Dependency | Configured | Latest | Files |",
        "| --- | --- | --- | --- | --- |",
        ...rows,
      ]
      : ["No newer stable releases were found in the monitored dependencies."]),
    "",
    "Review compatibility, release notes, and security advisories before updating. Keep Better Auth packages aligned across the frontend and Deno backend. Update lockfiles, keep Actions pinned to reviewed full commit SHAs, and run the affected checks.",
    "",
    "This is an update report, not a vulnerability scan. CI security scans remain separate. The reporter does not change code, open PRs, or close this issue. Place review notes outside the generated section to preserve them on the next run.",
    endMarker,
  ].join("\n");
}

export function replaceReport(body: string, report: string): string {
  const start = body.indexOf(startMarker);
  const end = body.indexOf(endMarker, start);
  if (start < 0 || end < start) {
    throw new Error("Dependency issue markers are incomplete");
  }
  return body.slice(0, start) + report + body.slice(end + endMarker.length);
}

interface Issue {
  number: number;
  title: string;
  body: string | null;
  pull_request?: unknown;
}

export async function publishReport(
  request: Request,
  repository: string,
  updates: readonly Update[],
): Promise<void> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Invalid repository");
  }
  const base = `/repos/${repository}/issues`;
  const matches: Issue[] = [];
  for (let page = 1;; page++) {
    const issues = await request(
      `${base}?state=open&per_page=100&page=${page}`,
    ) as Issue[];
    if (!Array.isArray(issues)) throw new Error("Invalid issues response");
    matches.push(
      ...issues.filter((issue) =>
        !issue.pull_request && issue.title === issueTitle &&
        issue.body?.includes(startMarker)
      ),
    );
    if (issues.length < 100) break;
  }
  if (matches.length > 1) {
    throw new Error("Multiple open dependency reports need review");
  }
  const issue = matches[0];
  const report = renderReport(updates);
  if (issue) {
    const body = replaceReport(issue.body ?? "", report);
    if (body !== issue.body) {
      await request(`${base}/${issue.number}`, "PATCH", { body });
    }
  } else if (updates.length > 0) {
    await request(base, "POST", { title: issueTitle, body: report });
  }
}

async function main(): Promise<void> {
  if (
    Deno.args.length > 1 ||
    (Deno.args.length === 1 && Deno.args[0] !== "--publish")
  ) {
    throw new Error("Usage: report.ts [--publish]");
  }
  const token = Deno.env.get("GH_TOKEN");
  const repository = Deno.env.get("GITHUB_REPOSITORY");
  if (Deno.args[0] === "--publish" && (!token || !repository)) {
    throw new Error("Publishing requires GH_TOKEN and GITHUB_REPOSITORY");
  }
  async function json(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Dependency lookup/request failed: HTTP ${response.status} at ${url}`,
      );
    }
    return response.json();
  }
  const github: Request = (path, method = "GET", body) =>
    json(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "relay-dependency-report",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const workflows = [];
  for await (const entry of Deno.readDir(".github/workflows")) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    const path = `.github/workflows/${entry.name}`;
    workflows.push({ path, source: await Deno.readTextFile(path) });
  }
  const dependencies = [
    ...npmDependencies(
      JSON.parse(await Deno.readTextFile("apps/web/package.json")),
    ),
    ...actionDependencies(workflows),
  ];
  const updates = await findUpdates(dependencies, async (dependency) => {
    if (dependency.ecosystem === "npm") {
      const tags = await json(
        `https://registry.npmjs.org/-/package/${
          encodeURIComponent(dependency.name)
        }/dist-tags`,
      ) as { latest?: string };
      if (typeof tags.latest !== "string") {
        throw new Error(`Missing npm version: ${dependency.name}`);
      }
      return tags.latest;
    }
    const release = await github(
      `/repos/${dependency.name}/releases/latest`,
    ) as { tag_name?: string };
    if (typeof release.tag_name !== "string") {
      throw new Error(`Missing action release: ${dependency.name}`);
    }
    return release.tag_name;
  });
  if (Deno.args[0] === "--publish") {
    await publishReport(github, repository!, updates);
    console.log(`Dependency report synchronized (${updates.length} updates).`);
  } else {
    console.log(renderReport(updates));
  }
}

if (import.meta.main) await main();
