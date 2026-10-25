import { highestVersion, packageKey } from "../core/versions.ts";
import type { Ecosystem } from "./ecosystems/ecosystem.ts";
import { forcedMajors } from "./majors.ts";

export interface CrossedMajor {
  package: string;
  from: string;
  to: string;
}

export function crossedMajors(ecosystem: Ecosystem, before: string, after: string, upgraded: { package: string; installed: string }): CrossedMajor[] {
  const crossed: CrossedMajor[] = [];
  const installed = ecosystem.installedVersions(after).get(packageKey(ecosystem.findingEcosystem, upgraded.package)) ?? ecosystem.installedVersions(after).get(upgraded.package);
  const now = installed ? highestVersion(installed)[0] : undefined;
  if (now && now !== upgraded.installed) crossed.push({ package: upgraded.package, from: upgraded.installed, to: now });
  for (const item of forcedMajors(ecosystem, before, after, upgraded.package)) crossed.push({ package: item.package, from: item.from, to: item.to });
  return crossed;
}

export function reviewMessage(crossed: CrossedMajor[], commands: (pkg: string) => string[]): string {
  return [
    "Not accepted yet: review before you finish. The lockfile now holds these packages across a major version:",
    ...crossed.map((item) => `- ${item.package} ${item.from} → ${item.to}`),
    "",
    "A build or an install that passes does not show the code still works. For each package above:",
    "1. Search the installed package for messages about removed or changed APIs, and read its README, CHANGELOG or MIGRATION files. Install the dependencies first if they are not installed.",
    ...crossed.flatMap((item) => commands(item.package).map((line) => `   ${item.package}: ${line}`)),
    "2. Check every import and use of the package in the repository, including entry points such as main.js or index.ts, not only components or modules that look related.",
    "3. Fix what breaks against what the installed package says, then run the build and the tests again.",
    "Then call finish again; the second finish is accepted.",
  ].join("\n");
}
