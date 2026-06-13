const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => { res.send('مصفوفة البوتات المتعددة تعمل بكفاءة سحابية 🚀'); });
app.listen(port, () => { console.log(`🌐 خادم الويب يعمل على المنفذ ${port}`); });

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');

// ================= 1. الإعدادات الأساسية والمفاتيح =================
const adminNumber = '249121936350'; 
const GROQ_API_KEY = "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"; 
const ELEVENLABS_API_KEY = "2afb99725e888cd50cac9dc774db408a3a1a05a4c8ab1aa128fb3aacc5121715"; 
const ELEVENLABS_VOICE_ID = "jAAHNNqlbAX9iWjJPEtE"; 

const activeSocks = new Map(); 
const userConversations = new Map();
const lastUserQuestion = new Map(); 

let isBotActive = true; 
let selfLearnEnabled = true;

const numbersFile = './connected_numbers.json';
let connectedNumbers = fs.existsSync(numbersFile) ? JSON.parse(fs.readFileSync(numbersFile, 'utf8')) : [];
function saveNumbers() { fs.writeFileSync(numbersFile, JSON.stringify(connectedNumbers, null, 2)); }

const repliesFile = './custom_replies.json';
let customReplies = fs.existsSync(repliesFile) ? JSON.parse(fs.readFileSync(repliesFile, 'utf8')) : [];
function saveReplies() { fs.writeFileSync(repliesFile, JSON.stringify(customReplies, null, 2)); }

const queueFile = './pending_questions.json';
let pendingQueue = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
function saveQueue() { fs.writeFileSync(queueFile, JSON.stringify(pendingQueue, null, 2)); }

// ================= 2. دالة حساب التشابه =================
function getSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().replace(/\s+/g, '');
    const s2 = str2.toLowerCase().replace(/\s+/g, '');
    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) return 0.0;
    
    const bigrams1 = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
        const bigram = s1.substr(i, 2);
        bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
    }
    
    let intersection = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bigram = s2.substr(i, 2);
        if (bigrams1.has(bigram) && bigrams1.get(bigram) > 0) {
            intersection++;
            bigrams1.set(bigram, bigrams1.get(bigram) - 1);
        }
    }
    return (2.0 * intersection) / (s1.length + s2.length - 2);
}

// ================= 3. التعلم الذاتي =================
function learnManualQA(question, answer) {
    if (!selfLearnEnabled || !question || !answer) return;
    let learned = fs.existsSync('./learned_qa.json') ? JSON.parse(fs.readFileSync('./learned_qa.json', 'utf8')) : [];
    let found = false;
    for (let item of learned) {
        if (getSimilarity(item.question, question) > 0.85) {
            item.answer = answer; found = true; break;
        }
    }
    if (!found) learned.push({ question, answer, usageCount: 1 });
    learned.sort((a, b) => b.usageCount - a.usageCount);
    if (learned.length > 500) learned = learned.slice(0, 500);
    fs.writeFileSync('./learned_qa.json', JSON.stringify(learned, null, 2));
}

function checkLearnedQA(question) {
    if (!fs.existsSync('./learned_qa.json')) return null;
    let learned = JSON.parse(fs.readFileSync('./learned_qa.json', 'utf8'));
    for (let item of learned) {
        if (getSimilarity(item.question, question) > 0.80) {
            item.usageCount++;
            fs.writeFileSync('./learned_qa.json', JSON.stringify(learned, null, 2));
            return item.answer;
        }
    }
    return null;
}

function getOwnerStyleGuide() {
    if (!fs.existsSync('./learned_qa.json')) return "";
    let learned = JSON.parse(fs.readFileSync('./learned_qa.json', 'utf8'));
    if (learned.length === 0) return "";
    let samples = learned.slice(0, 10).map(item => `- سأل العميل: "${item.question}" -> فكان ردك: "${item.answer}"`).join('\n');
    return `\nدليل إرشادي لنبرة الحساب الحقيقي:\n${samples}`;
}

