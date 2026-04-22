const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

function extractTextBlocks(message) {
  const blocks = message && message.content ? message.content : [];
  let out = '';
  for (const b of blocks) {
    if (b.type === 'text' && b.text) out += b.text;
  }
  return out;
}

function parseModelJson(rawText) {
  let s = String(rawText || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/im.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Pas de JSON dans la réponse');
  return JSON.parse(s.slice(start, end + 1));
}

function buildSchemaPrompt() {
  return [
    'Tu extrais un scénario pour une application de répétition (ordre des répliques et didascalies).',
    'Réponds uniquement avec un objet JSON UTF-8 valide, sans markdown ni texte hors JSON.',
    'Schéma exact :',
    '{"characters":["NOM",...],"lines":[{"character":"NOM ou null","text":"…","type":"dialogue | action | slug"}]}',
    '- characters : personnages ayant au moins une réplique (orthographe du document).',
    '- lines : ordre chronologique du document.',
    '- type "dialogue" : réplique ; character = locuteur ; texte sans répéter le nom en tête.',
    '- type "action" : didascalie, description, transitions ; character doit être null.',
    '- type "slug" : INT./EXT./SCÈNE uniquement ; character null.',
    '- Si nom et réplique sont collés sur une ligne (ex: "LUCIE I leave"), sépare character "LUCIE" et texte "I leave".',
  ].join('\n');
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Missing ANTHROPIC_API_KEY' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const pdfBase64 =
    typeof body.pdfBase64 === 'string'
      ? body.pdfBase64.replace(/^data:application\/pdf[^,]*,/i, '').trim()
      : '';
  const screenplayText = typeof body.screenplayText === 'string' ? body.screenplayText : '';
  const fileName = typeof body.fileName === 'string' ? body.fileName : '';

  if (!pdfBase64 && !screenplayText.trim()) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Provide pdfBase64 or screenplayText' }),
    };
  }

  if (pdfBase64.length > 45 * 1024 * 1024) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'PDF trop volumineux pour l’API' }),
    };
  }

  const maxTokensRaw = Number(process.env.ANTHROPIC_MAX_TOKENS);
  const max_tokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.min(32768, maxTokensRaw) : 16384;

  const userContent = [];
  if (pdfBase64) {
    userContent.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: pdfBase64,
      },
    });
    userContent.push({
      type: 'text',
      text:
        (fileName ? `Fichier : ${fileName}\n\n` : '') +
        buildSchemaPrompt() +
        '\nAnalyse le PDF joint et produis le JSON.',
    });
  } else {
    userContent.push({
      type: 'text',
      text:
        'Scénario en texte :\n---\n' +
        screenplayText +
        '\n---\n\n' +
        buildSchemaPrompt(),
    });
  }

  const payload = {
    model: DEFAULT_MODEL,
    max_tokens,
    system:
      'Tu renvoies uniquement un JSON compact avec les clés characters (tableau de chaînes) et lines (tableau d’objets). Aucune prose en dehors du JSON.',
    messages: [{ role: 'user', content: userContent }],
  };

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!resp.ok) {
      const msg =
        (data && data.error && data.error.message) ||
        raw.slice(0, 400) ||
        `HTTP ${resp.status}`;
      return {
        statusCode: resp.status >= 400 && resp.status < 600 ? resp.status : 502,
        headers,
        body: JSON.stringify({ error: msg }),
      };
    }

    const textOut = extractTextBlocks(data);
    let parsed;
    try {
      parsed = parseModelJson(textOut);
    } catch (e) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'Réponse non JSON : ' + (e && e.message ? e.message : String(e)),
          rawPreview: textOut.slice(0, 1200),
        }),
      };
    }

    if (!parsed.characters || !Array.isArray(parsed.lines)) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'JSON invalide : characters ou lines manquants' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        characters: parsed.characters,
        lines: parsed.lines,
      }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: e && e.message ? e.message : 'Erreur serveur',
      }),
    };
  }
};
