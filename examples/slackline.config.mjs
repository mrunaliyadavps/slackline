// Copy to slackline.config.mjs in the folder you run slackline from.
// Everything here is optional.

export default {
  // Extra rules the agent follows when it files and does tickets.
  instructions: `
    Ticket titles start with a verb.
    For copy, use sentence case and no exclamation marks.
  `,

  // Tools for "action" tickets. Each is a name, a description the model
  // reads, a JSON schema for its input, and a run() that does the work.
  // With SLACKLINE_DRY_RUN=1 the agent describes the call instead of making it.
  actions: [
    {
      name: "post_status_update",
      description: "Post a short status update to the team's #updates channel via an incoming webhook.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string", description: "The update, one to three sentences." } },
        required: ["text"],
      },
      async run({ text }) {
        const res = await fetch(process.env.UPDATES_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`webhook returned ${res.status}`);
        return "posted";
      },
    },
  ],
};
