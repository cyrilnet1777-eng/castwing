exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        Allow: 'POST',
      },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing ELEVENLABS_API_KEY' }),
      };
    }

    const payload = JSON.parse(event.body || '{}');
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const voiceId = typeof payload.voiceId === 'string' ? payload.voiceId.trim() : '';
    const emotion = typeof payload.emotion === 'string' ? payload.emotion.trim() : 'neutral';

    if (!text || !voiceId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing text or voiceId' }),
      };
    }

    const emotionMap = {
      neutral: { stability: 0.55, similarity_boost: 0.75, style: 0.2 },
      excited: { stability: 0.35, similarity_boost: 0.72, style: 0.7 },
      sad: { stability: 0.75, similarity_boost: 0.7, style: 0.05 },
      angry: { stability: 0.3, similarity_boost: 0.8, style: 0.8 },
      whisper: { stability: 0.82, similarity_boost: 0.68, style: 0.02 },
    };
    const voiceSettings = emotionMap[emotion] || emotionMap.neutral;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'ElevenLabs error');
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errText || 'ElevenLabs request failed' }),
      };
    }

    const audioBuffer = await response.arrayBuffer();
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
      body: Buffer.from(audioBuffer).toString('base64'),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message || 'Unexpected error' }),
    };
  }
};
