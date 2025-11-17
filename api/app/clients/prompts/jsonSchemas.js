/**
 * JSON output schemas for structured AI responses using OpenAI Structured Outputs
 */

/**
 * Standard response schema with atomic ideas
 * Used for breaking down AI responses into reusable, atomic components
 */
const atomicIdeasSchema = {
  type: 'object',
  properties: {
    response: {
      type: 'string',
      description: '사용자의 질문에 대한 완전하고 상세한 답변. 모든 정보와 설명을 포함해야 하며, 이 필드만으로도 질문에 충분히 답할 수 있어야 함.',
    },
    atomic_ideas: {
      type: 'array',
      description: 'response에서 추출한 핵심 개념들을 원자적 아이디어로 정리한 배열. 응답의 주요 포인트들을 간결하게 분해.',
      items: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: '하나의 독립적이고 재사용 가능한 개념. 명확하고 간결해야 함.',
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
  },
  required: ['response', 'atomic_ideas'],
  additionalProperties: false,
};

/**
 * OpenAI API Structured Outputs format for atomic ideas
 * Use this with response_format parameter
 */
const atomicIdeasJsonSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'atomic_ideas_response',
    strict: true,
    schema: atomicIdeasSchema,
  },
};

/**
 * Simple response-only schema (no atomic ideas)
 */
const simpleResponseSchema = {
  type: 'object',
  properties: {
    response: {
      type: 'string',
      description: '응답 텍스트',
    },
  },
  required: ['response'],
  additionalProperties: false,
};

const simpleResponseJsonSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'simple_response',
    strict: true,
    schema: simpleResponseSchema,
  },
};

module.exports = {
  // JSON Schemas 레퍼런스용
  atomicIdeasSchema,
  simpleResponseSchema,
  // OpenAI API Structured Output, 응답 스키마
  atomicIdeasJsonSchema,
  simpleResponseJsonSchema,
};
