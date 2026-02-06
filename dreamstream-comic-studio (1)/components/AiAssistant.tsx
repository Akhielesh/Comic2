import React, { useState, useEffect, useRef } from 'react';
import { Send, Bot, Copy, Check } from 'lucide-react';
import { queryStoryAssistant } from '../services/geminiService';
import { ChatMessage } from '../types';
import { MessageCard } from './MessageCard';
import { ResizablePanel } from './ResizablePanel';

interface AiAssistantProps {
  script: string;
}

export const AiAssistant: React.FC<AiAssistantProps> = ({ script }) => {
  const createMessage = (role: ChatMessage['role'], text: string): ChatMessage => ({
    id: crypto.randomUUID(),
    role,
    text,
    timestamp: Date.now()
  });
  const [messages, setMessages] = useState<ChatMessage[]>([
    createMessage('model', "Hi! I'm the Assistant for this comic. Ask me anything about the story, characters, or hidden details!")
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);


  const handleSend = async () => {
    if (!input.trim()) return;
    
    const userMsg: ChatMessage = createMessage('user', input);
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const history = [...messages, userMsg].map(m => ({ role: m.role, text: m.text }));
      const text = await queryStoryAssistant(script, userMsg.text, history);
      const safeText = text || "I couldn't find an answer to that in the script.";
      setMessages(prev => [...prev, createMessage('model', safeText)]);
    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, createMessage('model', "Oops, I had trouble reading the script right now.")]);
    } finally {
      setIsTyping(false);
    }
  };

  const formatTime = (timestamp: number) =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));

  const handleCopy = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.text);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <ResizablePanel
      storageKey="dreamstream.storyAssistant.size"
      defaultSize={{ width: 360, height: 520 }}
      minSize={{ width: 280, height: 360 }}
      className="bg-white border-l-4 border-black overflow-hidden"
    >
    <div className="flex flex-col h-full bg-white">
      <div className="p-4 bg-brand-yellow border-b-4 border-black flex items-center gap-2">
        <Bot className="w-6 h-6" />
        <h3 className="font-display text-xl">Story Assistant</h3>
      </div>
      
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 bg-slate-50 custom-scrollbar">
        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] p-3 rounded-lg text-sm font-medium border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] ${
              msg.role === 'user' ? 'bg-white text-black rounded-tr-none' : 'bg-brand-blue text-white rounded-tl-none'
            }`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[10px] font-bold uppercase opacity-70">
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </div>
                <button
                  onClick={() => handleCopy(msg)}
                  className="text-[10px] font-bold uppercase flex items-center gap-1 opacity-70 hover:opacity-100"
                >
                  {copiedId === msg.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copiedId === msg.id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <MessageCard text={msg.text} />
              <div className="mt-2 text-[10px] font-mono opacity-60">{formatTime(msg.timestamp)}</div>
            </div>
          </div>
        ))}
        {isTyping && (
             <div className="flex justify-start">
                <div className="bg-brand-blue text-white p-3 rounded-lg rounded-tl-none border-2 border-black text-xs font-bold animate-pulse">
                    Thinking...
                </div>
             </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="mt-auto p-4 border-t-4 border-black bg-white">
        <div className="flex gap-2">
          <input 
            type="text" 
            value={input} 
            onChange={(e) => setInput(e.target.value)} 
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Ask about the story..."
            className="flex-1 border-2 border-black rounded-lg px-3 py-2 text-sm focus:shadow-comic focus:outline-none transition-all"
          />
          <button onClick={handleSend} disabled={!input.trim() || isTyping} className="bg-black text-white p-2 rounded-lg hover:bg-brand-yellow hover:text-black transition-colors">
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
    </ResizablePanel>
  );
};
