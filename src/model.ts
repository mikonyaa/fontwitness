import type { Config, Rule, FontMatcher } from './config.js';

export const TOOL_VERSION = '0.1.0';
export const PLAYWRIGHT_VERSION = '1.64.0';
export const CHROMIUM_VERSION = '156.0.8078.4';
export const CAPTURE_POLICY = 'light-dom-textnodes-v1';
export type Coverage = 'complete' | 'partial';
export type MeasurementStatus = 'measured' | 'unmeasured';
export type ContractStatus = 'expected' | 'unexpected' | 'unmeasured';
export interface Diagnostic { code: string; message: string; }
export interface FontUsage { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number; }
export interface Observation {
  id: string; path: string; textFingerprint: string; textLength: number; text?: string;
  requestedCSS: { fontFamily: string; fontSize: string; fontWeight: string; fontStyle: string; };
  measurementStatus: MeasurementStatus; fonts: FontUsage[]; reasons: Diagnostic[];
  provenance: { method: 'CSS.getPlatformFontsForNode'; nodeType: 3; backendNodeId?: number; };
}
export interface ElementCapture {
  id: string; key: string | null; path: string; nodeIds: string[];
  textFingerprint: string; structureFingerprint: string; signature: string;
  measurementStatus: MeasurementStatus; coverage: Coverage; reasons: Diagnostic[];
  counts: { textNodes: number; measured: number; excluded: number; unsupported: number; };
}
export interface CapturedRule { rule: Rule; matched: number; elements: ElementCapture[]; reasons: Diagnostic[]; }
export interface ElementResult {
  elementId: string; key: string | null; measurementStatus: MeasurementStatus;
  contractStatus: ContractStatus; coverage: Coverage; reasons: Diagnostic[];
  actualFonts: Array<Omit<FontUsage, 'glyphCount'> & { observationIds: string[] }>;
  allowed: FontMatcher[]; required: FontMatcher[];
}
export interface RuleResult {
  id: string; selector: string; contractStatus: ContractStatus; coverage: Coverage;
  matched: number; reasons: Diagnostic[]; elements: ElementResult[];
}
export interface RunReport {
  schemaVersion: 1; kind: 'capture'; mode: 'inspect' | 'audit'; toolVersion: string;
  captureId: string; recordedAt: string;
  target: { pageId: string; url: string; finalUrl: string; };
  environment: { browser: string; playwright: string; node: string; os: string; osVersion: string; arch: string; };
  settings: { browser: Config['browser']; capturePolicy: string; limits: Config['limits']; };
  readiness: { fontsReady: boolean; stable: boolean; attempts: number; stableWindowMs: number; samples: string[]; };
  coverage: { status: Coverage; matched: number; measured: number; unmeasured: number; excluded: number; unsupported: number; excludedSurfaces: string[]; };
  observations: Observation[]; capturedRules: CapturedRule[]; ruleResults?: RuleResult[];
  diagnostics: Diagnostic[]; networkEvidence: Array<{ url: string; status?: number; code: string }>;
  artifactManifest: Array<{ path: string; mediaType: string; bytes: number; sha256: string; consistent: boolean; }>;
  summary: { exitCode: number; partial: boolean; contractVerdict?: ContractStatus; };
}
export interface CompareReport {
  schemaVersion: 1; kind: 'comparison'; toolVersion: string; recordedAt: string;
  mode: 'strict' | 'cross-env'; contractVerdict: null; before: string; after: string;
  environmentDifferences: string[]; diagnostics: Diagnostic[];
  changes: Array<{ ruleId: string; key: string; before: string[]; after: string[]; changed: boolean; }>;
  summary: { exitCode: number; partial: boolean; changed: number; };
}
export type Report = RunReport | CompareReport;
