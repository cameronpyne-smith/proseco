export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export interface Finding {
  origin: "dependabot" | "defender";
  repo: string | null;
  cve: string;
  severity: Severity;
  ecosystem: string | null;
  package: string;
  installed: string;
  fixedIn: string | null;
  source: string;
  relationship: string | null;
  scope: string | null;
  imageKey: string | null;
}

export interface Enrichment {
  epss: Map<string, number>;
  kev: Set<string>;
}

export interface ExistingTicket {
  number: number;
  nodeId: string;
  state: "open" | "closed";
  stateReason: string | null;
  title: string;
  body: string;
  author: string;
  labels: string[];
}

export interface TicketComment {
  id: number;
  author: string;
  authorType: string;
  body: string;
  createdAt: string;
}

export function toSeverity(value: string | undefined): Severity | null {
  const normalised = value?.toLowerCase();
  return SEVERITIES.find((severity) => severity === normalised) ?? null;
}
