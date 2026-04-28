const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3001;

app.use(cors({ origin: 'http://localhost:4200' }));
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Anthropic proxy
app.post('/api/anthropic', async (req, res) => {
    const { apiKey, body } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// OpenAI proxy
app.post('/api/openai', async (req, res) => {
    const { apiKey, body } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Gemini proxy
app.post('/api/gemini', async (req, res) => {
    const { apiKey, body, model } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'API key required' });
    const geminiModel = model || 'gemini-1.5-pro';
    try {
        const r = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );
        const data = await r.json();
        res.status(r.status).json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 AI Proxy running on http://localhost:${PORT}`);
});
