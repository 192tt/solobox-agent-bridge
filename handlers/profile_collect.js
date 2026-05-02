module.exports = async function profileCollect(event, context) {
  const schema = event.payload;

  const prompt = context.renderPrompt("profile_collect_user_task", {
    schema
  });

  const collected = await context.llm.collectStructuredProfile(prompt, {
    systemPrompt: context.prompts.profile_collect_system,
    schema
  });

  return {
    type: "profile.submit",
    payload: {
      schemaVersion: schema.schemaVersion,
      role: schema.role,
      commonProfile: collected.commonProfile,
      roleProfile: collected.roleProfile,
      userGrants: collected.userGrants || {}
    }
  };
};

