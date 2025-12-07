import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import ReactFlow, {
  Background,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { Button } from '~/components';
import { useLocalize } from '~/hooks';
import store from '~/store';
import {
  fetchKnowledgeGraph,
  deleteGraphNodes,
  createGraphEdge,
  updateGraphNode,
  updateGraphEdge,
  deleteGraphEdge,
  createGraphNode,
  requestClusterUpdate,
  fetchGraphRecommendations,
} from '~/api/kgraph';
import type { GraphNode } from '~/store/knowledgeGraph';

const DEFAULT_EDGE_LABELS = [
  '원인-결과',
  '문제-해결',
  '필요-수단',
  '목표-과제',
  '조건-결론',
  '구성-구성요소',
  '평행/동시 진행',
  '사례-참고',
  '대안-선택지',
  '유사/연관',
  '대비/충돌',
  '선행-후행',
  '요구-지원',
];

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
  const convoId = resolveConvoId(
    conversation,
    messages,
    latestMessage?.conversationId ?? 'default',
  );
  const [nodes, setNodes] = useRecoilState(store.knowledgeNodesByConvo(convoId));
  const [edges, setEdges] = useRecoilState(store.knowledgeEdgesByConvo(convoId));
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdge, setSelectedEdge] = useState<RFEdge | null>(null);
  const [nodeDraft, setNodeDraft] = useState<{
    label: string;
    content: string;
    labelsText: string;
  }>({
    label: '',
    content: '',
    labelsText: '',
  });
  const [edgeLabelDraft, setEdgeLabelDraft] = useState<string>('');
  const [savingNode, setSavingNode] = useState(false);
  const [savingEdge, setSavingEdge] = useState(false);
  const [positioning, setPositioning] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  const [recoLoading, setRecoLoading] = useState(false);
  const [recoIds, setRecoIds] = useState<string[]>([]);
  const [recoRequested, setRecoRequested] = useState(false);
  const [recoMethod, setRecoMethod] = useState<'synonyms' | 'edge_analogy' | 'least_similar'>(
    'synonyms',
  );
  const [edgeLabelInput, setEdgeLabelInput] = useState('');
  const [connectingRecoId, setConnectingRecoId] = useState<string | null>(null);
  const [recoNotice, setRecoNotice] = useState<{
    type: 'error' | 'success' | 'info';
    text: string;
  } | null>(null);
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [labelModalValue, setLabelModalValue] = useState('');
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);

  // 서버 응답 엣지를 ReactFlow용으로 정규화
  const normalizeEdge = useCallback((raw: any) => {
    const edge = raw?.edge ? raw.edge : raw;
    const id = edge.id || edge._id || `${edge.source}-${edge.target}-${Date.now()}`;
    const labels =
      Array.isArray(edge.labels) && edge.labels.length
        ? edge.labels
        : edge.label
          ? [edge.label]
          : [];
    return { ...edge, id, labels };
  }, []);
  const recoItems = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n]));
    return recoIds.map((id) => {
      const node = map.get(id);
      const label =
        (node?.labels?.[0] || '').trim() ||
        (node?.label || '').trim() ||
        (node?.content || node?.idea_text || '').slice(0, 50) ||
        id || '제목 없음';
      return { id, label };
    });
  }, [nodes, recoIds]);

  // edge_analogy용 자동 라벨 추천: 기본 라벨 + 현재 그래프 엣지 라벨 빈도 상위
  const edgeLabelSuggestions = useMemo(() => {
    const freq = new Map<string, number>();
    edges.forEach((edge: any) => {
      const labels: string[] = Array.isArray(edge.labels)
        ? edge.labels
        : edge.label
        ? [edge.label]
        : [];
      labels
        .map((l) => (typeof l === 'string' ? l.trim() : ''))
        .filter(Boolean)
        .forEach((l) => {
          freq.set(l, (freq.get(l) || 0) + 1);
        });
    });
    // 기본 라벨에 기본 가중치 부여(등장하지 않은 경우 1로)
    DEFAULT_EDGE_LABELS.forEach((l) => {
      freq.set(l, (freq.get(l) || 0) + 1);
    });

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([l]) => l);
  }, [edges]);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchKnowledgeGraph(showAll ? undefined : convoId);
      // 서버에서 이미 필터링(conversationId 없으면 전체 그래프)
      setNodes(data.nodes);
      setEdges(data.edges as any);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge graph');
    } finally {
      setLoading(false);
    }
  }, [convoId, setEdges, setNodes, showAll]);

  const repositionGraph = useCallback(async () => {
    setPositioning(true);
    setError(null);
    try {
      await requestClusterUpdate();
      await loadGraph();
    } catch (err) {
      setError(err instanceof Error ? err.message : '좌표 계산에 실패했습니다');
    } finally {
      setPositioning(false);
    }
  }, [loadGraph]);

  const handleRecommendations = useCallback(async () => {
    if (!selectedNodeIds.length) {
      setRecoNotice({ type: 'error', text: '추천을 받을 노드를 선택하세요.' });
      return;
    }
    if (recoMethod === 'edge_analogy' && !edgeLabelInput.trim()) {
      setRecoNotice({ type: 'error', text: 'edge_analogy는 관계 라벨이 필요합니다.' });
      return;
    }
    setRecoLoading(true);
    setRecoRequested(true);
    setRecoNotice(null);
    try {
      const nodeId = selectedNodeIds[0];
      const params: Record<string, string | number> = { nodeId, top_k: 5 };
      if (recoMethod === 'edge_analogy') {
        params.edge_label = edgeLabelInput.trim();
      }
      const ids = await fetchGraphRecommendations(recoMethod, params);
      setRecoIds(ids);
      setRecoNotice(
        ids.length
          ? { type: 'success', text: `추천 ${ids.length}개를 가져왔습니다.` }
          : { type: 'info', text: '추천 결과가 없습니다.' },
      );
    } catch (err) {
      setRecoNotice({
        type: 'error',
        text: err instanceof Error ? err.message : '추천 조회 실패',
      });
      setRecoIds([]);
    } finally {
      setRecoLoading(false);
    }
  }, [selectedNodeIds, recoMethod, edgeLabelInput, setRecoIds]);

  useEffect(() => {
    // clear stale state when switching conversations
    setNodes([]);
    setEdges([]);
    loadGraph();
  }, [loadGraph, convoId, setEdges, setNodes, showAll]);

  const toggleScope = () => {
    setShowAll((prev) => !prev);
  };

  const displayNodes: RFNode[] = useMemo(() => {
    const gapX = 260;
    const gapY = 160;
    const used = new Map<string, number>();
    const pickLabel = (node: GraphNode, fallbackIndex: number) => {
      const labelText = (node.labels?.[0] || '').trim();
      if (labelText) return labelText;
      const contentText = (node.content || '').trim();
      if (contentText) return contentText.slice(0, 80);
      return `Node ${fallbackIndex + 1}`;
    };
    return nodes.map((node, index) => {
      const fallback = { x: (index % 3) * gapX, y: Math.floor(index / 3) * gapY };
      const hasPosition =
        typeof node.x === 'number' && typeof node.y === 'number' && !(node.x === 0 && node.y === 0); // 서버 기본값(0,0)일 때는 겹치지 않게 배치
      const basePos = hasPosition ? { x: node.x!, y: node.y! } : fallback;
      const key = `${Math.round(basePos.x)}:${Math.round(basePos.y)}`;
      const hit = used.get(key) || 0;
      used.set(key, hit + 1);
      const offset = hit > 0 ? 30 * hit : 0; // 동일 좌표가 있을 때 살짝 비틀어 배치
      return {
        id: node.id,
        data: { label: pickLabel(node, index) },
        position: { x: basePos.x + offset, y: basePos.y + offset },
        selected: selectedNodeIds.includes(node.id),
      };
    });
  }, [nodes, selectedNodeIds]);

  const displayEdges: RFEdge[] = useMemo(
    () =>
      edges.map((edge) => {
        const labels = Array.isArray(edge.labels) ? edge.labels : edge.label ? [edge.label] : [];
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: labels[0] || '',
          animated: true,
          selected: selectedEdge?.id === edge.id,
        };
      }),
    [edges, selectedEdge?.id],
  );

  const selectedNodes = useMemo(
    () => nodes.filter((node) => selectedNodeIds.includes(node.id)),
    [nodes, selectedNodeIds],
  );

  const handleOpenConversation = useCallback(() => {
    const target = selectedNodes[0];
    const convId = target?.source_conversation_id;
    if (!convId) {
      setError('이 노드의 대화 ID가 없습니다.');
      return;
    }
    window.open(`/c/${convId}`, '_blank');
  }, [selectedNodes]);

  // 선택된 노드(첫 번째 기준)와 연결된 노드/관계 목록
  const connectedEdges = useMemo(() => {
    if (!selectedNodeIds.length) return [];
    const focusId = selectedNodeIds[0];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    return edges
      .filter((e) => e.source === focusId || e.target === focusId)
      .map((e) => {
        const otherId = e.source === focusId ? e.target : e.source;
        return {
          edge: e,
          other: nodeMap.get(otherId),
          direction: e.source === focusId ? 'out' : 'in',
        };
      });
  }, [edges, nodes, selectedNodeIds]);

  useEffect(() => {
    const focusNode = selectedNodes[0];
    if (focusNode) {
      setNodeDraft({
        label: (focusNode.labels?.[0] || '').trim(),
        content: focusNode.content || '',
        labelsText: (focusNode.labels || []).join(', '),
      });
    }
  }, [selectedNodes]);

  useEffect(() => {
    if (selectedEdge) {
      setEdgeLabelDraft(selectedEdge.label || '');
    }
  }, [selectedEdge]);

  const parseLabels = useCallback((raw: string) => {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }, []);

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      // 모달 열어서 라벨 입력/선택 받기
      setPendingConnection(connection);
      setLabelModalValue(edgeLabelInput || edgeLabelSuggestions[0] || '');
      setLabelModalOpen(true);
    },
    [edgeLabelInput, edgeLabelSuggestions, setEdges, parseLabels],
  );

  const onSelectionChange = useCallback(({ nodes: rfNodes = [], edges: rfEdges = [] }) => {
    setSelectedNodeIds(rfNodes.map((n) => n.id));
    setSelectedEdge(rfEdges[0] ?? null);
  }, []);

  const handleSaveNode = useCallback(async () => {
    setSavingNode(true);
    setError(null);
    const labels = parseLabels(nodeDraft.labelsText || nodeDraft.label);
    try {
      const targetId = selectedNodeIds[0];
      if (targetId) {
        const updated = await updateGraphNode(targetId, {
          content: nodeDraft.content,
          idea_text: nodeDraft.content,
          labels,
        });
        setNodes((prev) =>
          prev.map((node) => (node.id === targetId ? { ...node, ...updated } : node)),
        );
      } else {
        const defaultLabel = nodeDraft.label || nodeDraft.content.slice(0, 40) || '새 노드';
        const created = await createGraphNode({
          label: defaultLabel,
          labels: labels.length ? labels : [defaultLabel],
          content: nodeDraft.content,
          idea_text: nodeDraft.content,
          source_conversation_id: convoId,
        });
        setNodes((prev) => [...prev, created]);
        setSelectedNodeIds([created.id]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '노드 저장에 실패했습니다');
    } finally {
      setSavingNode(false);
    }
  }, [
    convoId,
    nodeDraft.content,
    nodeDraft.label,
    nodeDraft.labelsText,
    parseLabels,
    repositionGraph,
    selectedNodeIds,
    setNodes,
  ]);

  const handleDeleteSelectedNodes = useCallback(async () => {
    if (!selectedNodeIds.length) return;
    setSavingNode(true);
    setError(null);
    try {
      await deleteGraphNodes(selectedNodeIds);
      setNodes((prev) => prev.filter((n) => !selectedNodeIds.includes(n.id)));
      setEdges((prev) =>
        prev.filter(
          (e) => !selectedNodeIds.includes(e.source) && !selectedNodeIds.includes(e.target),
        ),
      );
      setSelectedNodeIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '선택 노드 삭제 실패');
    } finally {
      setSavingNode(false);
    }
  }, [selectedNodeIds, setEdges, setNodes]);

  const handleMergeSelected = useCallback(async () => {
    if (selectedNodes.length < 2) return;
    setSavingNode(true);
    setError(null);
    try {
      const mergedContent = selectedNodes.map((n) => `• ${n.content}`).join('\n');
      const mergedLabels = Array.from(
        new Set(selectedNodes.flatMap((n) => n.labels || []).filter((l) => !!l)),
      );
      const defaultLabel = nodeDraft.label || mergedLabels[0] || '병합 노드';
      const created = await createGraphNode({
        label: defaultLabel,
        labels: mergedLabels.length ? mergedLabels : [defaultLabel],
        content: mergedContent,
        idea_text: mergedContent,
        source_conversation_id: convoId,
      });
      await deleteGraphNodes(selectedNodeIds);
      setNodes((prev) => [
        ...prev.filter((n) => !selectedNodeIds.includes(n.id)),
        { ...created, labels: created.labels?.length ? created.labels : [defaultLabel] },
      ]);
      setEdges((prev) =>
        prev.filter(
          (e) => !selectedNodeIds.includes(e.source) && !selectedNodeIds.includes(e.target),
        ),
      );
      setSelectedNodeIds([created.id]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '병합에 실패했습니다');
    } finally {
      setSavingNode(false);
    }
  }, [convoId, nodeDraft.label, selectedNodeIds, selectedNodes, setEdges, setNodes]);

  const handleResetDraft = useCallback(() => {
    setSelectedNodeIds([]);
    setNodeDraft({ label: '', content: '', labelsText: '' });
  }, []);

  const handleSaveEdgeLabel = useCallback(async () => {
    if (!selectedEdge) return;
    setSavingEdge(true);
    setError(null);
    try {
      const labels = parseLabels(edgeLabelDraft || selectedEdge.label || '관련');
      const updated = await updateGraphEdge({
        source: selectedEdge.source,
        target: selectedEdge.target,
        labels,
      });
      setEdges((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
    } catch (err) {
      setError(err instanceof Error ? err.message : '관계 라벨 저장 실패');
    } finally {
      setSavingEdge(false);
    }
  }, [edgeLabelDraft, parseLabels, selectedEdge, setEdges]);

  const handleDeleteSelectedEdge = useCallback(async () => {
    if (!selectedEdge) return;
    setSavingEdge(true);
    setError(null);
    try {
      await deleteGraphEdge(selectedEdge.source, selectedEdge.target);
      setEdges((prev) => prev.filter((e) => e.id !== selectedEdge.id));
      setSelectedEdge(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '관계 삭제 실패');
    } finally {
      setSavingEdge(false);
    }
  }, [selectedEdge, setEdges]);

  // 추천 노드에 바로 엣지 연결
  const handleConnectReco = useCallback(
    async (targetId: string) => {
      if (!selectedNodeIds.length) {
        setRecoNotice({ type: 'error', text: '먼저 기준이 될 노드를 선택하세요.' });
        return;
      }
      const sourceId = selectedNodeIds[0];
      const label = edgeLabelInput.trim();
      if (!label) {
        setRecoNotice({
          type: 'error',
          text: `관계 라벨을 선택하거나 입력하세요. 추천: ${
            edgeLabelSuggestions.slice(0, 6).join(', ') || '없음'
          }`,
        });
        return;
      }

      setConnectingRecoId(targetId);
      setRecoNotice(null);
      try {
        const newEdge = await createGraphEdge({
          source: sourceId,
          target: targetId,
          label,
        });
        setEdges((prev) => {
          const map = new Map<string, any>();
          prev.forEach((e: any) => map.set(e.id, e));
          const normalized = normalizeEdge(newEdge);
          map.set(normalized.id, normalized as any);
          return Array.from(map.values()) as any;
        });
        setGraphVersion((v) => v + 1);
        await loadGraph(); // 서버 상태 동기화
        // 연결된 추천은 목록에서 제거
        setRecoIds((prev) => prev.filter((id) => id !== targetId));
        setRecoNotice({ type: 'success', text: '연결되었습니다.' });
      } catch (err) {
        setRecoNotice({
          type: 'error',
          text: err instanceof Error ? err.message : '추천 노드 연결에 실패했습니다.',
        });
      } finally {
        setConnectingRecoId(null);
      }
    },
    [edgeLabelInput, edgeLabelSuggestions, selectedNodeIds, setEdges, setRecoIds],
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
    <div className="flex h-full w-full flex-col gap-3 p-3">
      {/* ?? */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-text-primary">
          {localize('com_sidepanel_knowledge_graph') || 'Knowledge Graph'}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={toggleScope} disabled={loading}>
            {showAll ? '대화 그래프 보기' : '전체 그래프 보기'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={repositionGraph}
            disabled={positioning || loading}
          >
            {positioning ? '좌표 계산 중...' : 'UMAP 좌표 갱신'}
          </Button>
          <Button size="sm" variant="outline" onClick={clearAll} disabled={clearing || loading}>
            {clearing ? localize('com_ui_clearing') || 'Clearing...' : 'Clear'}
          </Button>
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      {/* ??? ??? */}
      <div className="relative h-[55vh] min-h-[280px] overflow-hidden rounded-md border border-border-light bg-background">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-text-secondary">
            {localize('com_ui_loading') || 'Loading...'}
          </div>
        ) : (
          <ReactFlow
            key={`kg-${graphVersion}`}
            nodes={displayNodes}
            edges={displayEdges}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            fitView
          >
            <Background />
          </ReactFlow>
        )}
      </div>

      {/* 추가 모드 안내 */}
      <div className="rounded-md border border-border-light bg-surface-secondary p-3">
        <div className="mb-2 text-sm font-semibold text-text-primary">추가 모드</div>
        <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
          <span className="rounded border border-border-light bg-background px-2 py-1">
            Pre-mortem 모드
          </span>
          <span className="rounded border border-border-light bg-background px-2 py-1">
            악마의 대변인 모드
          </span>
          <span className="rounded border border-border-light bg-background px-2 py-1">
            가상 페르소나 모드
          </span>
        </div>
      </div>

      {/* 라벨 입력 모달 (수동 연결용) */}
      {labelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 max-w-[90vw] rounded-md border border-border-light bg-surface-secondary p-4 shadow-lg">
            <div className="mb-2 text-sm font-semibold text-text-primary">관계 라벨 입력</div>
            <input
              className="mb-2 w-full rounded border border-border-light bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="예: 원인-결과"
              value={labelModalValue}
              onChange={(e) => setLabelModalValue(e.target.value)}
            />
            <div className="mb-3 flex flex-wrap gap-1">
              {edgeLabelSuggestions.slice(0, 6).map((label) => (
                <button
                  key={label}
                  type="button"
                  className="rounded border border-border-light bg-background px-2 py-1 text-[10px] text-text-secondary hover:border-accent"
                  onClick={() => setLabelModalValue(label)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setLabelModalOpen(false)}>
                취소
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const conn = pendingConnection;
                  const labelText = labelModalValue.trim();
                  if (!conn || !conn.source || !conn.target) {
                    setLabelModalOpen(false);
                    return;
                  }
                  if (!labelText) {
                    setRecoNotice({ type: 'error', text: '관계 라벨을 입력하세요.' });
                    return;
                  }
                  try {
                    const labels = parseLabels(labelText);
                    const label = labels.length > 1 ? labels : labels[0] || undefined;
                    const newEdge = await createGraphEdge({
                      source: conn.source,
                      target: conn.target,
                      label,
                    });
                    setEdges((prev) => [...prev, normalizeEdge(newEdge)]);
                    setGraphVersion((v) => v + 1);
                    await loadGraph();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to create edge');
                  } finally {
                    setPendingConnection(null);
                    setLabelModalOpen(false);
                  }
                }}
              >
                연결
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 노드/추천 영역 */}
      <div className="grid gap-3 md:grid-cols-[1.1fr_1fr]">
        {/* 노드 편집 / 신규 작성 */}
        <div className="rounded-md border border-border-light bg-surface-secondary p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-text-primary">
              {selectedNodeIds.length ? `선택된 노드 ${selectedNodeIds.length}개` : '새 노드 추가'}
            </div>
            <Button size="sm" variant="ghost" onClick={handleResetDraft}>
              초기화
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <input
              className="w-full rounded border border-border-light bg-background p-2 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="노드 제목"
              value={nodeDraft.label}
              onChange={(e) => setNodeDraft((prev) => ({ ...prev, label: e.target.value }))}
            />
            {/* <input
              className="w-full rounded border border-border-light bg-background p-2 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="라벨/태그 (콤마로 구분)"
              value={nodeDraft.labelsText}
              onChange={(e) => setNodeDraft((prev) => ({ ...prev, labelsText: e.target.value }))}
            /> */}
            <textarea
              className="min-h-[120px] w-full rounded border border-border-light bg-background p-2 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="내용을 입력하세요."
              value={nodeDraft.content}
              onChange={(e) => setNodeDraft((prev) => ({ ...prev, content: e.target.value }))}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={handleSaveNode} disabled={savingNode}>
                {savingNode ? '저장 중...' : '노드 저장'}
              </Button>
              <Button size="sm" variant="outline" onClick={handleResetDraft} disabled={savingNode}>
                취소
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleOpenConversation}
                disabled={!selectedNodes.length}
              >
                대화창 가기
              </Button>
            </div>
            {!!connectedEdges.length && (
              <div className="mt-3 rounded border border-border-light bg-background p-2 text-xs text-text-primary">
                <div className="mb-1 text-[11px] font-semibold text-text-secondary">
                  연결된 노드
                </div>
                <div className="flex flex-col gap-1">
                  {connectedEdges.map(({ edge, other, direction }) => {
                    const labelText = Array.isArray(edge.labels)
                      ? edge.labels.join(', ')
                      : edge.labels || edge.label || '';
                    const arrow = direction === 'out' ? '→' : '←';
                    return (
                      <div
                        key={edge.id}
                        className="flex items-center justify-between gap-2 rounded border border-border-light px-2 py-1"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[11px] font-medium text-text-primary">
                            {other?.labels?.[0] ||
                              other?.content?.slice(0, 40) ||
                              other?.id ||
                              '노드'}
                          </span>
                          <span className="text-[10px] text-text-tertiary">
                            {arrow} {labelText || '연결'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 추천 노드 / 빠른 연결 */}
        <div className="rounded-md border border-border-light bg-surface-secondary p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-semibold text-text-primary">추천 노드 / 빠른 연결</div>
          </div>
          <div className="mb-2 text-[11px] text-text-secondary">
            {selectedNodes[0]
              ? `선택 노드: ${
                  selectedNodes[0].labels?.[0] ||
                  selectedNodes[0].content?.slice(0, 40) ||
                  selectedNodes[0].id
                }`
              : '추천을 받으려면 노드를 선택하세요.'}
            {recoLoading
              ? ' · 추천 실행 중...'
              : recoRequested
              ? ` · 최근 결과 ${recoIds.length}개`
              : ''}
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
            <label className="text-text-secondary">추천 방식</label>
            <select
              className="rounded border border-border-light bg-background px-2 py-1"
              value={recoMethod}
              onChange={(e) =>
                setRecoMethod(e.target.value as 'synonyms' | 'edge_analogy' | 'least_similar')
              }
            >
              <option value="synonyms">임베딩 유사도</option>
              <option value="edge_analogy">관계 유추</option>
              <option value="least_similar">가장 덜 유사(그래프 기반)</option>
            </select>
            <span className="text-text-secondary">관계 라벨</span>
            <input
              className="rounded border border-border-light bg-background px-2 py-1 text-text-primary outline-none focus:border-accent"
              placeholder="예: 원인-결과"
              value={edgeLabelInput}
              onChange={(e) => setEdgeLabelInput(e.target.value)}
            />
            {recoMethod === 'edge_analogy' && (
              <span className="text-[10px] text-text-tertiary">
                관계 유추는 기준 라벨을 넣어야 합니다.
              </span>
            )}
            <div className="flex flex-wrap gap-1">
              {edgeLabelSuggestions.slice(0, 6).map((label) => (
                <button
                  key={label}
                  type="button"
                  className="rounded border border-border-light bg-background px-2 py-1 text-[10px] text-text-secondary hover:border-accent"
                  onClick={() => setEdgeLabelInput(label)}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRecommendations}
              disabled={
                recoLoading ||
                loading ||
                !selectedNodeIds.length ||
                (recoMethod === 'edge_analogy' && !edgeLabelInput.trim())
              }
            >
              {recoLoading ? '추천 불러오는 중...' : '연결 추천'}
            </Button>
          </div>

          {recoNotice && (
            <div
              className={`mb-2 text-[11px] ${
                recoNotice.type === 'error'
                  ? 'text-red-500'
                  : recoNotice.type === 'success'
                  ? 'text-green-500'
                  : 'text-text-secondary'
              }`}
            >
              {recoNotice.text}
            </div>
          )}

          <div className="rounded border border-dashed border-border-light bg-background px-2 py-2 text-xs text-text-primary">
            {recoItems.length ? (
              <div className="flex flex-wrap gap-2">
                {recoItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex w-48 flex-col gap-1 rounded-md border border-border-light bg-surface-secondary px-2 py-2"
                  >
                    <div className="text-[11px] font-semibold text-text-primary">{item.label}</div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!!connectingRecoId}
                      onClick={() => handleConnectReco(item.id)}
                    >
                      {connectingRecoId === item.id ? '연결 중...' : '연결 추가'}
                    </Button>
                  </div>
                ))}
              </div>
            ) : recoRequested ? (
              <div className="text-text-secondary">추천 결과가 없습니다.</div>
            ) : (
              <div className="text-text-secondary">추천을 실행하면 여기에 표시됩니다.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
