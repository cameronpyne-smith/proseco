import type { Finding } from "../core/types.ts";

export interface Source {
  readonly name: string;
  fetch(): Promise<Finding[]>;
  diagnostics?(): string[];
}
