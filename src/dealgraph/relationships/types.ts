export type EntityKind = 'person' | 'organization' | 'project';
export type RelationKind = 'employment' | 'decision_authority' | 'ownership' | 'investment' | 'advisory' | 'lending' | 'acquisition' | 'subsidiary' | 'project_role' | 'introduction' | 'cooperation';
export type SourceKind = 'registry' | 'signed_agreement' | 'announcement' | 'meeting_notes' | 'email' | 'chat' | 'rumor';
export type RelationStatus = 'supported' | 'review' | 'conflicted' | 'historical' | 'rejected';
export interface RelationshipEntity {
  id: string;
  name: string;
  kind: EntityKind;
  aliases?: string[];
  category?: string;
}
export interface RelationshipDocument {
  id: string;
  title: string;
  sourceKind: SourceKind;
  sourceId: string;
  publishedAt: string;
  text: string;
  projectId?: string;
  validFrom?: string;
  validTo?: string;
}
export interface RelationshipInteraction {
  sourceId: string;
  targetId: string;
  count: number;
  lastAt: string;
}
export interface RelationshipCase {
  schema: 'dealgraph.relationship-case.v1';
  dataClass: 'synthetic' | 'user-provided';
  title: string;
  asOf: string;
  entities: RelationshipEntity[];
  documents: RelationshipDocument[];
  interactions?: RelationshipInteraction[];
}
export interface RelationshipEvidence {
  id: string;
  documentId: string;
  documentTitle: string;
  sourceId: string;
  sourceKind: SourceKind;
  publishedAt: string;
  quote: string;
  stance: 'affirmed' | 'negated' | 'uncertain' | 'historical';
  reason: string;
}
export interface BusinessRelationship {
  id: string;
  sourceId: string;
  targetId: string;
  kind: RelationKind;
  label: string;
  status: RelationStatus;
  confidence: 'high' | 'medium' | 'low';
  evidenceIds: string[];
  independentSources: number;
  rationale: string;
  projectId?: string;
  viaId?: string;
  role?: string;
  percentage?: number;
}
export interface AnalysisIssue {
  id: string;
  documentId?: string;
  kind: 'ambiguous_identity' | 'unsupported_language' | 'future_source' | 'duplicate_source' | 'invalid_input' | 'insufficient_evidence';
  message: string;
  quote?: string;
}
export interface RelationshipAnalysis {
  schema: 'dealgraph.relationship-analysis.v1';
  title: string;
  dataClass: 'synthetic' | 'user-provided';
  asOf: string;
  entities: RelationshipEntity[];
  relationships: BusinessRelationship[];
  evidence: RelationshipEvidence[];
  issues: AnalysisIssue[];
  summary: {
    supported: number;
    review: number;
    conflicted: number;
    historical: number;
    rejected: number;
    documents: number;
    evidenceCoverage: number;
  };
}
