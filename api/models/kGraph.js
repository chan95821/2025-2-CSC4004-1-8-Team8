/**
 * [MERGED FILE]
 * kGraph.js와 Kgraph.js의 기능을 병합한 파일입니다.
 *
 * 기준: kGraph.js (API 엔드포인트와 일치하는 함수 구조)
 * 통합된 기능:
 * 1. Kgraph.js의 Python 임베딩 서비스 연동 (axios, EMBED_URL)
 * 2. models/schema/kgraphSchema.js 스키마 호환성 (content 필드, label: [String] 등)
 */

const mongoose = require('mongoose');
const axios = require('axios');
// kgraphSchema.js (정식 스키마)를 사용합니다.
const kgraphSchema = require('./schema/kgraphSchema');
const { Message } = require('./Message'); // 2.3 API (가져오기)에 필요
const logger = require('~/config/winston');

// Python 서비스 기본 URL
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || 'http://localhost:8000';

// Python 임베딩 서비스 URL
const EMBED_URL = `${PYTHON_SERVER_URL}/embed`;

// Python UMAP 서비스 URL
const PYTHON_UMAP_URL = `${PYTHON_SERVER_URL}/calculate-umap`;

// Python 추천 서비스 URL
const PYTHON_RECOMMENDATION_URL = `${PYTHON_SERVER_URL}/recommendation`;

// 스키마를 'KGraph'라는 이름의 모델로 등록합니다.
const KGraph = mongoose.model('KGraph', kgraphSchema);

/**
 * 사용자의 지식 그래프 문서를 찾거나, 없으면 새로 생성합니다.
 * kgraphSchema는 사용자 ID당 하나의 문서를 갖습니다.
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Document>} Mongoose KGraph Document
 */
const getOrCreateGraphDoc = async (userId) => {
  if (!userId) {
    logger.error('[KGraph] getOrCreateGraphDoc: userId가 제공되지 않았습니다.');
    throw new Error('User ID is required');
  }

  // [수정됨] KGraph.findOne({ userId }) 사용 (KGraph.js의 findById(userId)는 스키마와 맞지 않음)
  let graph = await KGraph.findOne({ userId });

  if (!graph) {
    logger.info(`[KGraph] 새 그래프 생성 (userId: ${userId})`);
    // [수정됨] new KGraph()로 새 문서를 생성합니다.
    graph = new KGraph({ userId, nodes: [], edges: [] });
    await graph.save();
  }

  return graph;
};

/**
 * (API 4.1) GET /graph
 * 사용자의 전체 지식 그래프 (노드 및 엣지)를 조회합니다.
 * @param {string} userId - 사용자 ID
 * @returns {Promise<{nodes: Array, edges: Array}>}
 */
const getGraph = async (userId) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);

    // Mongoose Sub-document의 _id를 id로 변환하여 프론트엔드에 전달
    const nodes = graph.nodes.map((n) => ({ ...n.toObject(), id: n._id.toString() }));
    const edges = graph.edges.map((e) => ({ ...e.toObject(), id: e._id.toString() }));

    return { nodes, edges };
  } catch (error) {
    logger.error(`[KGraph] Error in getGraph (userId: ${userId})`, error);
    throw new Error('지식 그래프 조회에 실패했습니다.');
  }
};

/**
 * [MERGED] (API 2.1) POST /nodes
 * 단일 노드를 생성합니다. (임베딩 서비스 호출 포함)
 * @param {string} userId - 사용자 ID
 * @param {object} nodeData - { label, x, y, content, source_message_id, source_conversation_id }
 * @returns {Promise<object>} 생성된 노드 객체 (id 포함)
 */
