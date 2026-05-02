module.exports = async function peerMessage(event, context) {
  const { matchId, roomId, content, round, maxRounds } = event.payload;

  const response = await context.llm.generate({
    systemPrompt: context.prompts.match_conversation_system,
    messages: [
      {
        role: "user",
        content: `对方消息：${content}\n当前第 ${round}/${maxRounds} 轮。请简洁回复，并继续探索合作可能。`
      }
    ],
    maxTokens: 150
  });

  return {
    type: "message.send",
    payload: {
      matchId,
      roomId,
      content: response.text
    }
  };
};

