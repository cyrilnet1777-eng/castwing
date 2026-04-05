// Store sessions in memory (Netlify Blobs would be better for production)
const sessions = {};
const MESSAGE_TIMEOUT = 60000; // 1 minute

// Initialize session if doesn't exist
function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      messages: [],
      createdAt: Date.now(),
      participants: []
    };
  }
  // Clean up old sessions
  const now = Date.now();
  Object.keys(sessions).forEach(id => {
    if (now - sessions[id].createdAt > MESSAGE_TIMEOUT * 2) {
      delete sessions[id];
    }
  });
  return sessions[sessionId];
}

exports.handler = async (event) => {
  const { httpMethod, path, body, queryStringParameters = {} } = event;

  try {
    // POST: Add message
    if (httpMethod === 'POST') {
      const { sessionId, type, from, data } = JSON.parse(body);

      if (!sessionId || !from) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Missing sessionId or from' })
        };
      }

      const session = getOrCreateSession(sessionId);
      
      // Track participants
      if (!session.participants.includes(from)) {
        session.participants.push(from);
      }

      session.messages.push({
        type,
        from,
        data,
        timestamp: Date.now()
      });

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          success: true,
          participantCount: session.participants.length
        })
      };
    }

    // GET: Retrieve messages
    if (httpMethod === 'GET') {
      const sessionId = queryStringParameters.sessionId;
      const from = queryStringParameters.from;

      if (!sessionId || !from) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Missing sessionId or from' })
        };
      }

      const session = getOrCreateSession(sessionId);
      
      // Get messages not from this participant
      const messages = session.messages.filter(msg => msg.from !== from);
      
      // Clear old messages after retrieval
      session.messages = session.messages.filter(msg => 
        Date.now() - msg.timestamp < MESSAGE_TIMEOUT
      );

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          participantCount: session.participants.length,
          sessionId
        })
      };
    }

    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
