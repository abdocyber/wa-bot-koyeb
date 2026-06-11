const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');

// ================= 1. الإعدادات الأساسية =================
const botNumber = "584267454399"; 
const adminNumber = '249121936350'; 
const GROQ_API_KEY = "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"; 
const ELEVENLABS_API_KEY = "2afb99725e888cd50cac9dc774db408a3a1a05a4c8ab1aa128fb3aacc5121715"; 
const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

let globalSock = null; 
const userConversations = new Map();
let isBotActive = true; 

// ================= 2. قاعدة بيانات التعلم =================
const repliesFile = './custom_replies.json';
let customReplies = fs.existsSync(repliesFile) ? JSON.parse(fs.readFileSync(repliesFile, 'utf8')) : [];
function saveReplies() { fs.writeFileSync(repliesFile, JSON.stringify(customReplies, null, 2)); }

const queueFile = './pending_questions.json';
let pendingQueue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
function saveQueue() { fs.writeFileSync(queueFile, JSON.stringify(pendingQueue, null, 2)); }

// ================= 3. محرك الذكاء الاصطناعي (مضاد للهلوسة) =================
async function executeGroqAI(sender, userMessage) {
    if (!userConversations.has(sender)) userConversations.set(sender, []);
    let history = userConversations.get(sender);

    if (history.length > 0 && history[history.length - 1].role === "user") history.pop(); 
    if (history.length > 30) history = history.slice(history.length - 30); 

    const smartPersona = `أنت صديق دردشة ووكيل ذكي جداً، عفوي، ومريح في التعامل.
قواعدك الأساسية والصارمة:
1. تحدث باللغة العربية فقط. يمنع منعاً باتاً استخدام لغات أخرى (كالصينية أو الإنجليزية) أو أي رموز غريبة.
2. اقرأ سياق المحادثة السابقة جيداً وانسخ أسلوب المستخدم: إذا مزح فامزح، وإذا سأل سؤالاً جدياً فأجب بجدية واحترافية.
3. تجنب الردود الطويلة جداً والمملة، كن مباشرة وطبيعياً كأنك إنسان يدردش على واتساب.
4. إذا طلب منك التحدث عن شيء خارج العمل، دردش معه بكل أريحية وذكاء.
5. لا تقل أبداً أنك ذكاء اصطناعي، ولا تستخدم أي أقواس برمجية في ردودك.`;

    let messages = [{ role: "system", content: smartPersona }, ...history, { role: "user", content: userMessage }];

    try {
        let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", 
            messages: messages,
            temperature: 0.6 
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
            console.log(`[زحام] تأجيل الإرسال...`);
        } else { pendingQueue.shift(); saveQueue(); }
    }
}, 60000);

