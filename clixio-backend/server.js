// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Groq = require('groq-sdk');

// ---------- CONFIG ----------
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// ---------- VALIDATE ENV ----------
if (!process.env.GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY is missing in .env file!');
  console.error('👉 Get your free key at: https://console.groq.com/keys');
  process.exit(1);
}

// ---------- INITIALIZE GROQ ----------
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// ---------- CORS ----------
const allowedOrigins = process.env.ALLOWED_ORIGINS === '*'
  ? '*'
  : process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim());

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true,
}));

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: '1mb' }));

// Rate Limiter — 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    text: '⚠️ Too many requests. Please wait a minute and try again.',
  },
});
app.use('/api/', limiter);

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- ROUTES ----------

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ ok',
    service: 'Clixio Backend',
    provider: 'Groq',
    model: GROQ_MODEL,
    environment: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// Groq health/test endpoint
app.get('/api/health', async (req, res) => {
  try {
    const completion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
      model: GROQ_MODEL,
      max_tokens: 10,
    });

    res.json({
      status: '✅ healthy',
      groq: 'connected',
      model: GROQ_MODEL,
      sample_response: completion.choices[0]?.message?.content,
    });
  } catch (error) {
    res.status(500).json({
      status: '❌ unhealthy',
      error: error.message,
    });
  }
});

// ---------- MAIN AI ENDPOINT ----------
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, systemPrompt } = req.body;

    // Validation
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        text: '⚠️ Prompt is required and must be a non-empty string',
      });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({
        text: '⚠️ Prompt is too long (max 4000 characters)',
      });
    }

    console.log(`📩 New request — prompt length: ${prompt.length}`);

    // Default system prompt for Clixio
    const defaultSystemPrompt = `You are Clixio, a smart AI assistant that transforms user thoughts, ideas, and goals into clear, actionable plans. 
Your responses should be:
- Encouraging and direct
- Practical and specific
- Easy to follow
- Focused on action

Always respond with structured, numbered lists when breaking down plans.`;

    // Call Groq
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt || defaultSystemPrompt },
        { role: 'user', content: prompt },
      ],
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.95,
      stream: false,
    });

    const aiText = completion.choices[0]?.message?.content?.trim() || '';

    if (!aiText) {
      return res.status(500).json({
        text: '⚠️ AI returned an empty response. Please try again.',
      });
    }

    console.log(`✅ Response sent — ${aiText.length} chars, ${completion.usage?.total_tokens} tokens`);

    res.json({
      text: aiText,
      model: GROQ_MODEL,
      usage: completion.usage,
    });
  } catch (error) {
    console.error('❌ Groq API Error:', error.message);

    // Handle specific Groq errors
    if (error.status === 401) {
      return res.status(401).json({
        text: '❌ Invalid API key. Check your GROQ_API_KEY in .env',
      });
    }
    if (error.status === 429) {
      return res.status(429).json({
        text: '⚠️ Rate limit reached. Please wait a moment and try again.',
      });
    }
    if (error.status === 503) {
      return res.status(503).json({
        text: '⚠️ Groq service is temporarily unavailable. Try again shortly.',
      });
    }

    res.status(500).json({
      text: `❌ Error: ${error.message || 'Something went wrong'}`,
    });
  }
});

// ---------- STREAMING ENDPOINT (Bonus!) ----------
app.post('/api/generate-stream', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ text: 'Prompt is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'You are Clixio, an AI that turns thoughts into actionable plans.' },
        { role: 'user', content: prompt },
      ],
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens: 1024,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    console.error('❌ Streaming error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// ---------- 404 HANDLER ----------
app.use((req, res) => {
  res.status(404).json({
    text: `Route not found: ${req.method} ${req.path}`,
    available_routes: [
      'GET  /',
      'GET  /api/health',
      'POST /api/generate',
      'POST /api/generate-stream',
    ],
  });
});

// ---------- ERROR HANDLER ----------
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ text: 'Internal server error' });
});

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   🚀 CLIXIO BACKEND — POWERED BY GROQ  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`📍 Running on: http://localhost:${PORT}`);
  console.log(`🤖 Model:      ${GROQ_MODEL}`);
  console.log(`🔑 API Key:    ${process.env.GROQ_API_KEY ? '✅ Configured' : '❌ Missing'}`);
  console.log(`🌍 Env:        ${NODE_ENV}`);
  console.log('\n📡 Available endpoints:');
  console.log('   GET  /              — Health check');
  console.log('   GET  /api/health    — Test Groq connection');
  console.log('   POST /api/generate  — Generate AI response');
  console.log('   POST /api/generate-stream — Streaming response\n');
});