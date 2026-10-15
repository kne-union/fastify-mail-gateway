const MailComposer = require('nodemailer/lib/mail-composer');

const buildRawMail = async mail => {
  return await new MailComposer(Object.assign({ from: 'sender@example.com', to: 'bot@test.local', subject: '测试邮件', text: 'hello' }, mail)).compile().build();
};

const createMockImapFactory = () => {
  const state = {
    uidValidity: 1,
    messages: [],
    connectError: null,
    clients: []
  };

  const addMessage = async mail => {
    const uid = (state.messages[state.messages.length - 1]?.uid || 0) + 1;
    const source = await buildRawMail(mail);
    state.messages.push({ uid, source });
    return uid;
  };

  const create = config => {
    const client = {
      config,
      mailbox: null,
      connect: async () => {
        if (state.connectError) {
          throw state.connectError;
        }
      },
      getMailboxLock: async () => {
        client.mailbox = { uidValidity: BigInt(state.uidValidity), exists: state.messages.length };
        return { release: () => {} };
      },
      search: async () => state.messages.map(({ uid }) => uid),
      fetch: async function* (range) {
        const uids = Array.isArray(range) ? range : String(range).split(',').map(Number);
        for (const message of state.messages) {
          if (uids.includes(message.uid)) {
            yield { uid: message.uid, source: message.source, size: message.source.length };
          }
        }
      },
      logout: async () => {}
    };
    state.clients.push(client);
    return client;
  };

  return { state, create, addMessage };
};

module.exports = { createMockImapFactory, buildRawMail };
