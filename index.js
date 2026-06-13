const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// ================= 1. خادم الويب والمراقبة =================
app.get('/', (req, res) => { res.send('مصفوفة البوتات المتعددة تعمل بكفاءة سحابية 🚀'); });
app.listen(port, () => { console.log(`🌐 خادم الويب يعمل على المنفذ ${port}`); });

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const path = require('path');

// ================= 2. الإعدادات الأساسية والمفاتيح =================
const GROQ_API_KEY = "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"; 
const ELEVENLABS_API_KEY = "2afb99725e888cd50cac9dc774db408a3a1a05a4c8ab1aa128fb3aacc5121715"; 
const ELEVENLABS_VOICE_ID = "jAAHNNqlbAX9iWjJPEtE"; 

const activeSocks = new Map(); 
const userConversations = new Map();
const lastUserQuestion = new Map(); 

let isBotActive = true; 
let selfLearnEnabled = true;

// 🛡️ نظام إدارة البيانات
const DATA_DIR = './data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const loadJSON = (file, defaultData) => {
    const filePath = path.join(DATA_DIR, file);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : defaultData;
};
const saveJSON = (file, data) => fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));

let adminNumbers = loadJSON('admins.json', ['249121936350']);
let connectedNumbers = loadJSON('connected_numbers.json', []);
let customReplies = loadJSON('custom_replies.json', []);
let pendingQueue = loadJSON('pending_queue.json', []);
let learnedQA = loadJSON('learned_qa.json', []);
let knownChats = loadJSON('known_chats.json', []);

// ================= 3. دالة حساب التشابه والتعلم =================
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

function learnManualQA(question, answer) {
    if (!selfLearnEnabled || !question || !answer) return;
    let found = false;
    for (let item of learnedQA) {
        if (getSimilarity(item.question, question) > 0.85) {
            item.answer = answer; found = true; break;
        }
    }
    if (!found) learnedQA.push({ question, answer, usageCount: 1 });
    learnedQA.sort((a, b) => b.usageCount - a.usageCount);
    if (learnedQA.length > 500) learnedQA = learnedQA.slice(0, 500);
    saveJSON('learned_qa.json', learnedQA);
}

function checkLearnedQA(question) {
    for (let item of learnedQA) {
        if (getSimilarity(item.question, question) > 0.80) {
            item.usageCount++;
            saveJSON('learned_qa.json', learnedQA);
            return item.answer;
        }
    }
    return null;
}

// ================= 4. محرك الذكاء الاصطناعي والصوت =================
async function executeGroqAI(sender, userMessage) {
    if (!userConversations.has(sender)) userConversations.set(sender, []);
    let history = userConversations.get(sender);

    if (history.length > 0 && history[history.length - 1].role === "user") history.pop(); 
    if (history.length > 20) history = history.slice(history.length - 20); 

    const LONG_ANSWER_HINTS = ['اشرح', 'تفصيل', 'قصة', 'أغنية', 'اغنيه', 'غني', 'وصف', 'وضح', 'لماذا', 'كيف'];
    const needsLongAnswer = LONG_ANSWER_HINTS.some(hint => userMessage.toLowerCase().includes(hint));
    
    let samples = learnedQA.slice(0, 10).map(item => `- سأل العميل: "${item.question}" -> فكان ردك: "${item.answer}"`).join('\n');
    const ownerStyleGuide = samples ? `\nدليل إرشادي لنبرة الحساب الحقيقي:\n${samples}` : "";

    const strictPersona = `أنت صديق دردشة بشري حقيقي وعفوي يدردش مع أصحابه على الواتساب.\n1. ردودك قصيرة جداً ومباشرة (سطر أو سطرين فقط).\n2. تحدث بلهجة عربية عامية وعفوية تماماً تطابق السائل.\n3. ممنوع نهائياً كتابة مؤثرات بين أقواس مثل (يضحك) أو (صوت).\n4. لا تعتذر عن إرسال الصوتيات، اكتب الكلمات مباشرة وسيتولى النظام تحويلها.\n${ownerStyleGuide}`;

    let messages = [{ role: "system", content: strictPersona }, ...history, { role: "user", content: userMessage }];

    try {
        let response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", messages, temperature: 0.75, max_tokens: needsLongAnswer ? 1024 : 200
        }, { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 });
        const aiReply = response.data.choices[0].message.content.trim();
        history.push({ role: "user", content: userMessage });
        history.push({ role: "assistant", content: aiReply });
        return aiReply;
    } catch (error) { throw error; }
}

