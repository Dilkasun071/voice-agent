require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const axios = require('axios');
const http = require('http');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const N8N_WEBHOOK = 'https://n8n.dotailabs.com/webhook/process-speech';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const VOICE = 'Google.en-US-Journey-F';
const HOST = 'n8n.dotailabs.com';
const ADMIN_EMAIL = process.env.GMAIL_USER || 'dilkasun071@gmail.com';

const sessions = {};

// Send admin notification email
async function sendAdminEmail({ name, service, friendlyDate, friendlyTime, contactType, contactValue, callerNumber }) {
  try {
    await transporter.sendMail({
      from: `"Voice Agent" <${ADMIN_EMAIL}>`,
      to: ADMIN_EMAIL,
      subject: `New Appointment Request - ${name} - ${friendlyDate} at ${friendlyTime}`,
      html: `
        <h2 style="color:#333">New Appointment Request</h2>
        <table style="border-collapse:collapse;width:100%;font-family:sans-serif;max-width:500px">
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Name</td><td style="padding:8px;border:1px solid #ddd">${name}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Service</td><td style="padding:8px;border:1px solid #ddd">${service}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Date</td><td style="padding:8px;border:1px solid #ddd">${friendlyDate}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Time</td><td style="padding:8px;border:1px solid #ddd">${friendlyTime}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Contact Preference</td><td style="padding:8px;border:1px solid #ddd">${contactType}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">${contactType === 'email' ? 'Email' : 'Phone'}</td><td style="padding:8px;border:1px solid #ddd">${contactValue}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;background:#f9f9f9">Caller Number</td><td style="padding:8px;border:1px solid #ddd">${callerNumber || 'N/A'}</td></tr>
        </table>
        <br>
        <p style="font-family:sans-serif;color:#555">This appointment request was received via voice call and is awaiting your confirmation.</p>
      `
    });
    console.log('[Email] Admin notification sent to:', ADMIN_EMAIL);
  } catch (err) {
    console.error('[Email Error]', err.message);
  }
}

app.get('/health', (_req, res) => res.send('OK'));

