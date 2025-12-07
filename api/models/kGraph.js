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
const { inspect } = require('util');
// kgraphSchema.js (정식 스키마)를 사용합니다.
const kgraphSchema = require('./schema/kgraphSchema');
const { Message } = require('./Message'); // 2.3 API (가져오기)에 필요
const logger = require('~/config/winston');

// Python 서비스 기본 URL
const PYTHON_SERVER_URL = process.env.PYTHON_SERVER_URL || 'http://localhost:8000';

// Python 임베딩 서비스 URL (노드 임베딩)
const EMBED_NODE_URL = `${PYTHON_SERVER_URL}/embed/node`;

// Python 임베딩 서비스 URL (엣지 임베딩)
const EMBED_EDGE_URL = `${PYTHON_SERVER_URL}/embed/edge`;

// Python UMAP 서비스 URL
const PYTHON_UMAP_URL = `${PYTHON_SERVER_URL}/calculate-umap`;

// Safely stringify objects for logging without crashing on circular references
const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    try {
      return inspect(value, { depth: 3, maxArrayLength: 20 });
    } catch (err2) {
      return '[unserializable]';
    }
  }
};

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
    logger.warn('[KGraph] Embed skipped for edge update.');
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
const getGraph = async (userId, conversationId = null) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);

    // conversationId가 있으면 해당 대화의 노드만 필터, 없으면 전체 노드
    const filteredNodes = conversationId
      ? graph.nodes.filter((n) => n.source_conversation_id === conversationId)
      : graph.nodes;

    // 노드 id 집합 (엣지 필터링에 사용)
    const nodeIdSet = new Set(filteredNodes.map((n) => n._id.toString()));

    const nodes = filteredNodes.map((n) => ({ ...n.toObject(), id: n._id.toString() }));
    const filteredEdges = conversationId
      ? graph.edges.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target))
      : graph.edges;
    const edges = filteredEdges.map((e) => ({ ...e.toObject(), id: e._id.toString() }));

    return { nodes, edges };
  } catch (error) {
    logger.error(`[KGraph] Error in getGraph (userId: ${userId})`, error);
    logger.warn('[KGraph] Embed skipped for edge update.');
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
  authHeader = null,
) => {
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
    await graph.save();

    const createdNode = graph.nodes[graph.nodes.length - 1];
    const nodeForFrontend = { ...createdNode.toObject(), id: createdNode._id.toString() };

    // 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    try {
      const nodePayload = {
        id: nodeForFrontend.id,
        content: nodeForFrontend.content,
      };
      logger.info(
        `[KGraph] Embed request start (userId: ${userId}, nodeId: ${
          nodeForFrontend.id
        }, url: ${EMBED_NODE_URL}) payload=${safeStringify({
          user_id: userId,
          nodes: [nodePayload],
        })}`,
      );

      await axios.post(
        EMBED_NODE_URL,
        { user_id: userId, nodes: [nodePayload] },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
      logger.info(
        `[KGraph] Embed call success for new node (userId: ${userId}, nodeId: ${nodeForFrontend.id})`,
      );
    } catch (embedErr) {
      const status = embedErr?.response?.status;
      const data = embedErr?.response?.data;
      const message = embedErr?.message || embedErr;
      const detail = `status=${status ?? 'n/a'} data=${safeStringify(data)} message=${message}`;
      logger.error(`[KGraph] Embed error object: ${safeStringify(embedErr)}`);
      logger.error(
        `[KGraph] Embed call failed for createNode (nodeId: ${nodeForFrontend.id}): ${detail}`,
        {
          status,
          data,
          message,
        },
      );
      // embed error once more (safe stringify)
      logger.error(`[KGraph] Embed detail (createNode ${nodeForFrontend.id}): ${detail}`);
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return nodeForFrontend;
  } catch (error) {
    logger.error(`[KGraph] Error in createNode (userId: ${userId})`, error);
    throw new Error(`노드 생성에 실패했습니다: ${error.message}`);
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
  { label, labels, x, y, content, source_message_id, source_conversation_id },
  authHeader = null,
) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);
    const node = graph.nodes.id(nodeId); // Sub-document ID로 찾기

    if (!node) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    let contentChanged = false;

    // 제공된 필드만 업데이트
    // [UPDATE] labels (plural) alias support for frontend compatibility
    if (labels !== undefined) {
      node.label = Array.isArray(labels) ? labels : [labels];
    } else if (label !== undefined) {
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

    await graph.save();

    const updatedNode = { ...node.toObject(), id: node._id.toString() };

    // content가 변경된 경우 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    if (contentChanged) {
      try {
        const nodePayload = {
          id: updatedNode.id,
          content: updatedNode.content,
        };

        await axios.post(
          EMBED_NODE_URL,
          { user_id: userId, nodes: [nodePayload] },
          {
            timeout: 15000,
            headers: authHeader ? { Authorization: authHeader } : {},
          },
        );
        logger.info(
          `[KGraph] Embed call success for updated node (userId: ${userId}, nodeId: ${updatedNode.id})`,
        );
      } catch (embedErr) {
        logger.error(`[KGraph] Embed call failed for updateNode (nodeId: ${updatedNode.id}):`, {
          status: embedErr?.response?.status,
          data: embedErr?.response?.data,
          message: embedErr?.message || embedErr,
        });
        // 임베딩 실패 시 롤백
        logger.warn('[KGraph] Embed skipped for edge update.');
      }
    }

    return updatedNode;
  } catch (error) {
    logger.error(`[KGraph] Error in updateNode (userId: ${userId}, nodeId: ${nodeId})`, error);
    throw new Error(`노드 수정에 실패했습니다: ${error.message}`);
  }
};

