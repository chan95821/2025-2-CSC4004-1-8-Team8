import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { Button } from '~/components';
import { useLocalize } from '~/hooks';
import store from '~/store';
import { fetchKnowledgeGraph, deleteGraphNodes, createGraphEdge } from '~/api/kgraph';
import type { GraphNode } from '~/store/knowledgeGraph';

const convoScope = (node: GraphNode, fallback = 'default') =>
  node.source_conversation_id ?? fallback;

const resolveConvoId = (
  conversation: any,
  messages: any[] | null | undefined,
  fallback = 'default',
) => {
  if (conversation?.conversationId) return conversation.conversationId as string;
  if (Array.isArray(messages)) {
    const withId = messages.find((m) => (m as any)?.conversationId);
    if (withId?.conversationId) return withId.conversationId as string;
  }
  if (typeof window !== 'undefined') {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('c');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
  }
  return fallback;
};

export default function GraphPanel() {
  const localize = useLocalize();
  const conversation = useRecoilValue(store.conversation);
  const messages = useRecoilValue(store.messages);
  const latestMessage = useRecoilValue(store.latestMessage);
  const convoId = resolveConvoId(conversation, messages, latestMessage?.conversationId ?? 'default');
  const [nodes, setNodes] = useRecoilState(store.knowledgeNodesByConvo(convoId));
  const [edges, setEdges] = useRecoilState(store.knowledgeEdgesByConvo(convoId));
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKnowledgeGraph();
      const scopedNodes = data.nodes.filter((node) => convoScope(node) === convoId);
      const scopedIds = new Set(scopedNodes.map((n) => n.id));
      const scopedEdges = data.edges.filter(
        (edge) => scopedIds.has(edge.source) && scopedIds.has(edge.target),
      );
      setNodes(scopedNodes);
      setEdges(scopedEdges);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge graph');
    } finally {
      setLoading(false);
    }
  }, [convoId, setEdges, setNodes]);

  useEffect(() => {
    // clear stale state when switching conversations
    setNodes([]);
    setEdges([]);
    loadGraph();
  }, [loadGraph, convoId, setEdges, setNodes]);

  const displayNodes: RFNode[] = useMemo(() => {
    const gapX = 260;
    const gapY = 160;
    return nodes.map((node, index) => ({
      id: node.id,
      data: { label: node.labels[0] || node.content.slice(0, 40) || `Node ${index + 1}` },
      position: { x: (index % 3) * gapX, y: Math.floor(index / 3) * gapY },
    }));
  }, [nodes]);

  const displayEdges: RFEdge[] = useMemo(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.labels[0],
        animated: true,
      })),
    [edges],
  );

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) {
        return;
      }
      setError(null);
      try {
        const newEdge = await createGraphEdge({
          source: connection.source,
          target: connection.target,
        });
        setEdges((prev) => [...prev, newEdge]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create edge');
      }
    },
    [setEdges],
  );

  const clearAll = useCallback(async () => {
    if (!nodes.length) return;
    setClearing(true);
    setError(null);
    try {
      await deleteGraphNodes(nodes.map((n) => n.id));
      setNodes([]);
      setEdges([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete nodes');
    } finally {
      setClearing(false);
    }
  }, [nodes, setEdges, setNodes]);

  return (
    <div className="flex h-full w-full flex-col p-2">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="text-sm font-semibold text-text-primary">
          {localize('com_sidepanel_knowledge_graph') || 'Knowledge Graph'}
        </div>
        <Button size="sm" variant="outline" onClick={clearAll} disabled={clearing || loading}>
          {clearing ? localize('com_ui_clearing') || 'Clearing…' : 'Clear'}
        </Button>
      </div>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      <div className="relative h-[60vh] min-h-[300px] overflow-hidden rounded-md border border-border-light">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            {localize('com_ui_loading') || 'Loading…'}
          </div>
        ) : (
          <ReactFlow nodes={displayNodes} edges={displayEdges} onConnect={onConnect} fitView>
            <MiniMap />
            <Controls />
            <Background />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}
