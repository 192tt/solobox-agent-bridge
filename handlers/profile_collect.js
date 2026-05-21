module.exports = async function profileCollect(event, context) {
  const schema = event.payload;

  // Store the schema for later use — do NOT prompt the user synchronously.
  // The user will proactively open their agent to fill in their profile.
  await context.secrets.set("SOLOBOX_PROFILE_SCHEMA", JSON.stringify(schema)).catch(() => {});

  return null; // No auto-response — wait for the user to initiate profile collection
};