async function generateAndSendVoice(sock, to, text, quotedMsg) {
    const cleanText = text.replace(/[\(\[].*?[\)\]]/g, '').trim(); 
    try {
        const response = await axios({
            method: 'POST', url: `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
            data: { text: cleanText, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
            headers: { 'accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer'
        });
        
        const tempMp3 = path.join(DATA_DIR, `voice_${Date.now()}.mp3`);
        fs.writeFileSync(tempMp3, response.data);
        
        await sock.sendPresenceUpdate('recording', to);
        await delay(2000);
        await sock.sendMessage(to, { audio: { url: tempMp3 }, mimetype: 'audio/mpeg', ptt: true }, { quoted: quotedMsg });
        
        if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3); 
    } catch (err) {
        console.error('Voice generation error:', err.message);
        await sock.sendMessage(to, { text: text }, { quoted: quotedMsg });
    }
}

async function simulateTypingAndSend(sock, to, text, quotedMsg) {
    const typingDelay = Math.max(1000, Math.min(3000, text.split(/\s+/).length * 150)); 
    await sock.sendPresenceUpdate('composing', to);
    await delay(typingDelay);
    await sock.sendMessage(to, { text: text }, quotedMsg ? { quoted: quotedMsg } : {});
}

// ================= 5. الجلسات والاتصال =================
async function connectInstance(phoneNumber, notifyJid = null) {
    const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
    const sessionFolder = path.join(DATA_DIR, `auth_info_${cleanNumber}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({
        auth: state, printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '20.0.04'], logger: pino({ level: 'silent' }),
        keepAliveIntervalMs: 30000, markOnlineOnConnect: true
    });

    activeSocks.set(cleanNumber, sock);

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectInstance(cleanNumber);
        } else if (connection === 'open') {
            if (!connectedNumbers.includes(cleanNumber)) {
                connectedNumbers.push(cleanNumber); saveJSON('connected_numbers.json', connectedNumbers);
            }
            console.log(`✅ تم فتح اتصال الرقم: ${cleanNumber}`);
        }
        
        if (update.qr) {
            const code = await sock.requestPairingCode(cleanNumber);
            console.log(`🚨 كود الربط للرقم [${cleanNumber}] هو: ${code}`);
            if (notifyJid) {
                for (let [num, s] of activeSocks.entries()) {
                    if (s.authState.creds.registered) {
                        await s.sendMessage(notifyJid, { text: `🔑 *كود الربط للحساب الجديد:* \nالرقم: \`${cleanNumber}\`\nالكود: *${code}*` });
                        break;
                    }
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0]; if (!msg.message || msg.key.remoteJid === 'status@broadcast') return; 

        const rawSender = msg.key.remoteJid;
        const senderNumber = rawSender.split('@')[0].replace(/[^0-9]/g, ''); 
        const isAdmin = adminNumbers.includes(senderNumber);
        const sender = rawSender.includes(':') ? rawSender.split(':')[0] + '@s.whatsapp.net' : rawSender;
        const isFromMe = msg.key.fromMe;
        const isGroup = rawSender.endsWith('@g.us'); 
        
        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const rawPrompt = incomingText.trim();

        if (rawPrompt === 'تفعيل المشرف' && !isAdmin) {
            adminNumbers.push(senderNumber); saveJSON('admins.json', adminNumbers);
            await sock.sendMessage(sender, { text: '✅ تم تسجيلك كمسؤول بنجاح! أرسل (المدير) لفتح لوحة التحكم.' });
            return;
        }

        if (isFromMe && !isGroup) {
            const lastQuestion = lastUserQuestion.get(sender);
            if (lastQuestion && rawPrompt) { learnManualQA(lastQuestion, rawPrompt); lastUserQuestion.delete(sender); }
            return;
        }

        if (!isGroup && !isFromMe) { 
            if (!knownChats.includes(sender)) { knownChats.push(sender); saveJSON('known_chats.json', knownChats); }
            lastUserQuestion.set(sender, rawPrompt); 
        }

        if (isAdmin && !isGroup) {
            // --- لوحة التحكم ---
            if (['المدير', 'تحكم', 'التحكم', 'لوحة التحكم'].includes(rawPrompt)) {
                const menu = `🛠️ *لوحة التحكم المتقدمة* 🛠️\n\n*الحالة:* ${isBotActive ? '✅ يعمل' : '❌ متوقف'}\n*التعلم:* ${selfLearnEnabled ? '🔄 مفعل' : '⏸️ متوقف'}\n*الردود:* ${learnedQA.length}\n*البوتات:* ${connectedNumbers.length}\n\n*الأوامر:*\n1: تشغيل | 2: إيقاف\n3: تفعيل التعلم | 4: إيقاف التعلم\n5: تصفير الذاكرة\n\nاضافة [الرقم] | حذف رقم [الرقم]\nاضافة مشرف [الرقم] | حذف مشرف [الرقم]\nعرض الأرقام | عرض المشرفين | عرض الردود\nعلمني [سؤال]|[جواب] | انسى [كلمة]\nاذاعة [رسالة]`;
                await sock.sendMessage(sender, { text: menu }); return;
            }
            if (rawPrompt === '1') { isBotActive = true; await sock.sendMessage(sender, { text: '✅ تم التشغيل' }); return; }
            if (rawPrompt === '2') { isBotActive = false; await sock.sendMessage(sender, { text: '❌ تم الإيقاف' }); return; }
            if (rawPrompt === '3') { selfLearnEnabled = true; await sock.sendMessage(sender, { text: '🔄 التعلم مفعل' }); return; }
            if (rawPrompt === '4') { selfLearnEnabled = false; await sock.sendMessage(sender, { text: '⏸️ التعلم متوقف' }); return; }
            if (rawPrompt === '5') { learnedQA = []; saveJSON('learned_qa.json', []); await sock.sendMessage(sender, { text: '🗑️ تم تصفير الذاكرة' }); return; }
            
            if (rawPrompt.startsWith('اضافة ')) { connectInstance(rawPrompt.replace('اضافة ', '').replace(/[^0-9]/g, ''), sender); return; }
            if (rawPrompt.startsWith('حذف رقم ')) {
                const num = rawPrompt.replace('حذف رقم ', '').replace(/[^0-9]/g, '');
                connectedNumbers = connectedNumbers.filter(n => n !== num); saveJSON('connected_numbers.json', connectedNumbers);
                if (activeSocks.has(num)) { activeSocks.get(num).end(); activeSocks.delete(num); }
                await sock.sendMessage(sender, { text: `✅ تم حذف الرقم ${num}` }); return;
            }
            if (rawPrompt.startsWith('اذاعة ')) {
                const msgText = rawPrompt.replace('اذاعة ', '').trim();
                let count = 0;
                for (const chat of knownChats) {
                    try { await delay(3000); await sock.sendMessage(chat, { text: msgText }); count++; } catch (e) {}
                }
                await sock.sendMessage(sender, { text: `📢 تم الإرسال إلى ${count} دردشة.` }); return;
            }
            if (rawPrompt.startsWith('علمني ')) {
                const parts = rawPrompt.replace('علمني ', '').split('|');
                if (parts.length === 2) {
                    customReplies = customReplies.filter(r => r.trigger !== parts[0].trim());
                    customReplies.push({ trigger: parts[0].trim(), reply: parts[1].trim() });
                    saveJSON('custom_replies.json', customReplies);
                    await sock.sendMessage(sender, { text: '✅ تم الحفظ' });
                }
                return;
            }
            if (rawPrompt.startsWith('انسى ')) {
                const trigger = rawPrompt.replace('انسى ', '').trim();
                customReplies = customReplies.filter(r => r.trigger !== trigger);
                saveJSON('custom_replies.json', customReplies);
                await sock.sendMessage(sender, { text: '🗑️ تم المسح' }); return;
            }
            if (rawPrompt === 'عرض الردود') {
                const text = customReplies.map(r => `• *${r.trigger}:* ${r.reply}`).join('\n') || 'لا توجد ردود.';
                await sock.sendMessage(sender, { text: `*الردود المخصصة:*\n${text}` }); return;
            }
        }

        // --- معالجة الرسائل للمستخدمين ---
        if (isFromMe || (!isBotActive && !isAdmin)) return; 

        if (isGroup) {
            const botId = cleanNumber + '@s.whatsapp.net';
            const isMentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.includes(botId) || rawPrompt.includes('@' + cleanNumber);
            const isReplyToMe = msg.message.extendedTextMessage?.contextInfo?.participant === botId;
            if (!isMentioned && !isReplyToMe) return;
        }

        const finalPrompt = isGroup ? rawPrompt.replace(/@\d+\s*/g, '').trim() : rawPrompt;
        if (!finalPrompt || finalPrompt.length < 2) return;

        try {
            if (!isGroup) await sock.readMessages([msg.key]);

            // 1. ردود مخصصة
            const custom = customReplies.find(r => finalPrompt.includes(r.trigger));
            if (custom) { await simulateTypingAndSend(sock, sender, custom.reply, isGroup ? msg : null); return; }

            // 2. ردود متعلمة
            const learned = checkLearnedQA(finalPrompt);
            if (learned) { await simulateTypingAndSend(sock, sender, learned, isGroup ? msg : null); return; }

            // 3. ذكاء اصطناعي
            if (!isAdmin) await delay(5000 + Math.random() * 5000); // تأخير طبيعي
            const aiReply = await executeGroqAI(sender, finalPrompt);
            
            const wantsVoice = ['صوت', 'تكلم', 'اسمعني', 'غني'].some(h => finalPrompt.includes(h));
            if (wantsVoice && !isGroup) {
                await generateAndSendVoice(sock, sender, aiReply, msg);
            } else {
                await simulateTypingAndSend(sock, sender, aiReply, isGroup ? msg : null);
            }
        } catch (error) {
            console.error('Error handling message:', error.message);
        }
    });
}

async function init() {
    if (connectedNumbers.length === 0) connectedNumbers.push('584267454399');
    for (const num of connectedNumbers) {
        console.log(`⏳ جاري تشغيل البوت للرقم: ${num}`);
        await connectInstance(num, adminNumbers[0] + '@s.whatsapp.net');
        await delay(5000);
    }
}
init();
