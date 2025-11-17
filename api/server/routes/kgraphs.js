const express = require('express');
const router = express.Router();
const { requireJwtAuth } = require('../middleware'); // 사용자 인증용 미들웨어
const KGraph = require('../../models/kGraph'); // 1단계에서 만든 기능 모음 파일
const logger = require('~/config/winston'); // 로그 기록용

/**
 * (API 4.1) GET /api/kgraphs
 * 명세서와 일치하도록 경로를 /graph 에서 / 로 변경
 * 사용자의 전체 지식 그래프 조회
 */
router.get('/', requireJwtAuth, async (req, res) => {
  try {
    const graphData = await KGraph.getGraph(req.user.id);
    res.status(200).json(graphData);
  } catch (error) {
    logger.error(`[kgraph.js] / GET Error: ${error.message}`);
    res.status(500).json({ message: '그래프 조회에 실패했습니다.' });
  }
});

/**
 * (API 2.1) POST /api/kgraphs/nodes
 * 단일 노드 생성
 */
router.post('/nodes', requireJwtAuth, async (req, res) => {
  try {
    // 2단계에서 수정한 createNode가 req.body의 (idea_text, vector_ref)도 처리합니다.
    const node = await KGraph.createNode(req.user.id, req.body);
    res.status(201).json(node);
  } catch (error) {
    logger.error(`[kgraph.js] /nodes POST Error: ${error.message}`);
    res.status(500).json({ message: '노드 생성에 실패했습니다.' });
  }
});

/**
 * (API 2.2) PATCH /api/kgraphs/nodes/:nodeId
 * 단일 노드 정보 수정
 */
router.patch('/nodes/:nodeId', requireJwtAuth, async (req, res) => {
  try {
    const { nodeId } = req.params;
    // 2단계에서 수정한 updateNode가 req.body의 (idea_text, vector_ref)도 처리합니다.
    const updatedNode = await KGraph.updateNode(req.user.id, nodeId, req.body);
    res.status(200).json(updatedNode);
  } catch (error) {
    logger.error(`[kgraph.js] /nodes/:nodeId PATCH Error: ${error.message}`);
    res.status(404).json({ message: error.message });
  }
});

/**
 * (API 2.3) POST /api/kgraphs/nodes/batch
 * 메시지의 임시 노드 일괄 가져오기
 */
router.post('/nodes/batch', requireJwtAuth, async (req, res) => {
  try {
    // req.body에 { messageId }가 포함되어 있어야 함
    const newNodes = await KGraph.importNodes(req.user.id, req.body);
    res.status(201).json(newNodes);
  } catch (error) {
    logger.error(`[kgraph.js] /nodes/batch POST Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

/**
 * (API 2.4) POST /api/kgraphs/nodes/delete
 * 노드 일괄 삭제
 */
router.post('/nodes/delete', requireJwtAuth, async (req, res) => {
  try {
    // req.body에 { nodeIds: [...] }가 포함되어 있어야 함
    await KGraph.deleteNodes(req.user.id, req.body);

    res.sendStatus(204);
  } catch (error) {
    logger.error(`[kgraph.js] /nodes/delete POST Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

/**
 * (API 3.1) POST /api/kgraphs/edges
 * 엣지 생성 (또는 기존 엣지에 라벨 추가)
 */
router.post('/edges', requireJwtAuth, async (req, res) => {
  try {
    // req.body에 { source, target, label }이 포함되어 있어야 함
    const edge = await KGraph.createEdge(req.user.id, req.body);
    res.status(201).json(edge);
  } catch (error) {
    logger.error(`[kgraph.js] /edges POST Error: ${error.message}`);
    res.status(500).json({ message: '엣지 생성에 실패했습니다.' });
  }
});

/**
 * (API 3.2) PATCH /api/kgraphs/edges
 * 엣지 라벨 수정 (교체)
 */
router.patch('/edges', requireJwtAuth, async (req, res) => {
  try {
    // req.body에 { source, target, label: [...] }이 포함되어 있어야 함
    const edge = await KGraph.updateEdge(req.user.id, req.body);
    res.status(200).json(edge);
  } catch (error) {
    logger.error(`[kgraph.js] /edges PATCH Error: ${error.message}`);
    res.status(404).json({ message: error.message }); // 404: 엣지를 찾을 수 없음
  }
});

/**
 * (API 3.3) POST /api/kgraphs/edges/delete
 * 엣지 삭제 (source, target 기준)
 */
router.post('/edges/delete', requireJwtAuth, async (req, res) => {
  try {
    // req.body에 { source, target }이 포함되어 있어야 함
    await KGraph.deleteEdge(req.user.id, req.body);
    res.sendStatus(204); // 성공 (내용 없음)
  } catch (error) {
    logger.error(`[kgraph.js] /edges/delete POST Error: ${error.message}`);
    res.status(404).json({ message: error.message }); // 404: 엣지를 찾을 수 없음
  }
});

/**
 * (API 4.3) GET /api/kgraphs/recommendations
 * 노드 연결 추천
 */
router.get('/recommendations', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { nodeId } = req.query; // Postman Params 탭에서 ?nodeId=... 로 받음

    if (!nodeId) {
      return res.status(400).json({ message: 'nodeId 쿼리 파라미터가 필요합니다.' });
    }

    // 2단계에서 export한 getRecommendations 함수 호출
    const data = await KGraph.getRecommendations(userId, nodeId);
    res.status(200).json(data);
  } catch (error) {
    logger.error(`[kgraph.js] /recommendations GET Error: ${error.message}`);
    res.status(500).json({ message: '추천 목록 조회에 실패했습니다.' });
  }
});

/**
 * (API 4.4) POST /api/kgraphs/umap
 * UMAP 재계산 요청
 */
router.post('/umap', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    // 2단계에서 export한 updateUmap 함수 호출
    const data = await KGraph.updateUmap(userId);
    res.status(200).json(data);
  } catch (error) {
    logger.error(`[kgraph.js] /umap POST Error: ${error.message}`);
    res.status(500).json({ message: 'UMAP 재계산에 실패했습니다.' });
  }
});

/**
 * (API 4.2) POST /api/kgraphs/cluster
 * UMAP 군집 시각화 요청
 * Description: 사용자의 요청에 따라 백엔드에서 노드 벡터를 기반으로 UMAP 재계산을 수행하고,
 * 변경된 노드 좌표(x, y)를 반환합니다.
 */
router.post('/cluster', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    // calculateCluster 함수 호출: Python UMAP 서비스에 요청하여 좌표 계산
    const clusterData = await KGraph.calculateCluster(userId);
    // Success Response: 업데이트된 노드 ID와 좌표 목록 반환
    // [{ id: "node_id_1", x: 55.0, y: 10.0 }, ...]
    res.status(200).json(clusterData);
  } catch (error) {
    logger.error(`[kgraph.js] /cluster POST Error: ${error.message}`);
    res.status(500).json({ message: 'UMAP 군집 시각화 계산에 실패했습니다.' });
  }
});

module.exports = router;