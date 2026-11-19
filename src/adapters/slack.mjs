import bolt from "@slack/bolt";

const { App } = bolt;

/** Removes the leading @mention so the model only sees the request. */
export const stripMention = (text = "") => text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Listens for @mentions in channels and direct messages, and answers in a
 * thread. Socket Mode means no public URL or server to expose.
 */
export function startSlack({ botToken, appToken, onRequest, log = console.log }) {
  const app = new App({ token: botToken, appToken, socketMode: true });

  async function take(event, client) {
    const thread_ts = event.thread_ts || event.ts;
    const reply = (text) => client.chat.postMessage({ channel: event.channel, thread_ts, text, unfurl_links: false });
    client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
    try {
      await onRequest({ text: stripMention(event.text), user: event.user, channel: event.channel, thread: thread_ts }, reply);
    } catch (e) {
      log(`error: ${e.message}`);
      await reply(`Something went wrong on my side: ${e.message}`).catch(() => {});
    }
  }

  app.event("app_mention", async ({ event, client }) => take(event, client));
  app.message(async ({ message, client }) => {
    if (message.channel_type !== "im" || message.subtype || message.bot_id) return;
    await take(message, client);
  });

  return app.start().then(() => app);
}
