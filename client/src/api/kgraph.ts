import { request } from 'librechat-data-provider';
import type { GraphNode, GraphEdge } from '~/store/knowledgeGraph';

export type CreateNodePayload = {
  label: string | string[];
  labels?: string[];
  content?: string;
  idea_text?: string;
  x?: number | null;
  y?: number | null;
  source_message_id?: string;
  source_conversation_id?: string;
  vector_ref?: unknown;
};

export type CreateEdgePayload = {
  source: string;
  target: string;
  labels?: string[];
};

type GraphResponse = {
  nodes?: any[];
  edges?: any[];
};

const ensureArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string' && value.length > 0) {
    return [value];
  }
  return [];
};

const normalizeNode = (node: any): GraphNode => ({
  id: node?.id ?? node?._id ?? crypto.randomUUID?.() ?? String(Date.now()),
  content: node?.content ?? node?.idea_text ?? '',
  labels: ensureArray(node?.labels ?? node?.label),
  x: typeof node?.x === 'number' ? node.x : null,
  y: typeof node?.y === 'number' ? node.y : null,
  source_message_id: node?.source_message_id ?? node?.source_messageId,
  source_conversation_id: node?.source_conversation_id ?? node?.source_conversationId,
});

const normalizeEdge = (edge: any): GraphEdge => ({
  id: edge?.id ?? edge?._id ?? crypto.randomUUID?.() ?? String(Date.now()),
  source: edge?.source,
  target: edge?.target,
  labels: ensureArray(edge?.labels ?? edge?.label),
});

export async function fetchKnowledgeGraph(): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const data = await request.get('/api/kgraphs');
  return {
    nodes: (data?.nodes || []).map(normalizeNode),
    edges: (data?.edges || []).map(normalizeEdge),
  };
}

export async function createGraphNode(payload: CreateNodePayload): Promise<GraphNode> {
  const data = await request.post('/api/kgraphs/nodes', payload);
  return normalizeNode(data);
}

export async function deleteGraphNodes(nodeIds: string[]): Promise<void> {
  if (!nodeIds.length) {
    return;
  }
  await request.post('/api/kgraphs/nodes/delete', { nodeIds });
}

export async function createGraphEdge(payload: CreateEdgePayload): Promise<GraphEdge> {
  const data = await request.post('/api/kgraphs/edges', payload);
  return normalizeEdge(data);
}