/**
 * [MERGED] (API 2.3) POST /nodes/batch
 * 특정 메시지의 임시 노드들을 지식 그래프로 일괄 가져오기. (임베딩 서비스 호출 포함)
 * @param {string} userId - 사용자 ID
 * @param {string} messageId - 임시 노드를 포함한 메시지 ID
 * @returns {Promise<Array>} 추가된 노드 객체의 배열
 */
const importNodes = async (userId, { nodeIds }, authHeader) => {
  try {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    // 1. 해당 노드들을 포함하는 메시지들을 찾습니다.
    // "nodes._id"가 nodeIds 배열에 포함된 메시지를 찾음
    const messages = await Message.find({
      'nodes._id': { $in: nodeIds },
      user: userId,
    });

    if (!messages || messages.length === 0) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    const graph = await getOrCreateGraphDoc(userId);
    const newNodes = [];
    const savePromises = [];

    // 2. 각 메시지에서 요청된 노드들을 추출하고 isCurated 플래그를 업데이트합니다.
    for (const message of messages) {
      let messageModified = false;

      if (message.nodes && Array.isArray(message.nodes)) {
        for (const node of message.nodes) {
          // 요청된 nodeIds에 포함된 노드인지 확인
          if (nodeIds.includes(node._id.toString())) {
            // 이미 가져온 노드인지 확인 (중복 방지 로직이 필요하다면 추가, 여기서는 단순히 KGraph에 추가)
            // KGraph에 추가할 노드 객체 생성
            newNodes.push({
              content: node.content || node.label || '새 노드',
              label: node.label ? [node.label] : [],
              x: node.x || 0,
              y: node.y || 0,
              source_message_id: message.messageId,
              source_conversation_id: message.conversationId,
            });

            // 메시지 내 노드의 isCurated를 true로 설정
            if (!node.isCurated) {
              node.isCurated = true;
              messageModified = true;
            }
          }
        }
      }

      if (messageModified) {
        savePromises.push(message.save());
      }
    }

    if (newNodes.length === 0) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    // 3. KGraph에 새 노드 추가
    graph.nodes.push(...newNodes);
    savePromises.push(graph.save());

    // 4. 변경사항 저장 (메시지들 + 그래프)
    await Promise.all(savePromises);

    // 5. 방금 추가된 노드들을 반환 (ID 포함)
    const addedNodes = graph.nodes.slice(-newNodes.length);
    const addedNodesForFrontend = addedNodes.map((n) => ({
      ...n.toObject(),
      id: n._id.toString(),
    }));

    // 6. 임베딩 서비스 호출 (transaction 내에서 동기적으로 처리)
    try {
      const nodesPayload = addedNodesForFrontend.map((n) => ({
        id: n.id,
        content: n.content,
      }));

      await axios.post(
        EMBED_NODE_URL,
        { user_id: userId, nodes: nodesPayload },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
      logger.info(
        `[KGraph] Embed call success for imported nodes (userId: ${userId}, count: ${nodesPayload.length})`,
      );
    } catch (embedErr) {
      logger.error(`[KGraph] Embed call failed for importNodes (count: ${newNodes.length}):`, {
        status: embedErr?.response?.status,
        data: embedErr?.response?.data,
        message: embedErr?.message || embedErr,
      });
      // 임베딩 실패 시 롤백 (선택 사항: 여기서는 에러만 로깅하고 진행하거나 throw)
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return addedNodesForFrontend;
  } catch (error) {
    logger.error(`[KGraph] Error in importNodes (userId: ${userId})`, error);
    throw new Error(`노드 가져오기 실패: ${error.message}`);
  }
};

/**
 * [MERGED] (API 2.4) POST /nodes/delete
 * 여러 노드를 일괄 삭제합니다. (Kgraph.js의 아토믹 연산 및 임베딩 삭제 로직 사용)
 * @param {string} userId - 사용자 ID
 * @param {Array<string>} nodeIds - 삭제할 노드 ID 배열
 * @returns {Promise<object>} 삭제 결과
 */
const deleteNodes = async (userId, { nodeIds }, authHeader) => {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    logger.warn('[KGraph] Embed skipped for edge update.');
  }

  const ObjectId = mongoose.Types.ObjectId;

  const convertedIds = nodeIds.map((id) => {
    try {
      return ObjectId(id);
    } catch (e) {
      return String(id);
    }
  });

  try {
    // 1. 노드들을 제거
    const updated = await KGraph.findOneAndUpdate(
      { userId: userId },
      { $pull: { nodes: { _id: { $in: convertedIds } } } },
      { new: true },
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
    ).exec();

    // 3. 임베딩 서비스에서 벡터 삭제 (transaction 내에서 동기적으로 처리)
    try {
      const url = `${PYTHON_SERVER_URL}/embed/delete`;
      await axios.post(
        url,
        { user_id: userId, ids: idStrings },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
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
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return { deletedNodes: nodeIds.length };
  } catch (error) {
    logger.error(`[KGraph] Error in deleteNodes (userId: ${userId})`, error);
    throw new Error(`노드 삭제에 실패했습니다: ${error.message}`);
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
const createEdge = async (userId, { source, target, label }, authHeader) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);

    // 엣지는 source와 target 쌍으로 고유함
    let edge = graph.edges.find((e) => e.source === source && e.target === target);
    let isNewEdge = false;

    // label을 배열로 정규화
    let labelArr = [];
    if (Array.isArray(label)) {
      labelArr = label;
    } else if (label) {
      labelArr = [label];
    }

    if (edge) {
      // 엣지가 이미 존재하면, 새 라벨들을 (중복이 아닐 경우) 추가
      for (const l of labelArr) {
        if (!edge.label.includes(l)) {
          edge.label.push(l);
        }
      }
    } else {
      // 엣지가 없으면 새로 생성
      const newEdge = {
        source,
        target,
        label: labelArr,
      };
      graph.edges.push(newEdge);
      edge = graph.edges[graph.edges.length - 1];
      isNewEdge = true;
    }

    // [UPDATE] 엣지 연결 시 관련 노드의 updatedAt 갱신
    const sourceNode = graph.nodes.id(source);
    const targetNode = graph.nodes.id(target);
    const now = new Date();

    if (sourceNode) {
      sourceNode.updatedAt = now;
    }
    if (targetNode) {
      targetNode.updatedAt = now;
    }

    await graph.save();

    const edgeForResponse = { ...edge.toObject(), id: edge._id.toString() };

    // [UPDATE] 프론트엔드 데이터 일치를 위해 업데이트된 노드 정보도 반환
    const nodesForResponse = [];
    if (sourceNode) {
      nodesForResponse.push({ ...sourceNode.toObject(), id: sourceNode._id.toString() });
    }
    if (targetNode) {
      nodesForResponse.push({ ...targetNode.toObject(), id: targetNode._id.toString() });
    }

    // Python 임베드 서비스에 엣지 생성/업데이트 요청 (transaction 내에서 동기적으로 처리)
    try {
      const edgePayload = {
        id: edgeForResponse.id,
        source_id: source,
        target_id: target,
        label: label || '',
      };

      const url = EMBED_EDGE_URL;
      await axios.post(
        url,
        { user_id: userId, edges: [edgePayload] },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
      logger.info(
        `[KGraph] Embed call success for ${
          isNewEdge ? 'new' : 'updated'
        } edge (userId: ${userId}, edgeId: ${edgeForResponse.id})`,
      );
    } catch (embedErr) {
      logger.error(`[KGraph] Embed call failed for createEdge (edgeId: ${edgeForResponse.id}):`, {
        status: embedErr?.response?.status,
        data: embedErr?.response?.data,
        message: embedErr?.message || embedErr,
      });
      // 임베딩 실패 시 롤백
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return { edge: edgeForResponse, nodes: nodesForResponse };
  } catch (error) {
    logger.error(`[KGraph] Error in createEdge (userId: ${userId})`, error);
    throw new Error(`엣지 생성에 실패했습니다: ${error.message}`);
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
const updateEdge = async (userId, { source, target, label }, authHeader) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);
    const edge = graph.edges.find((e) => e.source === source && e.target === target);

    if (!edge) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    // API 명세에 따라, 라벨 배열을 '교체'합니다.
    if (Array.isArray(label)) {
      edge.label = label;
    } else if (typeof label === 'string') {
      edge.label = [label]; // 단일 문자열도 배열로 감싸서 저장
    } else {
      edge.label = []; // 기본값
    }

    // [UPDATE] 엣지 수정 시 관련 노드의 updatedAt 갱신
    const sourceNode = graph.nodes.id(source);
    const targetNode = graph.nodes.id(target);
    const now = new Date();

    if (sourceNode) {
      sourceNode.updatedAt = now;
    }
    if (targetNode) {
      targetNode.updatedAt = now;
    }

    await graph.save();
    const edgeForResponse = { ...edge.toObject(), id: edge._id.toString() };

    // [UPDATE] 프론트엔드 데이터 일치를 위해 업데이트된 노드 정보도 반환
    const nodesForResponse = [];
    if (sourceNode) {
      nodesForResponse.push({ ...sourceNode.toObject(), id: sourceNode._id.toString() });
    }
    if (targetNode) {
      nodesForResponse.push({ ...targetNode.toObject(), id: targetNode._id.toString() });
    }

    // Python 임베드 서비스에 엣지 업데이트 요청 (transaction 내에서 동기적으로 처리)
    try {
      const edgePayload = {
        id: edgeForResponse.id,
        source_id: source,
        target_id: target,
        label: (Array.isArray(label) ? label[0] : label) || '',
      };

      const url = EMBED_EDGE_URL;
      await axios.post(
        url,
        { user_id: userId, edges: [edgePayload] },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
      logger.info(
        `[KGraph] Embed call success for updated edge (userId: ${userId}, edgeId: ${edgeForResponse.id})`,
      );
    } catch (embedErr) {
      logger.error(`[KGraph] Embed call failed for updateEdge (edgeId: ${edgeForResponse.id}):`, {
        status: embedErr?.response?.status,
        data: embedErr?.response?.data,
        message: embedErr?.message || embedErr,
      });
      // 임베딩 실패 시 롤백
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return { edge: edgeForResponse, nodes: nodesForResponse };
  } catch (error) {
    logger.error(`[KGraph] Error in updateEdge (userId: ${userId})`, error);
    throw new Error(`엣지 수정에 실패했습니다: ${error.message}`);
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
const deleteEdge = async (userId, { source, target }, authHeader) => {
  try {
    const graph = await getOrCreateGraphDoc(userId);
    const edge = graph.edges.find((e) => e.source === source && e.target === target);

    if (!edge) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    const edgeId = edge._id.toString();

    // [UPDATE] 엣지 삭제 시 관련 노드의 updatedAt 갱신
    const sourceNode = graph.nodes.id(source);
    const targetNode = graph.nodes.id(target);
    const now = new Date();

    if (sourceNode) {
      sourceNode.updatedAt = now;
    }
    if (targetNode) {
      targetNode.updatedAt = now;
    }

    graph.edges.pull({ _id: edge._id }); // Sub-document 배열에서 제거
    await graph.save();

    // Python 임베드 서비스에서 엣지 삭제 요청 (transaction 내에서 동기적으로 처리)
    try {
      const url = `${PYTHON_SERVER_URL}/embed/delete`;
      await axios.post(
        url,
        { user_id: userId, ids: [edgeId] },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
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
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    return { deletedCount: 1 };
  } catch (error) {
    logger.error(`[KGraph] Error in deleteEdge (userId: ${userId})`, error);
    throw new Error(`엣지 삭제에 실패했습니다: ${error.message}`);
  }
};

/**
 * (API New) Graph Reset
 * 사용자의 그래프 및 임베딩 전체 삭제
 */
const clearGraph = async (userId, authHeader) => {
  try {
    // 1. MongoDB에서 삭제
    await KGraph.deleteOne({ userId });
    logger.info(`[KGraph] MongoDB graph deleted for user ${userId}`);

    // 2. Python에서 삭제
    try {
      const url = `${PYTHON_SERVER_URL}/embed/reset`;
      await axios.post(
        url,
        { user_id: userId },
        {
          timeout: 15000,
          headers: authHeader ? { Authorization: authHeader } : {},
        },
      );
      logger.info(`[KGraph] Python embedding reset success (userId: ${userId})`);
    } catch (embedErr) {
      logger.error(`[KGraph] Python embedding reset failed:`, {
        message: embedErr.message,
        data: embedErr.response ? embedErr.response.data : 'No response data',
      });
      // MongoDB는 이미 지워졌으므로 에러를 throw하지 않고 경고만 남김 (또는 선택적으로 throw)
    }

    return { success: true };
  } catch (error) {
    logger.error(`[KGraph] Error in clearGraph (userId: ${userId})`, error);
    throw error;
  }
};

const recommendationStrategies = require('./recommendations');

// ... (existing code)

// 4.3 연결 추천 로직
/**
 * (API 4.3) GET /recommendations
 * 노드 연결 추천
 *
 * @query {string} method - 추천 방법 ('least_similar' | 'synonyms' | 'node_tag' | 'edge_analogy' | 'old_ones')
 * @query {object} params - 추천 방법에 따른 파라미터
 *    - least_similar: { nodeId, top_k }
 *    - synonyms: { nodeId, top_k }
 *    - node_tag: { tag }
 *    - edge_analogy: { ... }
 *    - old_ones: { top_k }
 *
 * @param {string} userId - 사용자 ID
 * @param {string} method - 추천 방법
 * @param {object} params - 파라미터 객체
 * @returns {Promise<Array>} 추천 노드 목록 [{ id, score }, ...]
 */
const getRecommendations = async (userId, method, params) => {
  try {
    if (!userId) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    const strategy = recommendationStrategies[method];
    if (!strategy) {
      const validMethods = Object.keys(recommendationStrategies);
      throw new Error(`Invalid method: ${method}. Valid methods are: ${validMethods.join(', ')}`);
    }

    logger.info(
      `[KGraph] getRecommendations (userId: ${userId}, method: ${method}, params: ${JSON.stringify(
        params,
      )})`,
    );

    const recommendations = await strategy(userId, params);

    // Graph에 존재하는 노드만 필터링
    const graph = await getOrCreateGraphDoc(userId);
    const nodeIdSet = new Set(graph.nodes.map((n) => n._id.toString()));
    const filtered = (recommendations || []).filter((id) => nodeIdSet.has(String(id)));

    logger.info(
      `[KGraph] Recommendations retrieved (userId: ${userId}, method: ${method}, count: ${filtered.length}/${recommendations.length})`,
    );

    return filtered;
  } catch (error) {
    logger.error(`[KGraph] Error in getRecommendations (userId: ${userId}, method: ${method})`, {
      message: error?.message,
      status: error?.response?.status,
      data: safeStringify(error?.response?.data),
    });
    // 실패 시 빈 배열 반환 (UI에서 조용히 처리)
    return [];
  }
};

/**
 * (API 4.2) POST /cluster
 * UMAP 군집 시각화 요청
 * Python UMAP 서비스에 요청하여 노드 벡터 기반 좌표 계산 및 MongoDB 업데이트
 * @param {string} userId - 사용자 ID
 * @returns {Promise<Array>} 업데이트된 노드 ID와 좌표 목록 [{ id, x, y }, ...]
 */
const calculateCluster = async (userId, authHeader) => {
  try {
    if (!userId) {
      logger.warn('[KGraph] Embed skipped for edge update.');
    }

    logger.info(`[KGraph] calculateCluster (userId: ${userId})`);

    // Python UMAP 서비스에 요청
    const response = await axios.post(
      PYTHON_UMAP_URL,
      { user_id: userId },
      { headers: authHeader ? { Authorization: authHeader } : {} },
    );

    // Python 서비스에서 반환된 좌표 데이터
    // [{ id, x, y }, { id, x, y }, ...]
    const umapData = response.data;

    // MongoDB의 노드 좌표 업데이트
    const graph = await getOrCreateGraphDoc(userId);

    // umapData의 각 항목에 대해 해당 노드의 좌표 업데이트
    for (const item of umapData) {
      const node = graph.nodes.id(item.id);
      if (node) {
        node.x = item.x * 250;
        node.y = item.y * 250;
      } else {
        logger.warn(`[KGraph] Node not found in MongoDB (userId: ${userId}, nodeId: ${item.id})`);
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
  clearGraph,
  getRecommendations,
  calculateCluster,
};