const createNode = async (
  userId,
  { label, x, y, content, source_message_id, source_conversation_id },
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const graph = await getOrCreateGraphDoc(userId);

    // normalize label to an array without using nested ternary
    let labelArr = [];
    if (Array.isArray(label)) {
      labelArr = label;
    } else if (label) {
      labelArr = [label];
    }

    const newNode = {
      // kgraphSchema.js 스키마에 맞게 수정
      content: content || '', // 'idea_text' -> 'content'
      label: labelArr, // 'label'을 배열로 처리
      x: x || 0,
      y: y || 0,
      source_message_id: source_message_id || null,
      source_conversation_id: source_conversation_id || null,
      // vector_ref 필드 제거 (임베딩 서비스가 관리)
    };

    graph.nodes.push(newNode); // 배열에 새 노드 추가
    await graph.save({ session });

    const createdNode = graph.nodes[graph.nodes.length - 1];
    const nodeForFrontend = { ...createdNode.toObject(), id: createdNode._id.toString() };

    // 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    try {
      const nodePayload = {
        id: nodeForFrontend.id,
        content: nodeForFrontend.content,
      };

      await axios.post(
        EMBED_URL,
        { user_id: userId, nodes: [nodePayload] },
        { timeout: 15000 },
      );
      logger.info(
        `[KGraph] Embed call success for new node (userId: ${userId}, nodeId: ${nodeForFrontend.id})`,
      );
    } catch (embedErr) {
      logger.error(
        `[KGraph] Embed call failed for createNode (nodeId: ${nodeForFrontend.id}):`,
        embedErr?.message || embedErr,
      );
      // 임베딩 실패 시 롤백
      throw new Error('임베딩 생성에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for createNode (userId: ${userId})`);

    return nodeForFrontend;
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for createNode (userId: ${userId})`, error);
    throw new Error(`노드 생성에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * [MERGED] (API 2.2) PATCH /nodes/{nodeId}
 * 단일 노드의 정보를 (부분) 수정합니다. (필요시 임베딩 서비스 호출 포함)
 * @param {string} userId - 사용자 ID
 * @param {string} nodeId - 수정할 노드의 _id
 * @param {object} updateData - { label, x, y, content, ... } (모두 선택적)
 * @returns {Promise<object>} 수정된 노드 객체
 */
const updateNode = async (
  userId,
  nodeId,
  { label, x, y, content, source_message_id, source_conversation_id },
) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const graph = await getOrCreateGraphDoc(userId);
    const node = graph.nodes.id(nodeId); // Sub-document ID로 찾기

    if (!node) {
      throw new Error('수정할 노드를 찾을 수 없습니다.');
    }

    let contentChanged = false;

    // 제공된 필드만 업데이트
    if (label !== undefined) {
      // kgraphSchema.js 스키마에 맞게 수정
      node.label = Array.isArray(label) ? label : [label];
    }
    if (x !== undefined) {
      node.x = x;
    }
    if (y !== undefined) {
      node.y = y;
    }
    // 'idea_text' -> 'content'
    if (content !== undefined) {
      node.content = content;
      contentChanged = true;
    }
    // vector_ref 필드 제거
    if (source_message_id !== undefined) {
      node.source_message_id = source_message_id;
    }
    if (source_conversation_id !== undefined) {
      node.source_conversation_id = source_conversation_id;
    }

    await graph.save({ session });

    const updatedNode = { ...node.toObject(), id: node._id.toString() };

    // content가 변경된 경우 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    if (contentChanged) {
      try {
        const nodePayload = {
          id: updatedNode.id,
          content: updatedNode.content,
        };

        await axios.post(
          EMBED_URL,
          { user_id: userId, nodes: [nodePayload] },
          { timeout: 15000 },
        );
        logger.info(
          `[KGraph] Embed call success for updated node (userId: ${userId}, nodeId: ${updatedNode.id})`,
        );
      } catch (embedErr) {
        logger.error(
          `[KGraph] Embed call failed for updateNode (nodeId: ${updatedNode.id}):`,
          embedErr?.message || embedErr,
        );
        // 임베딩 실패 시 롤백
        throw new Error('임베딩 업데이트에 실패했습니다.');
      }
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for updateNode (userId: ${userId})`);

    return updatedNode;
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for updateNode (userId: ${userId}, nodeId: ${nodeId})`, error);
    throw new Error(`노드 수정에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * [MERGED] (API 2.3) POST /nodes/batch
 * 특정 메시지의 임시 노드들을 지식 그래프로 일괄 가져오기. (임베딩 서비스 호출 포함)
 * @param {string} userId - 사용자 ID
 * @param {string} messageId - 임시 노드를 포함한 메시지 ID
 * @returns {Promise<Array>} 추가된 노드 객체의 배열
 */
const importNodes = async (userId, { messageId }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const message = await Message.findOne({ messageId, user: userId }).session(session);

    if (!message) {
      throw new Error('임시 노드를 가져올 메시지를 찾을 수 없습니다.');
    }
    if (message.isImported) {
      throw new Error('이미 가져오기가 완료된 메시지입니다.');
    }
    if (!message.nodes || message.nodes.length === 0) {
      throw new Error('가져올 임시 노드가 없습니다.');
    }

    const graph = await getOrCreateGraphDoc(userId);

    // [MERGED] kgraphSchema.js 스키마에 맞게 수정
    // content는 필수 필드이므로, 임시 노드의 label을 content로 사용
    const newNodes = message.nodes.map((tn) => ({
      content: tn.label || '새 노드', // 'content' 필드 추가
      label: tn.label ? [tn.label] : [], // 'label'을 배열로
      x: tn.x || 0,
      y: tn.y || 0,
    }));

    graph.nodes.push(...newNodes);
    message.isImported = true; // 가져오기 완료 플래그 설정

    // 두 문서(그래프, 메시지)를 동시에 저장
    await Promise.all([graph.save({ session }), message.save({ session })]);

    // 방금 추가된 노드들을 반환 (ID 포함)
    const addedNodes = graph.nodes.slice(-newNodes.length);
    const addedNodesForFrontend = addedNodes.map((n) => ({
      ...n.toObject(),
      id: n._id.toString(),
    }));

    // 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    try {
      const nodesPayload = addedNodesForFrontend.map((n) => ({
        id: n.id,
        content: n.content,
      }));

      await axios.post(EMBED_URL, { user_id: userId, nodes: nodesPayload }, { timeout: 15000 });
      logger.info(
        `[KGraph] Embed call success for imported nodes (userId: ${userId}, count: ${nodesPayload.length})`,
      );
    } catch (embedErr) {
      logger.error(
        `[KGraph] Embed call failed for importNodes (msgId: ${messageId}):`,
        embedErr?.message || embedErr,
      );
      // 임베딩 실패 시 롤백
      throw new Error('임베딩 생성에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for importNodes (userId: ${userId})`);

    return addedNodesForFrontend;
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for importNodes (userId: ${userId}, msgId: ${messageId})`, error);
    throw new Error(`노드 가져오기 실패: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * [MERGED] (API 2.4) POST /nodes/delete
 * 여러 노드를 일괄 삭제합니다. (Kgraph.js의 아토믹 연산 및 임베딩 삭제 로직 사용)
 * @param {string} userId - 사용자 ID
 * @param {Array<string>} nodeIds - 삭제할 노드 ID 배열
 * @returns {Promise<object>} 삭제 결과
 */
const deleteNodes = async (userId, { nodeIds }) => {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw new Error('삭제할 노드 ID 배열이 필요합니다.');
  }

  const ObjectId = mongoose.Types.ObjectId;

  const convertedIds = nodeIds.map((id) => {
    try {
      return ObjectId(id);
    } catch (e) {
      return String(id);
    }
  });

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. 노드들을 제거
    const updated = await KGraph.findOneAndUpdate(
      { userId: userId },
      { $pull: { nodes: { _id: { $in: convertedIds } } } },
      { new: true, session },
    ).exec();

    if (!updated) {
      logger.warn(
        `[KGraph] deleteNodes: User graph not found or no nodes deleted (userId: ${userId})`,
      );
    }

    // 2. 이 노드들과 연결된 모든 엣지를 제거
    const idStrings = convertedIds.map((i) => String(i));
    await KGraph.updateOne(
      { userId: userId },
      {
        $pull: {
          edges: { $or: [{ source: { $in: idStrings } }, { target: { $in: idStrings } }] },
        },
      },
      { session },
    ).exec();

    // 3. 임베딩 서비스에서 벡터 삭제 (transaction 내에서 동기적으로 처리)
    try {
      const url = EMBED_URL.endsWith('/delete') ? EMBED_URL : `${EMBED_URL}/delete`;
      await axios.post(url, { user_id: userId, ids: idStrings }, { timeout: 15000 });
      logger.info(
        `[KGraph] Embed delete call success (userId: ${userId}, count: ${idStrings.length})`,
      );
    } catch (embedErr) {
      logger.error(`[KGraph] Embed delete call failed (userId: ${userId}):`, {
        status: embedErr?.response?.status,
        data: embedErr?.response?.data,
        message: embedErr?.message,
      });
      // 임베딩 삭제 실패 시 롤백
      throw new Error('임베딩 삭제에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for deleteNodes (userId: ${userId})`);

    return { deletedNodes: nodeIds.length };
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for deleteNodes (userId: ${userId})`, error);
    throw new Error(`노드 삭제에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * (API 3.1) POST /edges
 * 엣지를 생성합니다. (라벨은 배열)
 * MongoDB와 Python 임베드 서비스를 트랜잭션으로 처리합니다.
 * @param {string} userId - 사용자 ID
 * @param {object} edgeData - { source, target, label }
 * @returns {Promise<object>} 생성/업데이트된 엣지 객체
 */
const createEdge = async (userId, { source, target, label }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const graph = await getOrCreateGraphDoc(userId);

    // 엣지는 source와 target 쌍으로 고유함
    let edge = graph.edges.find((e) => e.source === source && e.target === target);
    let isNewEdge = false;

    if (edge) {
      // 엣지가 이미 존재하면, 새 라벨을 (중복이 아닐 경우) 추가
      if (label && !edge.label.includes(label)) {
        edge.label.push(label);
      }
    } else {
      // 엣지가 없으면 새로 생성
      const newEdge = {
        source,
        target,
        label: label ? [label] : [], // kgraphSchema.js 스키마와 호환
      };
      graph.edges.push(newEdge);
      edge = graph.edges[graph.edges.length - 1];
      isNewEdge = true;
    }

    await graph.save({ session });

    const edgeForResponse = { ...edge.toObject(), id: edge._id.toString() };

    // Python 임베드 서비스에 엣지 생성/업데이트 요청 (transaction 내에서 동기적으로 처리)
    try {
      const edgePayload = {
        id: edgeForResponse.id,
        source_id: source,
        target_id: target,
        label: label || '',
      };

      const url = `${EMBED_URL}/edge`;
      await axios.post(url, { user_id: userId, edges: [edgePayload] }, { timeout: 15000 });
      logger.info(
        `[KGraph] Embed call success for ${isNewEdge ? 'new' : 'updated'} edge (userId: ${userId}, edgeId: ${edgeForResponse.id})`,
      );
    } catch (embedErr) {
      logger.error(
        `[KGraph] Embed call failed for createEdge (edgeId: ${edgeForResponse.id}):`,
        embedErr?.message || embedErr,
      );
      // 임베딩 실패 시 롤백
      throw new Error('임베딩 생성에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for createEdge (userId: ${userId})`);

    return edgeForResponse;
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for createEdge (userId: ${userId})`, error);
    throw new Error(`엣지 생성에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * (API 3.2) PATCH /edges
 * 엣지의 라벨 배열 전체를 수정(교체)합니다.
 * MongoDB와 Python 임베드 서비스를 트랜잭션으로 처리합니다.
 * @param {string} userId - 사용자 ID
 * @param {object} edgeData - { source, target, label } (label은 배열이어야 함)
 * @returns {Promise<object>} 수정된 엣지 객체
 */
const updateEdge = async (userId, { source, target, label }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const graph = await getOrCreateGraphDoc(userId);
    const edge = graph.edges.find((e) => e.source === source && e.target === target);

    if (!edge) {
      throw new Error('수정할 엣지를 찾을 수 없습니다.');
    }

    // API 명세에 따라, 라벨 배열을 '교체'합니다.
    if (Array.isArray(label)) {
      edge.label = label;
    } else if (typeof label === 'string') {
      edge.label = [label]; // 단일 문자열도 배열로 감싸서 저장
    } else {
      edge.label = []; // 기본값
    }

    await graph.save({ session });
    const edgeForResponse = { ...edge.toObject(), id: edge._id.toString() };

    // Python 임베드 서비스에 엣지 업데이트 요청 (transaction 내에서 동기적으로 처리)
    try {
      const edgePayload = {
        id: edgeForResponse.id,
        source_id: source,
        target_id: target,
        label: (Array.isArray(label) ? label[0] : label) || '',
      };

      const url = `${EMBED_URL}/edge`;
      await axios.post(url, { user_id: userId, edges: [edgePayload] }, { timeout: 15000 });
      logger.info(
        `[KGraph] Embed call success for updated edge (userId: ${userId}, edgeId: ${edgeForResponse.id})`,
      );
    } catch (embedErr) {
      logger.error(
        `[KGraph] Embed call failed for updateEdge (edgeId: ${edgeForResponse.id}):`,
        embedErr?.message || embedErr,
      );
      // 임베딩 실패 시 롤백
      throw new Error('임베딩 업데이트에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for updateEdge (userId: ${userId})`);

    return edgeForResponse;
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for updateEdge (userId: ${userId})`, error);
    throw new Error(`엣지 수정에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

/**
 * (API 3.3) DELETE /edges
 * 엣지를 삭제합니다. (source, target 기준)
 * MongoDB와 Python 임베드 서비스를 트랜잭션으로 처리합니다.
 * @param {string} userId - 사용자 ID
 * @param {object} edgeData - { source, target }
 * @returns {Promise<object>} 삭제 결과
 */
const deleteEdge = async (userId, { source, target }) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const graph = await getOrCreateGraphDoc(userId);
    const edge = graph.edges.find((e) => e.source === source && e.target === target);

    if (!edge) {
      throw new Error('삭제할 엣지를 찾을 수 없습니다.');
    }

    const edgeId = edge._id.toString();

    graph.edges.pull({ _id: edge._id }); // Sub-document 배열에서 제거
    await graph.save({ session });

    // Python 임베드 서비스에서 엣지 삭제 요청 (transaction 내에서 동기적으로 처리)
    try {
      const url = EMBED_URL.endsWith('/delete') ? EMBED_URL : `${EMBED_URL}/delete`;
      await axios.post(url, { user_id: userId, ids: [edgeId] }, { timeout: 15000 });
      logger.info(
        `[KGraph] Embed delete call success for edge (userId: ${userId}, edgeId: ${edgeId})`,
      );
    } catch (embedErr) {
      logger.error(`[KGraph] Embed delete call failed for deleteEdge (edgeId: ${edgeId}):`, {
        status: embedErr?.response?.status,
        data: embedErr?.response?.data,
        message: embedErr?.message,
      });
      // 임베딩 삭제 실패 시 롤백
      throw new Error('임베딩 삭제에 실패했습니다.');
    }

    // 모든 작업 성공 시 commit
    await session.commitTransaction();
    logger.info(`[KGraph] Transaction committed for deleteEdge (userId: ${userId})`);

    return { deletedCount: 1 };
  } catch (error) {
    await session.abortTransaction();
    logger.error(`[KGraph] Transaction aborted for deleteEdge (userId: ${userId})`, error);
    throw new Error(`엣지 삭제에 실패했습니다: ${error.message}`);
  } finally {
    session.endSession();
  }
};

// 4.3 연결 추천 로직
/**
 * (API 4.3) GET /recommendations
 * 노드 연결 추천
 * Python 추천 서비스에 요청하여 추천 노드 목록을 반환
 * @param {string} userId - 사용자 ID
 * @param {string} nodeId - 추천 대상 노드 ID
 * @param {string} method - 추천 방법 ('least_similar' | 'synonyms')
 *                          - 'least_similar': 그래프 기반 추천 (가장 유사하지 않은 노드)
 *                          - 'synonyms': 임베딩 기반 추천 (동의어/유사 노드)
 * @param {number} top_k - 반환할 추천 노드 개수 (기본값: 10)
 * @returns {Promise<Array>} 추천 노드 목록 [{ id, score }, ...]
 */
const getRecommendations = async (userId, nodeId, method, top_k = 10) => {
  try {
    if (!userId || !nodeId) {
      throw new Error('User ID and Node ID are required');
    }

    // 유효한 method 값 검증
    const validMethods = ['least_similar', 'synonyms'];
    if (!validMethods.includes(method)) {
      throw new Error(
        `Invalid method: ${method}. Valid methods are: ${validMethods.join(', ')}`,
      );
    }

    logger.info(
      `[KGraph] getRecommendations (userId: ${userId}, nodeId: ${nodeId}, method: ${method})`,
    );

    // Python 추천 서비스에 요청
    const response = await axios.post(
      `${PYTHON_RECOMMENDATION_URL}?method=${method}&top_k=${top_k}`,
      {
        user_id: userId,
        node_id: nodeId,
      },
      { timeout: 15000 },
    );

    // Python 서비스에서 반환된 추천 데이터
    // { method, recommendations: [{ id, score }, ...] }
    const recommendationResult = response.data;
    const recommendations = recommendationResult.recommendations || [];

    logger.info(
      `[KGraph] Recommendations retrieved (userId: ${userId}, nodeId: ${nodeId}, count: ${recommendations.length})`,
    );

    return recommendations;
  } catch (error) {
    logger.error(
      `[KGraph] Error in getRecommendations (userId: ${userId}, nodeId: ${nodeId})`,
      error,
    );
    throw new Error(`추천 노드 조회에 실패했습니다: ${error.message}`);
  }
};

/**
 * (API 4.2) POST /cluster
 * UMAP 군집 시각화 요청
 * Python UMAP 서비스에 요청하여 노드 벡터 기반 좌표 계산 및 MongoDB 업데이트
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Array>} 업데이트된 노드 ID와 좌표 목록 [{ id, x, y }, ...]
 */
const calculateCluster = async (userId) => {
  try {
    if (!userId) {
      throw new Error('User ID is required');
    }

    logger.info(`[KGraph] calculateCluster (userId: ${userId})`);

    // Python UMAP 서비스에 요청
    const response = await axios.post(PYTHON_UMAP_URL, {
      user_id: userId,
    });

    // Python 서비스에서 반환된 좌표 데이터
    // [{ id, x, y }, { id, x, y }, ...]
    const umapData = response.data;

    // MongoDB의 노드 좌표 업데이트
    const graph = await getOrCreateGraphDoc(userId);

    // umapData의 각 항목에 대해 해당 노드의 좌표 업데이트
    for (const item of umapData) {
      const node = graph.nodes.id(item.id);
      if (node) {
        node.x = item.x;
        node.y = item.y;
      } else {
        logger.warn(
          `[KGraph] Node not found in MongoDB (userId: ${userId}, nodeId: ${item.id})`,
        );
      }
    }

    // 변경사항 저장
    await graph.save();
    logger.info(`[KGraph] MongoDB nodes updated successfully (userId: ${userId})`);

    logger.info(`[KGraph] UMAP calculation completed (userId: ${userId})`);

    return umapData;
  } catch (error) {
    logger.error(`[KGraph] Error in calculateCluster (userId: ${userId})`, error);
    throw new Error(`UMAP 군집 계산에 실패했습니다: ${error.message}`);
  }
};

// 4.4 UMAP 재계산 로직 (여기에 함수 구현)
const updateUmap = async (userId) => {
  // (로직 구현...)
  logger.info(`[KGraph] updateUmap (userId: ${userId})`);
  // TODO: Python UMAP 서비스 (umap.py) 호출 로직 필요
  return { updated: 0 }; // 임시 반환
};

// 외부에서 함수들을 사용할 수 있도록 export
module.exports = {
  KGraph,
  getGraph,
  createNode,
  updateNode,
  importNodes,
  deleteNodes,
  createEdge,
  updateEdge,
  deleteEdge,
  getRecommendations,
  updateUmap,
  calculateCluster,
};
