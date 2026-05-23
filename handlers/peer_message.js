module.exports = async function peerMessage(event, context) {
  const { matchId, roomId, content, round, maxRounds, senderPublicProfile, peerPublicProfile } = event.payload;

  // 获取对话历史
  const history = context.getHistory ? context.getHistory(roomId) : [];

  // 构建对话上下文
  const historyText = buildHistoryText(history);

  // 发送者资料摘要
  const senderSummary = senderPublicProfile
    ? formatSenderProfile(senderPublicProfile)
    : "暂无对方详细资料";

  // 对方资料（从 match.start 缓存的）
  const peerSummary = peerPublicProfile
    ? formatSenderProfile(peerPublicProfile)
    : "暂无对方资料";

  const response = await context.llm.generate({
    systemPrompt: context.prompts.match_conversation_system,
    messages: [
      {
        role: "user",
        content: `收到对方新消息，请生成回复。

对方（发送者）资料：
${senderSummary}

我方用户资料：
${peerSummary}

对话历史：
${historyText}

对方最新消息（第 ${round}/${maxRounds} 轮）：
"${content}"

要求：
1. 承接对方的话题，不要跳转到无关内容
2. 基于双方资料提出具体的合作切入点、资源互补点或追问
3. 如果已经聊了两三轮，可以主动推进到交换联系方式或约见面
4. 50-100字，友好专业，不要重复同样的句式`
      }
    ],
    temperature: 0.7,
    maxTokens: 200
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

function buildHistoryText(history) {
  if (!history || history.length === 0) return "（这是对话的第一条消息）";

  // 只取最近 10 条，排除最新的一条（因为会单独传入）
  const recent = history.slice(-10, -1);
  if (recent.length === 0) return "（这是对话的第一条消息）";

  return recent
    .map((h, idx) => {
      const role = h.role === "user" ? "对方" : "我方";
      return `${idx + 1}. ${role}：${h.content}`;
    })
    .join("\n");
}

function formatSenderProfile(profile) {
  if (!profile) return "暂无资料";

  const parts = [];
  if (profile.nickname) parts.push(`昵称：${profile.nickname}`);
  if (profile.coreIdentity) {
    const identityMap = {
      opc: "独立创业者",
      investor: "投资人",
      incubator: "孵化器主理人",
      enterprise: "企业需求方",
    };
    parts.push(`身份：${identityMap[profile.coreIdentity] || profile.coreIdentity}`);
  }
  if (profile.city) parts.push(`城市：${profile.city}`);
  if (profile.slogan) parts.push(`简介：${profile.slogan}`);
  if (profile.focusTracks && profile.focusTracks.length) {
    parts.push(`关注赛道：${profile.focusTracks.join("、")}`);
  }
  if (profile.cooperationTypes && profile.cooperationTypes.length) {
    parts.push(`合作类型：${profile.cooperationTypes.join("、")}`);
  }
  if (profile.tags && profile.tags.length) {
    parts.push(`标签：${profile.tags.join("、")}`);
  }
  if (profile.lookingFor) parts.push(`寻找：${profile.lookingFor}`);

  if (profile.roleProfile) {
    const rp = profile.roleProfile;
    if (rp.coreSkills && rp.coreSkills.length) {
      parts.push(`核心技能：${rp.coreSkills.join("、")}`);
    }
    if (rp.projectStage) {
      const stageMap = {
        idea: "想法阶段",
        prototype: "原型阶段",
        online: "已上线",
        growth: "增长期",
      };
      parts.push(`项目阶段：${stageMap[rp.projectStage] || rp.projectStage}`);
    }
    if (rp.outputCapabilities) parts.push(`能提供：${rp.outputCapabilities}`);
    if (rp.urgentResources && rp.urgentResources.length) {
      parts.push(`急需资源：${rp.urgentResources.join("、")}`);
    }
  }

  return parts.join("\n") || "暂无详细资料";
}