function trackChat(jid) {
    if (!jid || jid.endsWith('@g.us')) return; 
    let chats = fs.existsSync('./known_chats.json') ? JSON.parse(fs.readFileSync('./known_chats.json', 'utf8')) : [];
    if (!chats.includes(jid)) {
        chats.push(jid);
        fs.writeFileSync('./known_chats.json', JSON.stringify(chats, null, 2));
    }
}

// ================= 4. محرك الذكاء الاصطناعي =================
async function executeGroqAI(sender, userMessage) {
    if (!userConversations.has(sender)) userConversations.set(sender, []);
    let history = userConversations.get(sender);

    if (history.length > 0 && history[history.length - 1].role === "user") history.pop(); 
    if (history.length > 20) history = history.slice(history.length - 20); 

    const LONG_ANSWER_HINTS = ['اشرح', 'تفصيل', 'قصة', 'أغنية', 'اغنيه', 'غني', 'وصف', 'وضح', 'لماذا', 'كيف'];
    const needsLongAnswer = LONG_ANSWER_HINTS.some(hint => userMessage.toLowerCase().includes(hint));
    const maxTokens = needsLongAnswer ? 1024 : 200;

    const ownerStyleGuide = getOwnerStyleGuide();

    const strictPersona = `أنت صديق دردشة بشري حقيقي وعفوي يدردش مع أصحابه على الواتساب.
1. ردودك قصيرة جداً ومباشرة (سطر أو سطرين فقط).
2. تحدث بلهجة عربية عامية وعفوية تماماً تطابق السائل.
3. ممنوع نهائياً كتابة مؤثرات بين أقواس مثل (يضحك) أو (صوت).
4. لا تعتذر عن إرسال الصوتيات، اكتب الكلمات مباشرة وسيتولى النظام تحويلها.
${ownerStyleGuide}`;

    let messages = [{ role: "system", content: strictPersona }, ...history, { role: "user", content: userMessage }];

    try {
        let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", messages, temperature: 0.75, max_tokens: maxTokens
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        const aiReply = response.data.choices[0].message.content.trim();
        history.push({ role: "user", content: userMessage });
        history.push({ role: "assistant", content: aiReply });
        return aiReply;
    } catch (error) { throw error; }
}

// ================= 5. الصوتيات والبث =================
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
        fs.writeFileSync(tempMp3, response.data); return tempMp3; 
    } catch (err) { return "QUOTA_EXCEEDED"; }
}

async function simulateTypingAndSend(sock, to, text, quotedMsg) {
    const delay = Math.max(1000, Math.min(3000, text.split(/\s+/).length * 150)); 
    await sock.sendPresenceUpdate('composing', to);
    await new Promise(resolve => setTimeout(resolve, delay));
    await sock.sendMessage(to, { text: text }, quotedMsg ? { quoted: quotedMsg } : {});
}

async function executeBroadcast(sock, message) {
    if (!fs.existsSync('./known_chats.json')) return { success: 0, total: 0 };
    let chats = JSON.parse(fs.readFileSync('./known_chats.json', 'utf8'));
    let successCount = 0;
    for (let chat of chats) {
        try {
            await new Promise(resolve => setTimeout(resolve, 3500));
            await sock.sendMessage(chat, { text: message }); successCount++;
        } catch (err) { }
    }
    return { success: successCount, total: chats.length };
}

