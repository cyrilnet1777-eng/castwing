function toText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    if (typeof value.detail === 'string') return value.detail;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

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
    const rawKey = String(process.env.ELEVENLABS_API_KEY || '').trim();
    const apiKey = rawKey.replace(/^['"]|['"]$/g, '').replace(/^Bearer\s+/i, '');
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
    const emotion = typeof payload.emotion === 'string' ? payload.emotion.trim().toLowerCase() : 'neutral';
    const speed = Number.isFinite(Number(payload.speed)) ? Number(payload.speed) : 1;
    const languageCode = typeof payload.languageCode === 'string' ? payload.languageCode.trim().toLowerCase() : '';
    const modelId = typeof payload.modelId === 'string' ? payload.modelId.trim() : '';

    if (!text || !voiceId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing text or voiceId' }),
      };
    }

    const emotionMap = {
      neutral: { stability: 0.58, similarity_boost: 0.76, style: 0.25 },
      excited: { stability: 0.2, similarity_boost: 0.7, style: 1.0 },
      sad: { stability: 0.98, similarity_boost: 0.45, style: 0.0 },
      angry: { stability: 0.15, similarity_boost: 0.88, style: 1.0 },
      whisper: { stability: 1.0, similarity_boost: 0.4, style: 0.0 },
    };
    const base = emotionMap[emotion] || emotionMap.neutral;
    const speedBoost = speed > 1 ? Math.min(0.22, (speed - 1) * 0.3) : 0;
    const speedSlow = speed < 1 ? Math.min(0.22, (1 - speed) * 0.3) : 0;
    const voiceSettings = {
      stability: Math.max(0.1, Math.min(1, base.stability + speedBoost - speedSlow)),
      similarity_boost: Math.max(0.1, Math.min(1, base.similarity_boost + speedSlow * 0.5)),
      style: Math.max(0, Math.min(1, base.style + speedBoost)),
    };

    const modelCandidates = [];
    if (modelId) modelCandidates.push(modelId);
    if (!modelCandidates.includes('eleven_multilingual_v2')) modelCandidates.push('eleven_multilingual_v2');
    if (!modelCandidates.includes('eleven_flash_v2_5')) modelCandidates.push('eleven_flash_v2_5');
    const languageCandidates = languageCode ? [languageCode, ''] : [''];

    const attempts = [];
    let lastStatus = 502;
    let lastDetail = 'ElevenLabs request failed';

    for (const candidateModel of modelCandidates) {
      for (const candidateLang of languageCandidates) {
        const body = {
          text,
          model_id: candidateModel,
          voice_settings: voiceSettings,
        };
        if (candidateLang) body.language_code = candidateLang;

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const audioBuffer = await response.arrayBuffer();
          return {
            statusCode: 200,
            isBase64Encoded: true,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'no-store',
              'X-Elevenlabs-Model': candidateModel,
              'X-Elevenlabs-Language': candidateLang || 'default',
            },
            body: Buffer.from(audioBuffer).toString('base64'),
          };
        }

        let rawDetail = '';
        let parsed = null;
        try {
          rawDetail = await response.text();
          parsed = rawDetail ? JSON.parse(rawDetail) : null;
        } catch (e) {
          parsed = null;
        }
        const detail = toText(
          (parsed && (parsed.detail || parsed.message || parsed.error)) || rawDetail || `ElevenLabs error ${response.status}`
        );

        lastStatus = response.status;
        lastDetail = detail;
        attempts.push({
          status: response.status,
          model: candidateModel,
          language: candidateLang || 'default',
          detail,
        });

        // Auth/scope errors are definitive: stop retrying.
        if (response.status === 401 || response.status === 403) {
          const authHint =
            response.status === 401
              ? 'Check ELEVENLABS_API_KEY validity and text_to_speech permission.'
              : 'Key exists but lacks permission. Enable text_to_speech scope.';
          return {
            statusCode: 502,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: `ElevenLabs error ${response.status}`,
              details: detail,
              hint: authHint,
              attempts,
            }),
          };
        }
      }
    }

    const hint =
      lastStatus === 404
        ? 'Voice/model/language combination unavailable. Try another accent/voice.'
        : lastStatus === 422
        ? 'Language not supported by this voice. The backend already retried without language_code.'
        : '';
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `ElevenLabs error ${lastStatus}`,
        details: lastDetail,
        hint,
        attempts,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: toText(error && error.message ? error.message : error || 'Unexpected error') }),
    };
  }
};
