-- 1. DB 생성 및 기본 설정
CREATE DATABASE IF NOT EXISTS ai_workbench
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE ai_workbench;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 2. 기존 테이블 제거 (개발용)
DROP TABLE IF EXISTS node_messages;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS nodes;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS users;

-- 3. 기본 사용자 테이블
CREATE TABLE users (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email        VARCHAR(255)    NOT NULL UNIQUE,
  name         VARCHAR(100)            DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 노드(생각 조각) 테이블
CREATE TABLE nodes (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  author_id    BIGINT UNSIGNED NOT NULL,
  title        VARCHAR(255)    NOT NULL,
  kind         ENUM('idea','evidence','hypothesis','decision') NOT NULL,
  content      TEXT                    DEFAULT NULL,
  -- 향후 임베딩 저장 시: 별도 테이블 또는 JSON/BLOB 컬럼 사용 권장
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  version      INT             NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  CONSTRAINT fk_nodes_author
    FOREIGN KEY (author_id)
    REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 자주 쓰는 조회 패턴용 인덱스 (작성자 + 최신순)
CREATE INDEX idx_nodes_author_created
  ON nodes (author_id, created_at DESC);

-- 제목/내용 검색용 FULLTEXT 인덱스 (MySQL 5.7+)
CREATE FULLTEXT INDEX ft_nodes_title_content
  ON nodes (title, content);

-- 5. 노드 간 관계(에지) 테이블
CREATE TABLE edges (
  src_id       BIGINT UNSIGNED NOT NULL,
  dst_id       BIGINT UNSIGNED NOT NULL,
  rel          ENUM(
                  'problem_solution',
                  'hypothesis_test',
                  'cause_effect',
                  'claim_counter',
                  'example_of',
                  'alternative_compare'
                ) NOT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (src_id, dst_id, rel),
  CONSTRAINT fk_edges_src
    FOREIGN KEY (src_id)
    REFERENCES nodes(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_edges_dst
    FOREIGN KEY (dst_id)
    REFERENCES nodes(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 채팅 세션(대화 흐름) 테이블
CREATE TABLE sessions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           BIGINT UNSIGNED NOT NULL,
  title             VARCHAR(255)            DEFAULT NULL,
  started_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_sessions_user_started
  ON sessions (user_id, started_at DESC);

-- 7. 채팅 메시지 테이블
CREATE TABLE messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id  BIGINT UNSIGNED NOT NULL,
  sender      ENUM('user','ai') NOT NULL,
  content     TEXT             NOT NULL,
  created_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_messages_session
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_messages_session_created
  ON messages (session_id, created_at);

-- 8. 노드 ↔ 메시지 연결 테이블
-- 특정 노드가 어떤 채팅 메시지에서 나왔는지 추적 (양방향 연결용)
CREATE TABLE node_messages (
  node_id     BIGINT UNSIGNED NOT NULL,
  message_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (node_id, message_id),
  CONSTRAINT fk_node_messages_node
    FOREIGN KEY (node_id)
    REFERENCES nodes(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_node_messages_message
    FOREIGN KEY (message_id)
    REFERENCES messages(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 감사/변경 로그 테이블 (선택사항이지만 백엔드 팀플에서 점수 잘 나오는 부분)
CREATE TABLE audit_logs (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id     BIGINT UNSIGNED          DEFAULT NULL,
  entity_type  VARCHAR(50)     NOT NULL,
  entity_id    BIGINT UNSIGNED          DEFAULT NULL,
  action       VARCHAR(50)     NOT NULL,
  payload      JSON                     DEFAULT NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_audit_logs_actor
    FOREIGN KEY (actor_id)
    REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_audit_entity
  ON audit_logs (entity_type, entity_id);

SET FOREIGN_KEY_CHECKS = 1;

-- 10. 개발/테스트용 샘플 데이터
INSERT INTO users (email, name) VALUES
  ('alice@example.com', 'Alice'),
  ('bob@example.com',   'Bob');

INSERT INTO sessions (user_id, title) VALUES
  (1, 'Alice의 첫 실험 세션'),
  (2, 'Bob의 아이디어 정리 세션');

INSERT INTO messages (session_id, sender, content) VALUES
  (1, 'user', '지식 작업대 컨셉을 정리해보자'),
  (1, 'ai',   '좋습니다. 먼저 주요 기능과 사용 흐름을 정의해볼게요.'),
  (2, 'user', '옵시디언과 LLM을 같이 쓸 때 문제점을 정리해줘');

INSERT INTO nodes (author_id, title, kind, content) VALUES
  (1, 'LLM 대화에서 나온 아이디어를 바로 구조화', 'idea',
     '채팅에서 떠오른 생각을 원자 노드로 바로 저장하고 싶다.'),
  (1, '옵시디언 그래프와 실시간 연동', 'hypothesis',
     '대화 내용이 자동으로 그래프 노드로 전환되면 맥락 보존에 도움이 된다.'),
  (2, 'LLM + 옵시디언 사용 시 문제점 목록', 'evidence',
     '복붙이 번거롭고, 맥락이 끊기며, 아이디어 재활용이 어렵다.');

INSERT INTO edges (src_id, dst_id, rel) VALUES
  (1, 2, 'hypothesis_test'),
  (3, 1, 'cause_effect');

-- 노드와 메시지 연결 예시
INSERT INTO node_messages (node_id, message_id) VALUES
  (1, 1),
  (2, 2),
  (3, 3);
