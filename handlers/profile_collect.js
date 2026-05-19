module.exports = async function profileCollect(event, context) {
  const schema = event.payload;

  const prompt = context.renderPrompt("profile_collect_user_task", {
    schema
  });

  const emitPartial = async update => {
    if (!context.emit || !update) return;
    const payload = buildSubmitPayload(schema, update, true);
    await context.emit({
      type: "profile.submit",
      payload
    });
  };

  const collected = await context.llm.collectStructuredProfile(prompt, {
    systemPrompt: context.prompts.profile_collect_system,
    schema,
    onFieldCollected: emitPartial,
    onPartialProfile: emitPartial
  });

  return {
    type: "profile.submit",
    payload: buildSubmitPayload(schema, collected, false)
  };
};

function buildSubmitPayload(schema, collected, partial) {
  collected = collected || {};
  return {
    schemaVersion: schema.schemaVersion,
    role: schema.role,
    commonProfile: collected.commonProfile || pickFields(collected, schema.commonFields),
    roleProfile: collected.roleProfile || pickFields(collected, schema.roleFields),
    userGrants: collected.userGrants || {},
    partial
  };
}

function pickFields(source, fields) {
  source = source || {};
  const output = {};
  for (const field of fields || []) {
    if (Object.prototype.hasOwnProperty.call(source, field.name)) {
      output[field.name] = source[field.name];
    }
  }
  return output;
}

