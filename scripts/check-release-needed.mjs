// Release freshness check (wired to `npm run release:check`). Answers one
// question per train: is there a newer React upstream than what rsl has
// published? Compares npm's react dist-tags against rsl's own dist-tags —
// the registry is the source of truth on both sides, so the local ../react
// checkout (which may be stale) never skews the verdict.
//
//   stable        react@latest            vs the React named by rsl's peer
//   experimental  react@experimental sha  vs rsl@experimental sha
//
// Exit code 0 = both trains current, 1 = at least one release suggested
// (cron/CI friendly). Suggestions print the exact release.sh invocation,
// pinning --react-ref to the sha npm's react was built from, so the vendored
// transport matches the React users actually install from that channel.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function distTags(name) {
  return JSON.parse(
    execFileSync("npm", ["view", name, "dist-tags", "--json"], {
      encoding: "utf8",
    })
  );
}

// React's prerelease scheme on npm: 0.0.0-experimental-<sha>-<yyyymmdd> and
// 19.x.0-canary-<sha>-<yyyymmdd>. build-rsl.sh stamps rsl's experimental
// train the same way, so shas compare 1:1.
function shaOf(version) {
  const m = /-(?:experimental|canary)-([0-9a-f]+)-(\d{8})$/.exec(version ?? "");
  return m ? { sha: m[1], date: m[2] } : null;
}

function semverNewer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

const react = distTags("react");
const rsl = distTags(pkg.name);
const suggestions = [];

// --- stable train -----------------------------------------------------------
// Under @types-style versioning the React rsl vendored is named by the peer
// (^19.2.7), not by rsl's own version.
const vendoredStable = (pkg.peerDependencies?.react ?? "").match(
  /[0-9]+[.][0-9]+[.][0-9]+/
)?.[0];

if (!vendoredStable) {
  console.error("✖ cannot read the vendored React version from peerDependencies.react");
  process.exit(2);
}

if (semverNewer(react.latest, vendoredStable)) {
  console.log(
    `stable:        BEHIND — react@latest is ${react.latest}, rsl vendors ${vendoredStable}`
  );
  suggestions.push(`./scripts/release.sh --react-ref v${react.latest}`);
} else {
  console.log(
    `stable:        current — vendored ${vendoredStable} covers react@latest ${react.latest} (rsl ${rsl.latest})`
  );
}

// --- experimental train ------------------------------------------------------
const upstreamExp = shaOf(react.experimental);
const publishedExp = shaOf(rsl.experimental);

if (!upstreamExp) {
  console.log(
    `experimental:  cannot parse react@experimental (${react.experimental}) — scheme changed upstream?`
  );
  process.exit(2);
} else if (!publishedExp) {
  console.log(
    `experimental:  NEVER PUBLISHED — react@experimental is at ${upstreamExp.sha} (${upstreamExp.date})`
  );
  suggestions.push(`./scripts/release.sh --channel experimental --react-ref ${upstreamExp.sha}`);
} else if (publishedExp.sha !== upstreamExp.sha) {
  console.log(
    `experimental:  BEHIND — react@experimental is ${upstreamExp.sha} (${upstreamExp.date}), rsl published ${publishedExp.sha} (${publishedExp.date})`
  );
  suggestions.push(`./scripts/release.sh --channel experimental --react-ref ${upstreamExp.sha}`);
} else {
  console.log(
    `experimental:  current — both at ${upstreamExp.sha} (${upstreamExp.date})`
  );
}

// --- verdict -----------------------------------------------------------------
if (suggestions.length === 0) {
  console.log("\n✓ nothing to release — both trains current.");
  process.exit(0);
}

console.log(
  "\n→ release suggested. Make sure ../react has the ref (git fetch), then:\n" +
    suggestions.map((s) => "    " + s).join("\n")
);
process.exit(1);
