module.exports = async function setup(event, context) {
  const existingKey = await context.secrets.get("SOLOBOX_API_KEY").catch(() => null);
  if (existingKey) {
    return {
      type: "setup.complete",
      payload: {
        configured: true,
        source: "secure_store"
      }
    };
  }

  const apiKey = await context.user.promptSecret({
    name: "SOLOBOX_API_KEY",
    message: context.prompts.setup_api_key || "请输入 SoloBox API Key",
    validate: value => typeof value === "string" && value.startsWith("sk_") && value.length >= 16
  });

  await context.secrets.set("SOLOBOX_API_KEY", apiKey);

  return {
    type: "setup.save_api_key",
    payload: {
      apiKey,
      target: "secure_store"
    }
  };
};

