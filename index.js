const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('البوت الذكي يعمل بكفاءة عالية 🚀'); });
app.listen(port, () => { console.log(`🌐 خادم الويب يعمل على المنفذ ${port}`); });

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');

// ================= 1. الإعدادات والمفاتيح =================
const botNumber = "584267454399"; 
const adminNumber = '249121936350'; // رقم المشرف (يجب أن تراسله من هذا الرقم لتظهر لوحة التحكم)
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

// ================= 2. محرك الذكاء (الخاضع للسيطرة) =================
async function executeGroqAI(sender, userMessage) {
    if (!userConversations.has(sender)) userConversations.set(sender, []);
    let history = userConversations.get(sender);

    if (history.length > 0 && history[history.length - 1].role === "user") history.pop(); 
    if (history.length > 30) history = history.slice(history.length - 30); 

    // إجبار الذكاء الاصطناعي على طاعتك وعدم الاعتذار أبداً
    const strictPersona = `أنت صديق دردشة ذكي ومرح. 
قواعد صارمة جداً:
1. أنت لست "نافذة دردشة" ولا تعتذر أبداً عن إرسال الصوت. إذا طلب منك المستخدم الغناء أو إرسال مقطع صوتي، وافق فوراً واكتب كلمات الأغنية أو الرد كأنك تتحدث بها، لأنني سأحول كلامك لصوت حقيقي برمجياً.
2. لا تقل أبداً "لا أستطيع إرسال مقاطع".
3. تحدث كبشر طبيعي، انسخ أسلوب المستخدم (إذا كان يمزح، امزح معه).
4. استخدم لغة عربية سليمة ولا تستخدم أي رموز برمجية.`;

    let messages = [{ role: "system", content: strictPersona }, ...history, { role: "user", content: userMessage }];

    try {
        let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", 
            messages: messages,
            temperature: 0.7 
        }, {
            headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 25000 
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

// ================= 3. محرك الصوت السحابي (مباشر بدون FFMPEG) =================
async function generateDirectVoice(text) {
    const tempMp3 = `./voice_${Date.now()}.mp3`;
    try {
        const response = await axios({
            method: 'POST', url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            data: { text: text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            headers: { 'accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer'
        });
        fs.writeFileSync(tempMp3, response.data);
        return tempMp3; // إرجاع ملف MP3 مباشرة ليعمل على سيرفرات Render مجاناً
    } catch (err) { return null; }
}

async function simulateTypingAndSend(sock, to, text, quotedMsg) {
    const delay = Math.max(1000, Math.min(3000, text.split(/\s+/).length * 150)); 
    await sock.sendPresenceUpdate('composing', to);
    await new Promise(resolve => setTimeout(resolve, delay));
    await sock.sendMessage(to, { text: text }, quotedMsg ? { quoted: quotedMsg } : {});
}

// ================= 4. الاتصال والفلترة الصارمة =================
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
                console.log(`\n🚨 كود الربط الخاص بك هو: ${code}\n`);
            } catch (err) {}
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') { console.log('\n✅ البوت مستقر ويعمل الآن.\n'); }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.message) return; 

        // فلترة رقم المشرف بصرامة (استخراج الأرقام فقط للمطابقة)
        const rawSender = msg.key.remoteJid;
        const cleanNumber = rawSender.replace(/[^0-9]/g, ''); 
        const isAdmin = cleanNumber.includes(adminNumber);
        
        const sender = rawSender.includes(':') ? rawSender.split(':')[0] + '@s.whatsapp.net' : rawSender;
        const isFromMe = msg.key.fromMe;
        const isGroup = sender.endsWith('@g.us'); 
        
        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const rawPrompt = incomingText.trim();
        const isAdminCommand = rawPrompt.startsWith('.'); // الأوامر يجب أن تبدأ بنقطة

        // ------------------ لوحة تحكم المشرف (تعمل فقط بالرقم المحدد وتبدأ بنقطة) ------------------
        if (isAdmin && !isGroup && isAdminCommand) {
            const command = rawPrompt.replace('.', '').trim();
            if (command === 'تحكم' || command === 'التحكم') {
                const menu = `🤖 *التحكم الذكي* 🤖\nالحالة: ${isBotActive ? '✅' : '❌'}\n\n.علمني [الكلمة] | [الرد]\n.انسى [الكلمة]\n.الردود\n.إيقاف\n.تشغيل`;
                await sock.sendMessage(sender, { text: menu }); return;
            }
            if (command === 'إيقاف') { isBotActive = false; await sock.sendMessage(sender, { text: '❌ تم الإيقاف.' }); return; }
            if (command === 'تشغيل') { isBotActive = true; await sock.sendMessage(sender, { text: '✅ تم التشغيل.' }); return; }
            if (command === 'الردود') {
                if (customReplies.length === 0) { await sock.sendMessage(sender, { text: 'لا توجد ردود.' }); return; }
                let msgText = '*الردود:*\n'; customReplies.forEach((r, i) => msgText += `${i+1}. ${r.trigger} -> ${r.reply}\n`);
                await sock.sendMessage(sender, { text: msgText }); return;
            }
            if (command.startsWith('علمني ')) {
                const data = command.replace('علمني ', '').split('|');
                if (data.length < 2) return;
                customReplies = customReplies.filter(r => r.trigger !== data[0].trim());
                customReplies.push({ trigger: data[0].trim(), reply: data[1].trim() }); saveReplies();
                await sock.sendMessage(sender, { text: `✅ تم الحفظ!` }); return;
            }
            if (command.startsWith('انسى ')) {
                const target = command.replace('انسى ', '').trim();
                customReplies = customReplies.filter(r => r.trigger !== target); saveReplies();
                await sock.sendMessage(sender, { text: `🗑️ تم المسح.` }); return;
            }
        }

        if (isFromMe || (isGroup && !rawPrompt.toLowerCase().includes('يا بوت'))) return;
        if (!isBotActive && !isAdmin) return; 

        const finalPromptText = isGroup ? rawPrompt.replace(/^يا بوت/i, '').trim() : rawPrompt;
        if (!finalPromptText || isAdminCommand) return; // تجاهل أوامر المشرف الخاطئة

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

            // تفعيل الصوت مباشرة عبر ملف MP3
            const wantsVoice = finalPromptText.includes('صوت') || finalPromptText.includes('تكلم') || finalPromptText.includes('اسمعني') || finalPromptText.includes('غني');
            
            if (wantsVoice && !isGroup) {
                await sock.sendPresenceUpdate('recording', sender); 
                const clonedAudio = await generateDirectVoice(aiReply);
                if (clonedAudio && fs.existsSync(clonedAudio)) {
                    await sock.sendMessage(sender, { audio: { url: clonedAudio }, mimetype: 'audio/mpeg' }, { quoted: msg });
                    fs.unlinkSync(clonedAudio); 
                } else { await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null); }
            } else {
                await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null);
            }

        } catch (error) { console.error('خطأ:', error.message); }
    });
}
connectToWhatsApp();