// ================= 4. محرك الصوت والإرسال =================
async function generateClonedVoice(text, outputFile) {
    const tempMp3 = `./temp_voice_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp3`;
    try {
        const response = await axios({
            method: 'POST', url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            data: { text: text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            headers: { 'accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(tempMp3, response.data);
        return new Promise((resolve) => {
            exec(`ffmpeg -y -i ${tempMp3} -c:a libopus ${outputFile}`, (error) => {
                if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); resolve(error ? null : outputFile);
            });
        });
    } catch (err) { if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); return null; }
}

async function simulateTypingAndSend(sock, to, text, quotedMsg) {
    const delay = Math.max(1000, Math.min(3500, text.split(/\s+/).length * 150)); 
    await sock.sendPresenceUpdate('composing', to);
    await new Promise(resolve => setTimeout(resolve, delay));
    await sock.sendMessage(to, { text: text }, quotedMsg ? { quoted: quotedMsg } : {});
}

// ================= 5. الاتصال القوي وإدارة الأوامر =================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, 
        browser: ['Ubuntu', 'Chrome', '20.0.04'], 
        logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000, 
        markOnlineOnConnect: true
    });
    globalSock = sock; 

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const phoneNumber = botNumber.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n======================================================`);
                console.log(`🚨 كود الربط الخاص بك هو: ${code}`);
                console.log(`======================================================\n`);
            } catch (err) {}
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('\n✅ تم الربط بنجاح! البوت مستقر وجاهز للعمل.\n');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message) return; 

        let rawSender = msg.key.remoteJid;
        const sender = rawSender.includes(':') ? rawSender.split(':')[0] + '@s.whatsapp.net' : rawSender;
        const isAdmin = sender.includes(adminNumber);
        
        const isFromMe = msg.key.fromMe;
        const isGroup = sender.endsWith('@g.us'); 
        
        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const rawPrompt = incomingText.trim();
        const normalizedPrompt = rawPrompt.replace(/^\./, '').trim(); 

        // ------------------ لوحة تحكم المشرف ------------------
        if (isAdmin && !isGroup) {
            if (normalizedPrompt === 'التحكم' || normalizedPrompt === 'تحكم') {
                const menu = `🤖 *لوحة التحكم الذكية* 🤖\n\nحالة البوت: ${isBotActive ? '✅ يعمل' : '❌ متوقف'}\n\n🎓 *للتعليم السريع:*\nعلمني [الكلمة] | [الرد]\n\n🗑️ *للحذف:*\nانسى [الكلمة]\n\n📋 *لعرض الردود:*\nالردود\n\n⏸️ *لإيقاف الذكاء الاصطناعي:*\nإيقاف\n\n▶️ *للتشغيل:*\nتشغيل`;
                await sock.sendMessage(sender, { text: menu }); return;
            }
            if (normalizedPrompt === 'إيقاف' || normalizedPrompt === 'ايقاف') { isBotActive = false; await sock.sendMessage(sender, { text: '❌ تم الإيقاف.' }); return; }
            if (normalizedPrompt === 'تشغيل') { isBotActive = true; await sock.sendMessage(sender, { text: '✅ تم التشغيل.' }); return; }
            
            if (normalizedPrompt === 'الردود') {
                if (customReplies.length === 0) { await sock.sendMessage(sender, { text: 'لا توجد ردود محفوظة.' }); return; }
                let msgText = '*🧠 الردود اليدوية:*\n\n';
                customReplies.forEach((r, i) => msgText += `${i+1}. إذا قال: *${r.trigger}*\nأرد: ${r.reply}\n\n`);
                await sock.sendMessage(sender, { text: msgText }); return;
            }

            if (normalizedPrompt.startsWith('علمني ')) {
                const cleanDataString = normalizedPrompt.replace(/^علمني\s+/, '');
                const data = cleanDataString.split('|');
                if (data.length < 2) { await sock.sendMessage(sender, { text: '⚠️ استخدم: علمني الكلمة | الرد' }); return; }
                customReplies = customReplies.filter(r => r.trigger !== data[0].trim());
                customReplies.push({ trigger: data[0].trim(), reply: data[1].trim() });
                saveReplies();
                await sock.sendMessage(sender, { text: `✅ تم الحفظ بنجاح!` }); return;
            }

            if (normalizedPrompt.startsWith('انسى ') || normalizedPrompt.startsWith('إنسى ')) {
                const targetTrigger = normalizedPrompt.replace(/^انسى\s+|^إنسى\s+/, '').trim();
                customReplies = customReplies.filter(r => r.trigger !== targetTrigger);
                saveReplies();
                await sock.sendMessage(sender, { text: `🗑️ تم مسح الكلمة.` }); return;
            }
        }

        if (isFromMe || (isGroup && !rawPrompt.toLowerCase().includes('يا بوت'))) return;
        if (!isBotActive && !isAdmin) return; 

        const finalPromptText = isGroup ? rawPrompt.replace(/^يا بوت/i, '').trim() : rawPrompt;
        if (!finalPromptText) return;

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

            const wantsVoice = finalPromptText.includes('صوت') || finalPromptText.includes('تكلم') || finalPromptText.includes('اسمعني');
            
            if (wantsVoice && !isGroup) {
                const outputOgg = `./voice_${Date.now()}.ogg`;
                await sock.sendPresenceUpdate('recording', sender); 
                const clonedAudio = await generateClonedVoice(aiReply, outputOgg);
                if (clonedAudio && fs.existsSync(clonedAudio)) {
                    await sock.sendMessage(sender, { audio: { url: clonedAudio }, mimetype: 'audio/mp4', ptt: true }, isGroup ? { quoted: msg } : {});
                    fs.unlinkSync(clonedAudio); 
                } else { await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null); }
            } else {
                await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null);
            }

        } catch (error) { console.error('خطأ في معالجة الرسالة:', error.message); }
    });
}
connectToWhatsApp();
