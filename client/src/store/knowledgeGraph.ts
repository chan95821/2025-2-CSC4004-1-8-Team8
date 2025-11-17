import { atomFamily } from 'recoil';

export type GraphNode = {
  id: string;
  content: string;
  labels: string[];
  x: number | null;
  y: number | null;
  source_message_id?: string;
  source_conversation_id?: string;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  labels: string[];
};

export type CandidateNode = {
  id: string;
  label: string;
  content: string;
  source_message_id?: string;
  source_conversation_id: string;
  isSeed?: boolean;
};

export const knowledgeNodesByConvo = atomFamily<GraphNode[], string>({
  key: 'knowledgeNodesByConvo',
  default: [],
});

export const knowledgeEdgesByConvo = atomFamily<GraphEdge[], string>({
  key: 'knowledgeEdgesByConvo',
  default: [],
});

export const candidateNodesByConvo = atomFamily<CandidateNode[], string>({
  key: 'candidateNodesByConvo',
  default: [],
});
