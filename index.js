import 'dotenv/config';
import bolt from '@slack/bolt';
import axios from 'axios';

const { App, ExpressReceiver } = bolt;

// In-memory install store (replace with DB for production)
const installations = {};

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET, // long random string
  scopes: ['chat:write', 'app_mentions:read', 'im:history', 'im:write', 'channels:history'],
  installerOptions: {
    installPath: '/slack/install',
    redirectUriPath: '/slack/oauth_redirect',
  },
  installationStore: {
    storeInstallation: async (installation) => {
      const key = installation.isEnterpriseInstall ? installation.enterprise.id : installation.team.id;
      installations[key] = installation;
    },
    fetchInstallation: async (query) => {
      const key = query.isEnterpriseInstall ? query.enterpriseId : query.teamId;
      const inst = installations[key];
      if (!inst) throw new Error('Installation not found for this workspace/org');
      return inst;
    },
    deleteInstallation: async (query) => {
      const key = query.isEnterpriseInstall ? query.enterpriseId : query.teamId;
      delete installations[key];
    }
  }
});

const app = new App({ receiver });

// Health check
receiver.app.get('/', (_req, res) => res.status(200).send('OK'));

async function chatWithAzure(messages) {
  const url = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;
  const res = await axios.post(
    url,
    { messages, temperature: 0.3, max_tokens: 800 },
    { headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_API_KEY }, timeout: 60000 }
  );
  return res.data?.choices?.[0]?.message?.content ?? '(no response)';
}

app.event('app_mention', async ({ event, client }) => {
  const thread_ts = event.thread_ts || event.ts;
  const text = (event.text || '').replace(/<@[^>]+>\s?/, '').trim();
  const messages = [
    { role: 'system', content: 'You are a helpful, concise assistant for Slack users.' },
    { role: 'user', content: text || 'Hello' }
  ];
  const answer = await chatWithAzure(messages);
  await client.chat.postMessage({ channel: event.channel, text: answer, thread_ts });
});

app.event('message', async ({ event, client }) => {
  if (event.channel_type !== 'im' || event.subtype) return;
  const messages = [
    { role: 'system', content: 'You are a helpful, concise assistant for Slack users.' },
    { role: 'user', content: event.text || '' }
  ];
  const answer = await chatWithAzure(messages);
  await client.chat.postMessage({ channel: event.channel, text: answer });
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ App is running on port ${port}`);
})();
