const TOOL_INSTRUCTIONS = {
  premortem:
    'Pre-mortem 분석이 요청되었습니다. 현재 대화 맥락이나 제공된 내용을 바탕으로, 이 아이디어나 계획이 실패한다고 가정하고 그 원인을 Pre-mortem 관점에서 분석해주세요. 답변은 반드시 "[MODE: Pre-mortem]"으로 시작해라.:\n',
  devils_advocate:
    '악마의 대변인 모드가 요청되었습니다. 현재 대화 맥락이나 제공된 내용에 대해 구체적인 반론을 제기하고 비판적인 시각에서 분석해주세요. 답변은 "[MODE: Devils]"로 시작해라.:\n',
  virtual_persona:
    '가상 페르소나 모드가 요청되었습니다. 현재 대화 맥락이나 제공된 내용을 다양한 이해관계자의 관점에서 객관적으로 검증하고, 확증 편향에서 벗어날 수 있도록 분석해주세요. 특히 지정된 페르소나의 관점을 채택하거나 다각도로 분석해주세요. 답변은 "[MODE: Persona]"로 시작해라.:\n',
};

module.exports = { TOOL_INSTRUCTIONS };
