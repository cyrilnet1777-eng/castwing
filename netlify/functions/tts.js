exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Method not allowed',
    };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No API key' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '');
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Invalid JSON',
    };
  }

  const text = body && typeof body.text === 'string' ? body.text : '';
  const voiceId = body && typeof body.voiceId === 'string' ? body.voiceId : '';
  const modelId = body && typeof body.modelId === 'string' ? body.modelId : '';
  if (!text || !voiceId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Missing text or voiceId',
    };
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId || 'eleven_flash_v2_5',
      language_code: 'fr',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `ElevenLabs error ${response.status}` }),
    };
  }

  const audioBuffer = await response.arrayBuffer();
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: { 'Content-Type': 'audio/mpeg' },
    body: Buffer.from(audioBuffer).toString('base64'),
  };
};