app.post('/inbound-call', (req, res) => {
  const callSid      = req.body.CallSid || '';
  const callerNumber = req.body.From    || '';
  console.log('[Inbound] CallSid:', callSid, 'From:', callerNumber);

  const session = sessions[callSid];
  if (session) console.log('[Inbound] Restoring session:', JSON.stringify(session));

  const step           = session?.step           || 'ask_service';
  const service        = session?.service        || '';
  const name           = session?.name           || '';
  const date           = session?.date           || '';
  const time           = session?.time           || '';
  const contactType    = session?.contactType    || '';
  const contactValue   = session?.contactValue   || '';
  const availableSlots = session?.availableSlots || '';
  const friendlyDate   = session?.friendlyDate   || '';
  const friendlyTime   = session?.friendlyTime   || '';

  if (!session && callerNumber) {
    sessions[callSid] = {
      step: 'ask_service', service: '', name: '',
      date: '', time: '', contactType: '', contactValue: '',
      availableSlots: '', friendlyDate: '', friendlyTime: '', callerNumber
    };
  }

  const greeting = session
    ? ''
    : `<Say voice="${VOICE}">Hello! Thank you for calling. How can I help you today?</Say>`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greeting}
  <Connect>
    <Stream url="wss://${HOST}/media-stream?step=${encodeURIComponent(step)}&amp;service=${encodeURIComponent(service)}&amp;name=${encodeURIComponent(name)}&amp;date=${encodeURIComponent(date)}&amp;time=${encodeURIComponent(time)}&amp;contactType=${encodeURIComponent(contactType)}&amp;contactValue=${encodeURIComponent(contactValue)}&amp;availableSlots=${encodeURIComponent(availableSlots)}&amp;friendlyDate=${encodeURIComponent(friendlyDate)}&amp;friendlyTime=${encodeURIComponent(friendlyTime)}&amp;callerNumber=${encodeURIComponent(callerNumber)}&amp;callSid=${encodeURIComponent(callSid)}"/>
  </Connect>
</Response>`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws, req) => {
  const urlParams      = new URLSearchParams(req.url.split('?')[1] || '');
  let step           = urlParams.get('step')           || 'ask_service';
  let service        = urlParams.get('service')        || '';
  let name           = urlParams.get('name')           || '';
  let date           = urlParams.get('date')           || '';
  let time           = urlParams.get('time')           || '';
  let contactType    = urlParams.get('contactType')    || '';
  let contactValue   = urlParams.get('contactValue')   || '';
  let availableSlots = urlParams.get('availableSlots') || '';
  let friendlyDate   = urlParams.get('friendlyDate')   || '';
  let friendlyTime   = urlParams.get('friendlyTime')   || '';
  let callerNumber   = urlParams.get('callerNumber')   || '';
  let callSid        = urlParams.get('callSid')        || '';

  let utteranceBuffer    = '';
  let lastInterim        = '';
  let isProcessing       = false;
  let silenceTimer       = null;
  let agentSpeakingTimer = null;
  let audioChunkCount    = 0;
  let twilioUpdated      = false;
  let dgReady            = false;
  let audioQueue         = [];
  let agentSpeaking      = false;

  console.log(`[WS] New connection step=${step} service="${service}" name="${name}" date="${date}" time="${time}"`);

  const dgWs = new WebSocket(
    `wss://api.deepgram.com/v1/listen?` +
    `model=nova-2&language=en-US` +
    `&interim_results=true` +
    `&vad_events=true&encoding=mulaw&sample_rate=8000`,
    { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
  );

  dgWs.on('open', () => {
    console.log('[Deepgram] Connected');
    dgReady = true;
    setTimeout(() => {
      if (audioQueue.length > 0) {
        console.log(`[Deepgram] Flushing ${audioQueue.length} buffered chunks`);
        audioQueue.forEach(chunk => {
          if (dgWs.readyState === WebSocket.OPEN) dgWs.send(chunk);
        });
        audioQueue = [];
      }
    }, 500);
  });

  dgWs.on('error', err => console.error('[Deepgram Error]', err.message));
  dgWs.on('close', code => {
    console.log('[Deepgram] Closed code:', code);
    dgReady = false;
  });

  async function process(speech) {
    console.log(`[Process START] isProcessing=${isProcessing} agentSpeaking=${agentSpeaking} speech="${speech}"`);
    if (isProcessing || !speech.trim()) {
      console.log(`[Process SKIPPED] isProcessing=${isProcessing} empty=${!speech.trim()}`);
      return;
    }
    isProcessing = true;
    twilioUpdated = false;
    clearTimeout(silenceTimer);

    // Keep call alive during processing
    try {
      await twilioClient.calls(callSid).update({
        twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="10"/></Response>`
      });
      console.log('[Twilio] Hold sent');
    } catch(e) {
      console.log('[Twilio] Hold failed:', e.message);
    }

    console.log(`[Process] step=${step} speech="${speech}" callSid=${callSid}`);

    try {
      const params = new URLSearchParams();
      params.append('SpeechResult',    speech);
      params.append('CallSid',         callSid);
      params.append('step',            step);
      params.append('service',         service);
      params.append('name',            name);
      params.append('date',            date);
      params.append('time',            time);
      params.append('contactType',     contactType);
      params.append('contactValue',    contactValue);
      params.append('availableSlots',  availableSlots);
      params.append('friendlyDate',    friendlyDate);
      params.append('friendlyTime',    friendlyTime);
      params.append('callerNumber',    callerNumber);

      const { data: result } = await axios.post(N8N_WEBHOOK, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      console.log('[n8n] Response:', JSON.stringify(result));

      if (!result || !result.voiceReply) {
        console.error('[n8n] Empty or invalid response');
        isProcessing = false;
        return;
      }

      const voiceReply = (result.voiceReply || 'One moment, please.')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const isHangup = result.hangup === true || result.status === 'done';

      if (result.nextStep        !== undefined) step           = result.nextStep;
      if (result.service         !== undefined) service        = result.service;
      if (result.name            !== undefined) name           = result.name;
      if (result.date            !== undefined) date           = result.date;
      if (result.time            !== undefined) time           = result.time;
      if (result.contactType     !== undefined) contactType    = result.contactType;
      if (result.contactValue    !== undefined) contactValue   = result.contactValue;
      if (result.availableSlots  !== undefined) availableSlots = result.availableSlots;
      if (result.friendlyDate    !== undefined) friendlyDate   = result.friendlyDate;
      if (result.friendlyTime    !== undefined) friendlyTime   = result.friendlyTime;

      // Send admin email when booking is done
      if (isHangup && result.status === 'done') {
        const dec = s => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };
        await sendAdminEmail({
          name:         dec(name),
          service:      dec(service),
          friendlyDate: friendlyDate || date,
          friendlyTime: friendlyTime || time,
          contactType:  dec(contactType),
          contactValue: dec(contactValue),
          callerNumber
        });
      }

      if (callSid) {
        sessions[callSid] = { step, service, name, date, time, contactType, contactValue, availableSlots, friendlyDate, friendlyTime, callerNumber };
        console.log('[Session] Saved:', JSON.stringify(sessions[callSid]));
      }

      const streamUrl = `wss://${HOST}/media-stream?step=${encodeURIComponent(step)}&amp;service=${encodeURIComponent(service)}&amp;name=${encodeURIComponent(name)}&amp;date=${encodeURIComponent(date)}&amp;time=${encodeURIComponent(time)}&amp;contactType=${encodeURIComponent(contactType)}&amp;contactValue=${encodeURIComponent(contactValue)}&amp;availableSlots=${encodeURIComponent(availableSlots)}&amp;friendlyDate=${encodeURIComponent(friendlyDate)}&amp;friendlyTime=${encodeURIComponent(friendlyTime)}&amp;callerNumber=${encodeURIComponent(callerNumber)}&amp;callSid=${encodeURIComponent(callSid)}`;

      const twiml = isHangup
        ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">${voiceReply}</Say><Hangup/></Response>`
        : `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">${voiceReply}</Say><Connect><Stream url="${streamUrl}"/></Connect></Response>`;

      console.log('[TwiML]', twiml);

      console.log(`[Twilio] Updating call ${callSid}`);
      await twilioClient.calls(callSid).update({ twiml });
      twilioUpdated = true;
      console.log(`[Twilio] Update successful hangup=${isHangup}`);

      const charCount = (result.voiceReply || '').length;
      const speakDuration = Math.max(4000, (charCount / 12) * 1000 + 2500);
      console.log(`[Agent] Speaking for ~${Math.round(speakDuration/1000)}s (${charCount} chars)`);
      agentSpeaking = true;
      utteranceBuffer = '';
      lastInterim = '';
      clearTimeout(agentSpeakingTimer);
      agentSpeakingTimer = setTimeout(() => {
        agentSpeaking = false;
        utteranceBuffer = '';
        lastInterim = '';
        console.log('[Agent] Done speaking — ready for caller input');
      }, speakDuration);

      if (isHangup && sessions[callSid]) {
        delete sessions[callSid];
        console.log('[Session] Cleared for:', callSid);
      }

    } catch (err) {
      console.error('[Process Error]', err.response?.data || err.message);
    } finally {
      isProcessing = false;
    }
  }

  dgWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type !== 'Results') {
        console.log('[DG Event]', msg.type);
      }

      if (msg.type === 'Results') {
        const transcript  = msg.channel?.alternatives?.[0]?.transcript || '';
        const isFinal     = msg.is_final;
        const speechFinal = msg.speech_final;

        if (transcript) {
          console.log(`[STT] agentSpeaking=${agentSpeaking} final=${isFinal} speech_final=${speechFinal} text="${transcript}"`);
        }

        if (agentSpeaking) {
          utteranceBuffer = '';
          return;
        }

        if (transcript) lastInterim = transcript;

        if (isFinal && transcript) {
          utteranceBuffer += ' ' + transcript;
          lastInterim = '';
          clearTimeout(silenceTimer);
          silenceTimer = setTimeout(async () => {
            const speech = utteranceBuffer.trim();
            utteranceBuffer = '';
            if (speech && !isProcessing && !agentSpeaking) {
              console.log('[Silence] Fallback:', speech);
              await process(speech);
            }
          }, 800);
        }

        if (speechFinal && !isProcessing && !agentSpeaking) {
          const speech = utteranceBuffer.trim() || lastInterim.trim();
          if (speech) {
            if (step === 'ask_datetime' || step === 'ask_datetime_retry') {
              clearTimeout(silenceTimer);
              silenceTimer = setTimeout(async () => {
                const s = utteranceBuffer.trim() || lastInterim.trim();
                utteranceBuffer = '';
                lastInterim = '';
                if (s && !isProcessing && !agentSpeaking) {
                  console.log('[DateTime] Processing after wait:', s);
                  await process(s);
                }
              }, 1200);
            } else {
              utteranceBuffer = '';
              lastInterim = '';
              clearTimeout(silenceTimer);
              console.log('[speech_final] Processing:', speech);
              await process(speech);
            }
          }
        }
      }

      if (msg.type === 'UtteranceEnd' && !isProcessing && !agentSpeaking) {
        const pending = utteranceBuffer.trim() || lastInterim.trim();
        console.log(`[UtteranceEnd] pending="${pending}"`);
        if (pending) {
          utteranceBuffer = '';
          lastInterim = '';
          clearTimeout(silenceTimer);
          console.log('[UtteranceEnd] Processing:', pending);
          await process(pending);
        }
      }

      if (msg.type === 'SpeechStarted') {
        if (!agentSpeaking) {
          console.log('[DG] SpeechStarted — caller speaking');
          clearTimeout(silenceTimer);
        } else {
          console.log('[DG] SpeechStarted — agent speaking (ignored)');
        }
      }

    } catch (e) {
      console.error('[DG Parse Error]', e.message);
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.event) {
        case 'start':
          if (!callSid) callSid = data.start.callSid;
          console.log('[Stream] Started callSid:', data.start.callSid, 'step:', step);

          if (sessions[callSid] && step === 'ask_service' && sessions[callSid].step !== 'ask_service') {
            const s = sessions[callSid];
            step           = s.step;
            service        = s.service;
            name           = s.name;
            date           = s.date;
            time           = s.time           || '';
            contactType    = s.contactType    || '';
            contactValue   = s.contactValue   || '';
            availableSlots = s.availableSlots || '';
            friendlyDate   = s.friendlyDate   || '';
            friendlyTime   = s.friendlyTime   || '';
            callerNumber   = s.callerNumber   || callerNumber;
            console.log('[Session] Restored:', JSON.stringify(s));
          }

          utteranceBuffer = '';
          lastInterim     = '';
          agentSpeaking   = false;
          audioChunkCount = 0;
          console.log('[Agent] Ready for caller input — step:', step);
          break;

        case 'media':
          audioChunkCount++;
          if (audioChunkCount % 100 === 0) {
            console.log(`[Audio] Chunks: ${audioChunkCount}`);
          }
          const chunk = Buffer.from(data.media.payload, 'base64');
          if (dgReady && dgWs.readyState === WebSocket.OPEN) {
            dgWs.send(chunk);
          } else {
            audioQueue.push(chunk);
            if (audioQueue.length > 100) audioQueue.shift();
          }
          break;

        case 'stop': {
          const pending = utteranceBuffer.trim() || lastInterim.trim();
          console.log(`[Stop] pending="${pending}" isProcessing=${isProcessing} agentSpeaking=${agentSpeaking} twilioUpdated=${twilioUpdated}`);
          if (pending && !isProcessing && !agentSpeaking) {
            utteranceBuffer = '';
            lastInterim     = '';
            clearTimeout(silenceTimer);
            console.log('[Stop] Force processing:', pending);
            process(pending);
          }
          setTimeout(() => {
            if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
          }, 3000);
          break;
        }
      }
    } catch (e) {
      console.error('[WS Parse Error]', e.message);
    }
  });

  ws.on('close', (code) => {
    console.log('[WS] Closed code:', code);
    clearTimeout(silenceTimer);
    clearTimeout(agentSpeakingTimer);
    setTimeout(() => {
      if (dgWs.readyState === WebSocket.OPEN) dgWs.close();
    }, 3000);
  });

  ws.on('error', err => console.error('[WS Error]', err.message));
});

server.listen(3000, () => {
  console.log('[Server] Running on port 3000');
});
