export type FieldRole =
  | 'identifier'
  | 'url'
  | 'location'
  | 'accreditation'
  | 'prior_status'
  | 'prior_note'
  | 'flagged_fields'
  | 'attribute'
  | 'ignore';

export interface FieldMapping {
  key: string;
  role: FieldRole;
  verifyEnabled: boolean;
  promptHint: string;
}

export type FilterOperator =
  | 'equals'
  | 'contains'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty';

export interface ColumnFilterRule {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  enabled: boolean;
}

export interface UnresolvedRuleConfig {
  matchLogic: 'AND' | 'OR';
  columnFilters: ColumnFilterRule[];
  noteField: string;
  flaggedField: string;
  treatEmptyAsUnresolved: boolean;
}

export interface GroundSource {
  title: string;
  uri: string;
  sourceType: 'official_site' | 'registry' | 'web_search';
}

export type FieldVerificationStatus =
  | 'match'
  | 'discrepancy'
  | 'resolved_missing'
  | 'still_unverified';

export type FieldDecision =
  | 'pending'
  | 'accepted'
  | 'kept_original'
  | 'edited';

export interface PriorFieldVerdict {
  status: string;
  rationale: string;
  sourceUrl?: string;
  urlChecked?: string;
}

export interface FieldVerificationResult {
  fieldKey: string;
  originalValue: string;
  priorFlagged: boolean;
  verifiedValue: string;
  status: FieldVerificationStatus;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  evidenceSnippet: string;
  sourceUrls: string[];
  decision: FieldDecision;
  finalValue: string;
}

export interface SavedEvidenceEntry {
  fieldKey: string;
  previousValue: string;
  updatedValue: string;
  decision: FieldDecision;
  reasoning: string;
  evidenceSnippet: string;
  sourceUrls: string[];
}

export interface SavedVerificationRecord {
  savedAt: string;
  previousVerificationStatus: string;
  newVerificationStatus: string;
  entries: SavedEvidenceEntry[];
  allSourceUrls: string[];
}

export type TriageState =
  | 'unresolved'
  | 'investigating'
  | 'needs_review'
  | 'resolved'
  | 'previously_clean'
  | 'api_error';

export interface InstitutionRecord {
  id: string;
  rowIndex: number;
  initialRaw: Record<string, unknown>;
  raw: Record<string, unknown>;
  displayName: string;
  websiteUrl: string;
  locationLabel: string;
  priorStatus: string;
  priorNote: string;
  flaggedFields: string[];
  manualFlaggedFields: string[];
  priorFieldVerdicts: Record<string, PriorFieldVerdict>;
  triageState: TriageState;
  researcherHint: string;
  lastVerifiedAt?: string;
  summaryNote?: string;
  discoveredOfficialUrl?: string;
  sources: GroundSource[];
  fieldResults: Record<string, FieldVerificationResult>;
  savedEvidence?: SavedVerificationRecord;
  errorMessage?: string;
}

export interface VerificationCapabilities {
  webSearch: boolean;
  officialSite: boolean;
  registryCheck: boolean;
}

export type GeminiModelId =
  | 'gemini-3.5-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite'
  | 'gemini-4-neon'
  | 'gemini-4-carbon';

export interface VerifyInstitutionRequest {
  institutionName: string;
  websiteUrl: string;
  locationLabel: string;
  institutionContext?: Record<string, string>;
  priorStatus: string;
  priorNote: string;
  flaggedFields: string[];
  researcherHint: string;
  model?: GeminiModelId;
  targetFields: Array<{
    key: string;
    role: FieldRole;
    currentValue: string;
    promptHint: string;
    isFlagged: boolean;
    priorVerdictStatus?: string;
    priorVerdictRationale?: string;
  }>;
  capabilities: VerificationCapabilities;
}

export interface VerifyInstitutionResponse {
  discoveredOfficialUrl: string;
  executiveSummary: string;
  fields: Array<{
    fieldKey: string;
    verifiedValue: string;
    status: FieldVerificationStatus;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
    evidenceSnippet: string;
    sourceUrls: string[];
  }>;
  sources: GroundSource[];
  verifiedAt: string;
  warnings?: string[];
}

export type DatasetFormat = 'csv' | 'json';

export interface DatasetMeta {
  fileName: string;
  format: DatasetFormat;
  columnOrder: string[];
  jsonRootKey: string | null;
  importedAt: string;
}
