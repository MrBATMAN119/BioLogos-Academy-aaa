
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration, LiveServerMessage } from '@google/genai';
import { SYSTEM_INSTRUCTION, ICON_MIC, CALENDAR_ID, ICON_STOP } from './constants';
import { createBlob, decode, decodeAudioData } from './services/audioUtils';
import { Transcription, CalendarEvent } from './types';

const App: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const audioCtxRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const transcriptionBufferRef = useRef({ input: '', output: '' });
  const scrollRef = useRef<HTMLDivElement>(null);

  const initAudio = async () => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = {
        input: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 }),
        output: new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 }),
      };
    }
    if (audioCtxRef.current.input.state === 'suspended') await audioCtxRef.current.input.resume();
    if (audioCtxRef.current.output.state === 'suspended') await audioCtxRef.current.output.resume();
    return audioCtxRef.current;
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [transcriptions]);

  const toggleConnection = async () => {
    if (isConnected) {
      if (sessionRef.current) {
        sessionRef.current.close();
      }
      setIsConnected(false);
      return;
    }

    try {
      setIsConnecting(true);
      setError(null);
      const { input: inputCtx, output: outputCtx } = await initAudio();
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      const calendarTool: FunctionDeclaration = {
        name: 'schedule_bible_event',
        parameters: {
          type: Type.OBJECT,
          description: `Strictly schedule a study or prayer session on the Google Calendar ID: ${CALENDAR_ID}`,
          properties: {
            summary: { type: Type.STRING, description: 'Title of the study or event' },
            description: { type: Type.STRING, description: 'Notes or verse references' },
            startTime: { type: Type.STRING, description: 'Start time in ISO 8601 format' },
            endTime: { type: Type.STRING, description: 'End time in ISO 8601 format' },
          },
          required: ['summary', 'startTime', 'endTime'],
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsConnected(true);
            setIsConnecting(false);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const base64Audio = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (msg.serverContent?.inputTranscription) {
              transcriptionBufferRef.current.input += msg.serverContent.inputTranscription.text;
            }
            if (msg.serverContent?.outputTranscription) {
              transcriptionBufferRef.current.output += msg.serverContent.outputTranscription.text;
            }
            
            if (msg.serverContent?.turnComplete) {
              const userText = transcriptionBufferRef.current.input.trim();
              const modelText = transcriptionBufferRef.current.output.trim();
              
              if (userText || modelText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(userText ? [{ text: userText, type: 'user' as const, timestamp: Date.now() }] : []),
                  ...(modelText ? [{ text: modelText, type: 'model' as const, timestamp: Date.now() }] : [])
                ]);
              }
              transcriptionBufferRef.current = { input: '', output: '' };
            }

            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'schedule_bible_event') {
                  const eventData = fc.args as any;
                  setEvents(prev => [...prev, eventData]);
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: fc.name,
                      response: { result: `Event "${eventData.summary}" scheduled exclusively on calendar ${CALENDAR_ID}` },
                    }]
                  }));
                }
              }
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setError("Connectivity issue. Ensure your microphone is enabled and try again.");
            setIsConnected(false);
          },
          onclose: () => setIsConnected(false)
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [calendarTool] }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setError("Failed to start session. Please check browser permissions.");
      setIsConnecting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-5xl flex flex-col sm:flex-row items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <span className="text-indigo-600">Torah</span> Voice Guide
          </h1>
          <p className="text-slate-500 font-medium italic mt-1">Exploring the Hebraic Roots of the Word</p>
        </div>
        <div className="flex items-center gap-4 bg-white px-5 py-2 rounded-full shadow-sm border border-slate-200">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500 animate-pulse shadow-[0_0_8px_#22c55e]' : 'bg-slate-300'}`} />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            {isConnected ? 'Live Connection' : isConnecting ? 'Establishing...' : 'Offline'}
          </span>
        </div>
      </header>

      <main className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1 pb-32">
        {/* Chat / Transcription Column */}
        <div className="lg:col-span-8 bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-200 flex flex-col overflow-hidden transition-all">
          <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 backdrop-blur-sm">
            <h2 className="font-bold text-slate-800 text-lg flex items-center gap-2">
              Biblical Inquiry
            </h2>
            {isConnected && (
              <div className="audio-wave">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="wave-bar" style={{ height: `${Math.random() * 20 + 5}px`, animation: 'wave 1s infinite', animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
            )}
          </div>
          
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 scroll-smooth bg-[url('https://www.transparenttextures.com/patterns/linen.png')]">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-12">
                <div className="mb-6 p-6 bg-indigo-50 rounded-full text-indigo-200">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 21a9 9 0 1 0-9-9 9 9 0 0 0 9 9z"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
                </div>
                <p className="text-lg font-medium">Ask about the Sabbath, the Law, or Paul's letters.</p>
                <p className="text-sm mt-2">Speak naturally to your assistant.</p>
              </div>
            ) : (
              transcriptions.map((t, idx) => (
                <div key={idx} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`group relative max-w-[90%] rounded-2xl px-5 py-4 ${
                    t.type === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none shadow-indigo-100' 
                      : 'bg-white text-slate-800 rounded-tl-none border border-slate-100 shadow-sm'
                  } shadow-md`}>
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">{t.text}</p>
                    <div className={`mt-2 flex items-center gap-2 opacity-40 text-[10px] ${t.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <span>{new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {t.type === 'model' && <span className="font-bold border px-1 rounded border-slate-300">ASSISTANT</span>}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Sidebar: Theology Guide only */}
        <div className="lg:col-span-4 space-y-8">
          <div className="bg-slate-900 rounded-3xl p-6 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
            </div>
            <h3 className="font-black text-lg mb-4 flex items-center gap-2">
              <span className="w-2 h-6 bg-indigo-500 rounded-full"></span>
              Theology Guide
            </h3>
            <ul className="text-xs space-y-4 font-medium text-slate-300">
              <li className="flex gap-3">
                <span className="text-indigo-400">01</span>
                <span>The Law (Torah) is eternal and valid for all believers today.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-indigo-400">02</span>
                <span>The 7th-day Sabbath is the sign of the everlasting covenant.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-indigo-400">03</span>
                <span>Paul's writings confirm the Law when properly understood.</span>
              </li>
            </ul>
          </div>
        </div>
      </main>

      {/* Floating Control Bar */}
      <footer className="fixed bottom-0 left-0 right-0 p-6 flex justify-center z-50 pointer-events-none">
        <div className="bg-white/90 backdrop-blur-xl px-8 py-5 rounded-full shadow-[0_20px_50px_rgba(0,0,0,0.15)] border border-white/50 flex items-center gap-8 pointer-events-auto transition-transform hover:scale-[1.02]">
          <button
            onClick={toggleConnection}
            disabled={isConnecting}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all transform active:scale-90 ${
              isConnected 
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-xl shadow-red-200' 
                : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-xl shadow-indigo-200'
            }`}
          >
            {isConnecting ? (
              <svg className="animate-spin h-10 w-10 text-white" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg>
            ) : isConnected ? (
              ICON_STOP
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
            )}
          </button>
          
          <div className="hidden sm:block">
            <p className="text-base font-black text-slate-900 leading-tight">
              {isConnected ? 'Listening to your voice...' : isConnecting ? 'Connecting to sources...' : 'Start a Voice Study'}
            </p>
            <p className="text-xs font-bold text-indigo-500/70 uppercase tracking-widest mt-1">
              {isConnected ? 'Speak now' : 'Torah-Observant Perspective'}
            </p>
          </div>
        </div>
      </footer>

      {error && (
        <div className="fixed top-8 left-1/2 transform -translate-x-1/2 bg-slate-900 text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-bounce z-[100]">
          <span className="text-sm font-bold">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-white/10 rounded">×</button>
        </div>
      )}

      <style>{`
        @keyframes wave {
          0%, 100% { transform: scaleY(1); opacity: 0.5; }
          50% { transform: scaleY(2); opacity: 1; }
        }
      `}</style>
    </div>
  );
};

export default App;
