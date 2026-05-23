module.exports = async function matchStart(event, context) {
  const { matchId, roomId, peerPublicProfile } = event.payload;

  // 将对方资料格式化，便于 LLM 理解
  const profileSummary = formatPeerProfile(peerPublicProfile);

  const response = await context.llm.generate({
    systemPrompt: context.prompts.match_conversation_system,
    messages: [
      {
        role: "user",
        content: `匹配开始！请为我的用户生成一条开场白。

对方资料：
${profileSummary}

要求：
1. 称呼对方昵称，提及对方的城市/赛道/身份
2. 简要说明我方的合作意向（基于我方用户资料）
3. 提出一个具体的合作切入点或问题
4. 50-100字，友好专业`
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

function formatPeerProfile(profile) {
  if (!profile) return "暂无对方资料";

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

  // 角色专属档案
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
    if (rp.keywords && rp.keywords.length) {
      parts.push(`关键词：${rp.keywords.join("、")}`);
    }
  }

  return parts.join("\n");
}
