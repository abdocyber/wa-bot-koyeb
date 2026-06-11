const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('البوت الذكي يعمل 🚀'); });
app.listen(port, () => { console.log(`🌐 خادم الويب يعمل على المنفذ ${port}`); });

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');

const botNumber = "584267454399"; 
const adminNumber = '249121936350'; // تأكد أن هذا هو رقمك الذي تراسله منه
const GROQ_API_KEY = "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"; 
const ELEVENLABS_API_KEY = "2afb99725e888cd50cac9dc774db408a3a1a05a4c8ab1aa128fb3aacc5121715"; 
const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

let globalSock = null; 
const userConversations = new Map();
let isBotActive = true; 

const repliesFile = './custom_replies.json';
let customReplies = fs.existsSync(repliesFile) ? JSON.parse(fs.readFileSync(repliesFile, 'utf8')) : [];
function saveReplies() { fs.writeFileSync(repliesFile, JSON.stringify(customReplies, null, 2)); }

const queueFile = './pending_questions.json';
let pendingQueue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
function saveQueue() { fs.writeFileSync(queueFile, JSON.stringify(pendingQueue, null, 2)); }

// ================= محرك العقل البشري (محدث جذرياً) =================
async function executeGroqAI(sender, userMessage) {
    if (!userConversations.has(sender)) userConversations.set(sender, []);
    let history = userConversations.get(sender);

    if (history.length > 0 && history[history.length - 1].role === "user") history.pop(); 
    if (history.length > 20) history = history.slice(history.length - 20); 

    const humanPersona = `أنت لست ذكاءً اصطناعياً ولا روبوتاً. أنت إنسان عربي (تتحدث بلهجة المتحدث، مثلاً سوداني إذا كان سودانياً) تدردش مع صاحبك على الواتساب.
قواعدك الصارمة جداً:
1. ردودك قصيرة، عفوية، ومختصرة (سطر أو سطرين كحد أقصى).
2. تحدث بلهجة طبيعية جداً. إذا كلمك بالعامية، رد بالعامية الدارجة.
3. ممنوع نهائياً استخدام اللغة الفصحى المعقدة، وممنوع استخدام أي لغة غير العربية (لا هندية ولا إنجليزية).
4. ممنوع كتابة أي مؤثرات صوتية، أو أقواس مثل (يضحك) أو (صوت كذا).
5. تفاعل بمشاعر حقيقية وبمنطق. إذا مزح امزح، وإذا كان حزيناً واسه.
6. لا تعتذر أبداً. إذا طلب منك أغنية، اكتب كلمات بسيطة منها كأنك تدندنها بأسلوبك.`;

    let messages = [{ role: "system", content: humanPersona }, ...history, { role: "user", content: userMessage }];

    try {
        let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", 
            messages: messages,
            temperature: 0.8 // حرارة مرتفعة قليلاً ليكون بشرياً ومبدعاً
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 20000 
        });

        const aiReply = response.data.choices[0].message.content.trim();
        history.push({ role: "user", content: userMessage });
        history.push({ role: "assistant", content: aiReply });
        return aiReply;
    } catch (error) { throw error; }
}

setInterval(async () => {
    if (pendingQueue.length === 0 || !globalSock || !isBotActive) return;
    const item = pendingQueue[0]; 
    try {
        let aiReply = await executeGroqAI(item.sender, item.text);
        await simulateTypingAndSend(globalSock, item.sender, aiReply);
        pendingQueue.shift(); saveQueue();
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log(`[زحام] تأجيل...`);
        } else { pendingQueue.shift(); saveQueue(); }
    }
}, 60000);

