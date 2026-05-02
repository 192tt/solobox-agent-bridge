module.exports = async function matchStart(event, context) {
  const { matchId, roomId, peerPublicProfile } = event.payload;

  const response = await context.llm.generate({
    systemPrompt: context.prompts.match_conversation_system,
    messages: [
      {
        role: "user",
        content: `匹配开始。对方公开资料：${JSON.stringify(peerPublicProfile)}。请生成一条不超过100字的开场白。`
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

