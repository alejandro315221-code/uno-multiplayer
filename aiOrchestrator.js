const ROOM_MEMORY_LIMIT = 10;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const roomMemories = new Map();
let groqClient = null;
let warnedMissingGroqSdk = false;

function getGroqClient() {
  if (!process.env.GROQ_API_KEY) return null;
  if (groqClient) return groqClient;

  try {
    const Groq = require('groq-sdk');
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return groqClient;
  } catch (err) {
    if (!warnedMissingGroqSdk) {
      console.warn('Groq CPU chat disabled:', err.message);
      warnedMissingGroqSdk = true;
    }
    return null;
  }
}

function getRoomMemory(roomCode) {
  const key = String(roomCode || 'default');
  if (!roomMemories.has(key)) roomMemories.set(key, []);
  return roomMemories.get(key);
}

function rememberRoomMessage(roomCode, speaker, text) {
  const memory = getRoomMemory(roomCode);
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!cleanText) return;
  memory.push({ speaker: String(speaker || 'Unknown').slice(0, 40), text: cleanText });
  while (memory.length > ROOM_MEMORY_LIMIT) memory.shift();
}

function shouldAskCpu(text, cpuNames = []) {
  const body = String(text || '');
  return cpuNames.some(name => body.toLowerCase().includes(String(name).split(' ')[0].toLowerCase())) || Math.random() < 0.30;
}

function chooseCpu(cpus, message) {
  const body = String(message || '').toLowerCase();
  const mentioned = cpus.find(cpu => body.includes(String(cpu.name).split(' ')[0].toLowerCase()));
  return mentioned || cpus[Math.floor(Math.random() * cpus.length)];
}

async function maybeGenerateCpuReply({ roomCode, humanName, message, gameName = 'Tabletop Online', cpus = [] }) {
  rememberRoomMessage(roomCode, humanName, message);

  if (!cpus.length || !shouldAskCpu(message, cpus.map(cpu => cpu.name))) return null;
  const groq = getGroqClient();
  if (!groq) return null;

  const memory = getRoomMemory(roomCode);
  const memoryLines = memory.map(entry => `${entry.speaker}: ${entry.text}`).join('\n') || 'No chat yet.';

  const cpu = chooseCpu(cpus, message);
  const systemPrompt = [
    `You are ${cpu.name}, a modern CPU opponent in a multiplayer browser tabletop game.`,
    `Your personality: ${cpu.personality || 'modern, competitive, playful table banter'}.`,
    'Use modern gamer/table banter, not medieval fantasy talk.',
    'Be sarcastic or playful when it fits, but never cruel or hateful.',
    `Reply as ${cpu.name} only. Do not include labels like "${cpu.name}:".`,
    'Keep replies under 24 words.',
  ].join(' ');

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.85,
      max_tokens: 80,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Game: ${gameName}\nRecent room memory (last ${ROOM_MEMORY_LIMIT}):\n${memoryLines}\nLatest human message from ${humanName}: ${message}` },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!reply) return null;
    rememberRoomMessage(roomCode, cpu.name, reply);
    return { speaker: cpu.name, message: reply };
  } catch (err) {
    console.warn('Groq CPU chat skipped:', err.message);
    return null;
  }
}

module.exports = {
  rememberRoomMessage,
  maybeGenerateCpuReply,
};