// ================= 6. الجلسات المتعددة وفلاتر الحماية =================
async function connectInstance(phoneNumber, notifyJid = null) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFolder = `auth_info_${cleanNumber}`;
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({
        auth: state, printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '20.0.04'], logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000, markOnlineOnConnect: true
    });

    activeSocks.set(cleanNumber, sock);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(cleanNumber);
                
                // طباعة الكود دائماً في سجلات Render كنسخة احتياطية
                console.log(`\n======================================================`);
                console.log(`🚨 كود الربط للرقم [${cleanNumber}] هو: ${code} 🚨`);
                console.log(`======================================================\n`);

                if (notifyJid) {
                    // البحث عن أي حساب واتساب متصل ونشط حالياً لإرسال الكود من خلاله
                    let connectedSock = null;
                    for (let [num, activeSock] of activeSocks.entries()) {
                        if (activeSock.authState.creds.registered) {
                            connectedSock = activeSock;
                            break;
                        }
                    }

                    if (connectedSock) {
                        await connectedSock.sendMessage(notifyJid, {
                            text: `🔑 *كود الربط للحساب:* \nالرقم: \`${cleanNumber}\`\nالكود: *${code}*`
                        });
                        console.log('✅ تم إرسال كود الربط إلى رقم المشرف عبر الواتساب.');
                    } else {
                        console.log('⚠️ ملاحظة: لا يوجد أي حساب واتساب متصل حالياً لإرسال الكود إليه! (هذا هو الحساب الأول). يرجى نسخ الكود من السجلات أعلاه.');
                    }
                }
            } catch (err) { 
                console.log(`❌ خطأ في توليد كود الربط:`, err.message); 
            }
        }, 6000); // المهلة المطلوبة لاستخراج الكود
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectInstance(cleanNumber);
        } else if (connection === 'open') {
            if (!connectedNumbers.includes(cleanNumber)) {
                connectedNumbers.push(cleanNumber); saveNumbers();
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0]; if (!msg.message) return; 

        const rawSender = msg.key.remoteJid;
        const senderNumber = rawSender.replace(/[^0-9]/g, ''); 
        const isAdmin = senderNumber.includes(adminNumber);
        
        const sender = rawSender.includes(':') ? rawSender.split(':')[0] + '@s.whatsapp.net' : rawSender;
        const isFromMe = msg.key.fromMe;
        const isGroup = rawSender.endsWith('@g.us'); 
        
        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const rawPrompt = incomingText.trim();

        if (isFromMe && !isGroup) {
            const lastQuestion = lastUserQuestion.get(sender);
            if (lastQuestion && rawPrompt) { learnManualQA(lastQuestion, rawPrompt); lastUserQuestion.delete(sender); }
            return;
        }

        if (!isGroup && !isFromMe) { trackChat(sender); lastUserQuestion.set(sender, rawPrompt); }

        if (isAdmin && !isGroup) {
            if (rawPrompt === 'المدير' || rawPrompt === 'تحكم' || rawPrompt === 'لوحة التحكم') {
                let learnedCount = fs.existsSync('./learned_qa.json') ? JSON.parse(fs.readFileSync('./learned_qa.json', 'utf8')).length : 0;
                const menu = `🛠️ *لوحة التحكم* 🛠️\nالحالة: ${isBotActive ? '✅' : '❌'}\nالتعلم: ${selfLearnEnabled ? '🔄' : '⏸️'}\nالردود: *${learnedCount}*\n\n1: تشغيل | 2: إيقاف\n3: تفعيل التعلم | 4: إيقاف التعلم\n5: تصفير الذاكرة\n\nاضافة [الرقم]\nاذاعة [الرسالة]\nعلمني [السؤال]|[الرد]\nانسى [الكلمة]`;
                await sock.sendMessage(sender, { text: menu }); return;
            }
            if (rawPrompt === '1') { isBotActive = true; await sock.sendMessage(sender, { text: '✅ تشغيل' }); return; }
            if (rawPrompt === '2') { isBotActive = false; await sock.sendMessage(sender, { text: '❌ إيقاف' }); return; }
            if (rawPrompt === '3') { selfLearnEnabled = true; await sock.sendMessage(sender, { text: '🔄 تعلم مفعل' }); return; }
            if (rawPrompt === '4') { selfLearnEnabled = false; await sock.sendMessage(sender, { text: '⏸️ تعلم متوقف' }); return; }
            if (rawPrompt === '5') { fs.writeFileSync('./learned_qa.json', JSON.stringify([], null, 2)); await sock.sendMessage(sender, { text: '🗑️ مسح الذاكرة' }); return; }
            if (rawPrompt.startsWith('اضافة ')) { connectInstance(rawPrompt.replace('اضافة ', '').replace(/[^0-9]/g, ''), sender); return; }
            if (rawPrompt.startsWith('اذاعة ')) { executeBroadcast(sock, rawPrompt.replace('اذاعة ', '').trim()); await sock.sendMessage(sender, { text: `📢 جاري البث...` }); return; }
            if (rawPrompt.startsWith('علمني ')) {
                const data = rawPrompt.replace('علمني ', '').split('|'); if (data.length < 2) return;
                customReplies = customReplies.filter(r => r.trigger !== data[0].trim());
                customReplies.push({ trigger: data[0].trim(), reply: data[1].trim() }); saveReplies();
                await sock.sendMessage(sender, { text: `✅ تم` }); return;
            }
            if (rawPrompt.startsWith('انسى ')) {
                customReplies = customReplies.filter(r => r.trigger !== rawPrompt.replace('انسى ', '').trim()); saveReplies();
                await sock.sendMessage(sender, { text: `🗑️ مسح` }); return;
            }
        }

        if (isFromMe || (!isBotActive && !isAdmin)) return; 

        if (isGroup) {
            const botMentioned = rawPrompt.includes('@' + cleanNumber) || rawPrompt.toLowerCase().includes('بوت') || msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(cleanNumber + '@s.whatsapp.net');
            const isReplyToMe = msg.message.extendedTextMessage?.contextInfo?.participant === cleanNumber + '@s.whatsapp.net';
            if (!botMentioned && !isReplyToMe) return; 
        }

        const finalPromptText = isGroup ? rawPrompt.replace(/@\d+\s*|يا بوت\s*|بوت\s*/gi, '').trim() : rawPrompt;
        if (!finalPromptText) return;

        if (isAdmin && ['المدير', 'تحكم', '1', '2', '3', '4', '5'].includes(finalPromptText)) return;

        // 🛡️ الفلاتر وتأخير الرد للمستخدمين العاديين فقط 
        if (!isAdmin) {
            const textLength = finalPromptText.replace(/\s+/g, '').length;
            if (textLength < 3) return;

            const hasLettersOrNumbers = /[\p{L}\p{N}]/u.test(finalPromptText);
            if (!hasLettersOrNumbers) return;

            await new Promise(resolve => setTimeout(resolve, 20000));
        }

        try {
            if (!isGroup) { await sock.readMessages([msg.key]); }

            const foundCustomReply = customReplies.find(r => finalPromptText.includes(r.trigger));
            if (foundCustomReply) { await simulateTypingAndSend(sock, sender, foundCustomReply.reply, isGroup ? msg : null); return; }

            const learnedAnswer = checkLearnedQA(finalPromptText);
            if (learnedAnswer) { await simulateTypingAndSend(sock, sender, learnedAnswer, isGroup ? msg : null); return; }

            let aiReply;
            try { aiReply = await executeGroqAI(sender, finalPromptText); } catch (error) {
                if (error.code === 'ECONNABORTED' || (error.response && error.response.status === 429)) {
                    pendingQueue.push({ sender, text: finalPromptText, isGroup, timestamp: Date.now() }); saveQueue(); return; 
                } else { throw error; }
            }

            const wantsVoice = finalPromptText.includes('صوت') || finalPromptText.includes('تكلم') || finalPromptText.includes('اسمعني') || finalPromptText.includes('غني');
            if (wantsVoice && !isGroup) {
                await sock.sendMessage(sender, { text: "🎙️ ثواني..." });
                await sock.sendPresenceUpdate('recording', sender); 
                const clonedAudio = await generateDirectVoice(aiReply);
                if (clonedAudio === "QUOTA_EXCEEDED") {
                    await sock.sendMessage(sender, { text: aiReply }, { quoted: msg });
                } else if (clonedAudio && fs.existsSync(clonedAudio)) {
                    await sock.sendMessage(sender, { audio: { url: clonedAudio }, mimetype: 'audio/mpeg', ptt: true }, { quoted: msg });
                    fs.unlinkSync(clonedAudio); 
                }
            } else { await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null); }
        } catch (error) { console.error('خطأ:', error.message); }
    });
}

async function initMatrix() {
    if (connectedNumbers.length === 0) { connectedNumbers.push('584267454399'); saveNumbers(); }
    for (let number of connectedNumbers) {
        console.log(`⏳ جاري إقلاع خادم الرقم: [${number}]...`);
        // إرسال كود الإقلاع الأول للمشرف (سيتم إرساله فقط إذا كان هناك حساب متصل)
        await connectInstance(number, adminNumber + '@s.whatsapp.net');
    }
}
initMatrix();