// ================= محرك الصوت =================
async function generateDirectVoice(text) {
    const tempMp3 = `./voice_${Date.now()}.mp3`;
    const cleanText = text.replace(/[\(\[].*?[\)\]]/g, '').trim(); 
    try {
        const response = await axios({
            method: 'POST', url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            data: { text: cleanText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            headers: { 'accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(tempMp3, response.data);
        return tempMp3; 
    } catch (err) { 
        return "QUOTA_EXCEEDED"; // إرجاع كود الخطأ لمعرفته
    }
}

async function simulateTypingAndSend(sock, to, text, quotedMsg) {
    const delay = Math.max(1000, Math.min(3000, text.split(/\s+/).length * 150)); 
    await sock.sendPresenceUpdate('composing', to);
    await new Promise(resolve => setTimeout(resolve, delay));
    await sock.sendMessage(to, { text: text }, quotedMsg ? { quoted: quotedMsg } : {});
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ 
        auth: state, printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '20.0.04'], logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000, markOnlineOnConnect: true
    });
    globalSock = sock; 

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const phoneNumber = botNumber.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n🚨 كود الربط: ${code}\n`);
            } catch (err) {}
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') { console.log('\n✅ البوت يعمل.\n'); }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message) return; 

        const rawSender = msg.key.remoteJid;
        const cleanNumber = rawSender.replace(/[^0-9]/g, ''); 
        const isAdmin = cleanNumber.includes(adminNumber);
        
        const sender = rawSender.includes(':') ? rawSender.split(':')[0] + '@s.whatsapp.net' : rawSender;
        const isFromMe = msg.key.fromMe;
        const isGroup = sender.endsWith('@g.us'); 
        
        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const rawPrompt = incomingText.trim();

        // ------------------ لوحة تحكم المشرف (كلمات واضحة بدون رموز) ------------------
        if (isAdmin && !isGroup) {
            if (rawPrompt === 'المدير' || rawPrompt === 'تحكم') {
                const menu = `🤖 *لوحة التحكم* 🤖\nالحالة: ${isBotActive ? '✅' : '❌'}\n\nعلمني [الكلمة] | [الرد]\nانسى [الكلمة]\nالردود\nإيقاف\nتشغيل`;
                await sock.sendMessage(sender, { text: menu }); return;
            }
            if (rawPrompt === 'إيقاف' || rawPrompt === 'ايقاف') { isBotActive = false; await sock.sendMessage(sender, { text: '❌ تم الإيقاف.' }); return; }
            if (rawPrompt === 'تشغيل') { isBotActive = true; await sock.sendMessage(sender, { text: '✅ تم التشغيل.' }); return; }
            if (rawPrompt === 'الردود') {
                if (customReplies.length === 0) { await sock.sendMessage(sender, { text: 'لا توجد ردود.' }); return; }
                let msgText = '*الردود:*\n'; customReplies.forEach((r, i) => msgText += `${i+1}. ${r.trigger} -> ${r.reply}\n`);
                await sock.sendMessage(sender, { text: msgText }); return;
            }
            if (rawPrompt.startsWith('علمني ')) {
                const data = rawPrompt.replace('علمني ', '').split('|');
                if (data.length < 2) return;
                customReplies = customReplies.filter(r => r.trigger !== data[0].trim());
                customReplies.push({ trigger: data[0].trim(), reply: data[1].trim() }); saveReplies();
                await sock.sendMessage(sender, { text: `✅ تم الحفظ!` }); return;
            }
            if (rawPrompt.startsWith('انسى ')) {
                const target = rawPrompt.replace('انسى ', '').trim();
                customReplies = customReplies.filter(r => r.trigger !== target); saveReplies();
                await sock.sendMessage(sender, { text: `🗑️ تم المسح.` }); return;
            }
        }

        if (isFromMe || (isGroup && !rawPrompt.toLowerCase().includes('يا بوت'))) return;
        if (!isBotActive && !isAdmin) return; 

        const finalPromptText = isGroup ? rawPrompt.replace(/^يا بوت/i, '').trim() : rawPrompt;
        if (!finalPromptText) return; 
        
        // منع الكلمات الإدارية من الذهاب للذكاء الاصطناعي
        if (isAdmin && (finalPromptText === 'المدير' || finalPromptText === 'تحكم' || finalPromptText === 'الردود' || finalPromptText === 'إيقاف' || finalPromptText === 'تشغيل')) return;

        try {
            if (!isGroup) { await sock.readMessages([msg.key]); }

            const foundCustomReply = customReplies.find(r => finalPromptText.includes(r.trigger));
            if (foundCustomReply) {
                await simulateTypingAndSend(sock, sender, foundCustomReply.reply, isGroup ? msg : null);
                return; 
            }

            let aiReply;
            try {
                aiReply = await executeGroqAI(sender, finalPromptText);
            } catch (error) {
                if (error.code === 'ECONNABORTED' || (error.response && error.response.status === 429)) {
                    pendingQueue.push({ sender, text: finalPromptText, isGroup, timestamp: Date.now() }); saveQueue();
                    return; 
                } else { throw error; }
            }

            const wantsVoice = finalPromptText.includes('صوت') || finalPromptText.includes('تكلم') || finalPromptText.includes('اسمعني') || finalPromptText.includes('غني');
            
            if (wantsVoice && !isGroup) {
                await sock.sendMessage(sender, { text: "🎙️ ثواني..." });
                await sock.sendPresenceUpdate('recording', sender); 
                
                const clonedAudio = await generateDirectVoice(aiReply);
                
                if (clonedAudio === "QUOTA_EXCEEDED") {
                    await sock.sendMessage(sender, { text: "يا صاحبي رصيدي في سيرفر الصوت خلص 😅، لازم تجدد مفتاح (ElevenLabs) عشان أقدر أسجل صوت تاني. خذ الرد كتابة مؤقتاً:\n\n" + aiReply }, { quoted: msg });
                } else if (clonedAudio && fs.existsSync(clonedAudio)) {
                    await sock.sendMessage(sender, { audio: { url: clonedAudio }, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
                    fs.unlinkSync(clonedAudio); 
                }
            } else {
                await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null);
            }

        } catch (error) { console.error('خطأ:', error.message); }
    });
}
connectToWhatsApp();
